import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { BrowserTools, ToolContext, ToolOutcome } from '../browserTools'
import type { LlmComplete } from '../../pipeline/Planner'
import type { ChatStreamEvent } from '../../../../shared/types'
import {
  CLAUDE_CODE_BROWSER_TOOL_NAMES,
  CLAUDE_CODE_BROWSER_TOOLS,
  CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME
} from './browserTools'

interface BridgeSession {
  conversationId: string | null
  modelId: string
  requestId: string | null
  browserLlm: LlmComplete
}

interface BridgeRegistration {
  dispose: () => void
  env: Record<string, string>
  mcpConfig: string
}

interface ActiveTransport {
  handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
  close: () => Promise<void>
}

const MCP_PATH = '/mcp'
const GUARDRAIL_GUIDANCE =
  'Use the Gladdis MCP tools for browser work: search, fetch_page, navigate, browse_task, read_page, ' +
  'grep_page, grep_click, grep_type, screenshot, or screenshot_app. ' +
  'Never use native shell/CLI browser commands (google-chrome, chromium, playwright, puppeteer, xdg-open on URLs, ' +
  'curl/wget against localhost:9222) - they bypass Gladdis and the user cannot see them.'

export class ClaudeCodeBridgeServer {
  private server = createServer((req, res) => void this.handle(req, res))
  private sessions = new Map<string, BridgeSession>()
  private sessionIdsByToken = new Map<string, Set<string>>()
  private transports = new Map<string, ActiveTransport>()
  private ready: Promise<void> | null = null
  private port: number | null = null

  constructor(
    private readonly tools: BrowserTools,
    private readonly emit: (event: ChatStreamEvent) => void
  ) {}

