import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { BrowserTools, ToolContext } from '../browserTools'
import type { LlmComplete } from '../../pipeline/Planner'
import type { ChatStreamEvent } from '../../../../shared/types'

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

export class ClaudeCodeBridgeServer {
  private server = createServer((req, res) => void this.handle(req, res))
  private sessions = new Map<string, BridgeSession>()
  private ready: Promise<void> | null = null
  private port: number | null = null

  constructor(
    private readonly tools: BrowserTools,
    private readonly emit: (event: ChatStreamEvent) => void
  ) {}

  async registerSession(session: BridgeSession, mcpScriptPath: string): Promise<BridgeRegistration> {
    await this.ensureStarted()
    const token = randomUUID()
    this.sessions.set(token, session)
    return {
      dispose: () => {
        this.sessions.delete(token)
      },
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        GLADDIS_CLAUDE_BRIDGE_URL: `http://127.0.0.1:${this.port}`,
        GLADDIS_CLAUDE_BRIDGE_TOKEN: token
      },
      mcpConfig: JSON.stringify({
        mcpServers: {
          gladdis: {
            command: process.execPath,
            args: [mcpScriptPath],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              GLADDIS_CLAUDE_BRIDGE_URL: `http://127.0.0.1:${this.port}`,
              GLADDIS_CLAUDE_BRIDGE_TOKEN: token
            }
          }
        }
      })
    }
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
      if (req.method !== 'POST' || req.url !== '/call') {
        this.json(res, 404, { error: 'Not found' })
        return
      }
      const body = record(await readJson(req))
      const token = typeof body.token === 'string' ? body.token : ''
      const name = typeof body.name === 'string' ? body.name : ''
      const args = record(body.arguments)
      const session = this.authorize(token)
      if (!session) {
        this.json(res, 401, { error: 'Unauthorized' })
        return
      }
      const outcome = await this.tools.run(name, args, this.toolContext(session))
      this.json(res, 200, {
        ok: outcome.ok,
        text: outcome.text,
        imageBase64: outcome.imageBase64 ?? null
      })
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
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
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