  async registerSession(session: BridgeSession): Promise<BridgeRegistration> {
    await this.ensureStarted()
    const token = randomUUID()
    this.sessions.set(token, session)
    return {
      dispose: () => {
        this.sessions.delete(token)
        const sessionIds = this.sessionIdsByToken.get(token)
        this.sessionIdsByToken.delete(token)
        for (const sessionId of sessionIds ?? []) {
          const transport = this.transports.get(sessionId)
          this.transports.delete(sessionId)
          void transport?.close()
        }
      },
      env: {},
      mcpConfig: JSON.stringify({
        mcpServers: {
          [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: {
            type: 'http',
            url: `http://127.0.0.1:${this.port}${MCP_PATH}`,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        }
      })
    }
  }

  async close(): Promise<void> {
    this.sessions.clear()
    this.sessionIdsByToken.clear()
    const transports = [...this.transports.values()]
    this.transports.clear()
    await Promise.allSettled(transports.map((transport) => transport.close()))
    if (this.port === null) return
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.ready = null
    this.port = null
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Claude Code bridge failed to bind a local port'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
    return this.ready
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (requestPath(req) !== MCP_PATH) {
        this.json(res, 404, { error: 'Not found' })
        return
      }

      const sessionId = headerValue(req.headers['mcp-session-id'])
      const transport = sessionId ? this.transports.get(sessionId) : null

      if (transport) {
        await transport.handle(req, res)
        return
      }

      if (req.method !== 'POST') {
        this.json(res, 400, { error: 'Invalid or missing session ID' })
        return
      }

      const body = await readJson(req)
      if (!isInitializeRequest(body)) {
        this.json(res, 400, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided'
          },
          id: null
        })
        return
      }

      const token = bearerToken(req)
      const session = token ? this.authorize(token) : null
      if (!session || !token) {
        this.json(res, 401, { error: 'Unauthorized' })
        return
      }

      const freshTransport = await this.createTransport(token, session)
      await freshTransport.handle(req, res, body)
    } catch (error) {
      this.json(res, 500, {
        ok: false,
        text: error instanceof Error ? error.message : String(error),
        imageBase64: null
      })
    }
  }

  private authorize(token: string): BridgeSession | null {
    if (!token) return null
    for (const [candidate, session] of this.sessions) {
      if (safeEqual(candidate, token)) return session
    }
    return null
  }

  private toolContext(session: BridgeSession): ToolContext {
    const tabsApi = this.tools.tabs as {
      activeTabId?: string | null
      create: (url?: string) => { id: string }
      liveTabId?: (id?: string | null) => string
    }
    const tabId = typeof tabsApi.liveTabId === 'function'
      ? tabsApi.liveTabId()
      : tabsApi.activeTabId || tabsApi.create().id
    return {
      tabId,
      requestId: session.requestId ?? undefined,
      conversationId: session.conversationId,
      llm: session.browserLlm,
      taskId: session.conversationId ?? undefined,
      fullResults: new Map(),
      workspaceRoot: this.tools.getWorkspaceRoot() ?? process.cwd(),
      onProgress: session.requestId
        ? (event) =>
            this.emit({
              requestId: session.requestId!,
              type: 'progress_step',
              ...event
            })
        : undefined
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private async createTransport(token: string, session: BridgeSession): Promise<{
    handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
  }> {
    let transport: StreamableHTTPServerTransport | null = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        const sessionIds = this.sessionIdsByToken.get(token) ?? new Set<string>()
        sessionIds.add(sessionId)
        this.sessionIdsByToken.set(token, sessionIds)
        if (transport) {
          this.transports.set(sessionId, {
            handle: async (req, res, parsedBody) => {
              await transport!.handleRequest(req, res, parsedBody)
            },
            close: () => transport!.close()
          })
        }
      }
    })

    transport.onclose = () => {
      const sessionId = transport?.sessionId
      if (!sessionId) return
      this.transports.delete(sessionId)
      const sessionIds = this.sessionIdsByToken.get(token)
      sessionIds?.delete(sessionId)
      if (sessionIds && sessionIds.size === 0) this.sessionIdsByToken.delete(token)
    }

    const server = this.createMcpServer(session)
    await server.connect(transport)

    return {
      handle: async (req, res, parsedBody) => {
        await transport!.handleRequest(req, res, parsedBody)
      }
    }
  }

  private createMcpServer(session: BridgeSession): Server {
    const server = new Server(
      { name: 'gladdis-browser-tools', version: '1.0.0' },
      { capabilities: { tools: { listChanged: false } } }
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: CLAUDE_CODE_BROWSER_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name
      if (!CLAUDE_CODE_BROWSER_TOOL_NAMES.has(toolName)) {
        return {
          content: [{ type: 'text' as const, text: `Unknown Gladdis tool "${toolName}". ${GUARDRAIL_GUIDANCE}` }],
          isError: true
        }
      }

      const outcome = await this.tools.run(toolName, record(request.params.arguments), this.toolContext(session))
      return {
        content: [
          ...(outcome.text ? [{ type: 'text' as const, text: outcome.text }] : []),
          ...(outcome.imageBase64
            ? [{
                type: 'image' as const,
                data: outcome.imageBase64,
                mimeType: 'image/png'
              }]
            : [])
        ],
        structuredContent: buildStructuredToolResult(toolName, request.params.arguments, outcome),
        isError: outcome.ok === false
      }
    })

    return server
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? '').split('?')[0] || '/'
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function bearerToken(req: IncomingMessage): string | null {
  const raw = headerValue(req.headers.authorization)?.trim()
  if (!raw) return null
  const match = /^Bearer\s+(.+)$/i.exec(raw)
  return match?.[1]?.trim() || null
}

function isInitializeRequest(value: unknown): boolean {
  return record(value).method === 'initialize'
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return null
  return JSON.parse(raw)
}

function buildStructuredToolResult(
  toolName: string,
  args: unknown,
  outcome: ToolOutcome
): Record<string, unknown> {
  return {
    tool: toolName,
    ok: outcome.ok,
    text: outcome.text,
    hasImage: Boolean(outcome.imageBase64),
    arguments: record(args),
    ...(outcome.structuredContent ? { data: outcome.structuredContent } : {})
  }
}
