import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { ChatRequest, ChatStreamEvent, CursorStatus } from '../../../../shared/types'
import type { BridgeRegistration } from '../claudeCode/ClaudeCodeBridgeServer'
import { CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME } from '../claudeCode/browserTools'
import { formatCursorConversationPrompt } from './cursorPrompt'

const execFileAsync = promisify(execFile)
const CURSOR_BIN = process.env.GLADDIS_CURSOR_BIN || 'agent'
const FAILED_PROBE_RETRY_MS = 5000
const STATUS_CACHE_TTL_MS = 10_000

let activeProbe: Promise<{ installed: boolean; version: string | null }> | null = null
let cachedProbe: { installed: boolean; version: string | null } | null = null
let lastProbeTime = 0
let activeStatus: Promise<CursorStatus> | null = null
let cachedStatus: CursorStatus | null = null
let lastStatusTime = 0
const workspaceMcpLocks = new Map<string, Promise<void>>()
const workspaceMcpFingerprints = new Map<string, string>()

export interface CursorUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

export interface PersistedCursorSessions {
  get: (conversationId: string) => string | null
  set: (conversationId: string, sessionId: string | null) => void
}

type CursorAssistantEventKind = 'stream_delta' | 'tool_boundary_flush' | 'final_flush' | 'unknown'

type CreateCursorBridgeSession = (args: {
  conversationId: string | null
  modelId: string
  requestId: string | null
}) => Promise<BridgeRegistration>

export function probeCursorBinary(): Promise<{ installed: boolean; version: string | null }> {
  const now = Date.now()
  if (cachedProbe?.installed) return Promise.resolve(cachedProbe)
  if (cachedProbe && now - lastProbeTime < FAILED_PROBE_RETRY_MS) return Promise.resolve(cachedProbe)
  if (activeProbe) return activeProbe
  activeProbe = (async () => {
    try {
      const { stdout } = await execFileAsync(CURSOR_BIN, ['--version'], { timeout: 8000 })
      const version = stdout.trim() || null
      const result = { installed: true, version }
      cachedProbe = result
      lastProbeTime = Date.now()
      return result
    } catch {
      const result = { installed: false, version: null }
      cachedProbe = result
      lastProbeTime = Date.now()
      return result
    } finally {
      activeProbe = null
    }
  })()
  return activeProbe
}

export class CursorClient {
  private readonly activeProcesses = new Map<string, import('node:child_process').ChildProcess>()

  constructor(
    private readonly emit: (e: ChatStreamEvent) => void,
    private readonly getWorkspaceRoot: () => string | null,
    private readonly sessions: PersistedCursorSessions,
    private readonly createBridgeSession?: CreateCursorBridgeSession
  ) {}

  pauseRequest(requestId: string): boolean {
    return this.stopRequest(requestId)
  }

  resumeRequest(_requestId: string): boolean {
    return false
  }

  stopRequest(requestId: string): boolean {
    const child = this.activeProcesses.get(requestId)
    if (!child) return false
    child.kill('SIGTERM')
    return true
  }

  async status(): Promise<CursorStatus> {
    const now = Date.now()
    if (cachedStatus && now - lastStatusTime < STATUS_CACHE_TTL_MS) return cachedStatus
    if (activeStatus) return activeStatus
    activeStatus = this.computeStatus()
    try {
      const status = await activeStatus
      cachedStatus = status
      lastStatusTime = Date.now()
      return status
    } finally {
      activeStatus = null
    }
  }

  private async computeStatus(): Promise<CursorStatus> {
    const probe = await probeCursorBinary()
    if (!probe.installed) {
      return {
        installed: false,
        authenticated: false,
        authMethod: null,
        version: null,
        detail: 'Cursor Agent CLI not found. Install it from Cursor, then run agent login.'
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(CURSOR_BIN, ['status'], { timeout: 8000 })
      const text = (stdout + '\n' + stderr).trim()
      const authenticated = /logged in as|signed in as/i.test(text)
      return {
        installed: true,
        authenticated,
        authMethod: authenticated ? 'cursor' : null,
        version: probe.version,
        detail: authenticated ? null : 'Cursor Agent is installed but not logged in. Run agent login.'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        installed: true,
        authenticated: false,
        authMethod: null,
        version: probe.version,
        detail: 'Cursor Agent auth check failed: ' + message
      }
    }
  }

  async complete(
    modelId: string,
    system: string,
    user: string,
    conversationId?: string | null,
    options: { enableBrowserTools?: boolean } = {}
  ): Promise<{ text: string; usage?: CursorUsage }> {
    return this.runTurn({
      modelId,
      system,
      user,
      conversationId: conversationId ?? null,
      requestId: null,
      signal: null,
      mode: 'ask',
      enableBrowserTools: options.enableBrowserTools === true
    })
  }

  async send(
    req: ChatRequest,
    signal: AbortSignal,
    system: string,
    user: string,
    mode: 'ask' | 'agent',
    options: { enableBrowserTools?: boolean } = {}
  ): Promise<{ text: string; usage?: CursorUsage }> {
    return this.runTurn({
      modelId: req.modelId,
      system,
      user: formatCursorConversationPrompt(req.messages, user),
      conversationId: req.conversationId ?? null,
      requestId: req.requestId,
      signal,
      mode,
      enableBrowserTools: options.enableBrowserTools === true
    })
  }

  private async runTurn(args: {
    modelId: string
    system: string
    user: string
    conversationId: string | null
    requestId: string | null
    signal: AbortSignal | null
    mode: 'ask' | 'agent'
    enableBrowserTools: boolean
  }): Promise<{ text: string; usage?: CursorUsage }> {
    const probe = await probeCursorBinary()
    if (!probe.installed) throw new Error('Cursor Agent CLI not found')

    const workdir = this.getWorkspaceRoot() ?? process.cwd()
    const needsMcpBridge = args.enableBrowserTools && !!this.createBridgeSession

    // Register the bridge session outside the lock — the token and URL are stable
    // per workdir (persistTokenKey), so this is idempotent and cheap.
    const bridge = needsMcpBridge
      ? await this.createBridgeSession!({
          conversationId: args.conversationId,
          modelId: args.modelId,
          requestId: args.requestId
        })
      : null

    const runTurn = async (): Promise<{ text: string; usage?: CursorUsage }> => {
      const mcpConfig = bridge ? await ensureWorkspaceMcpConfig(workdir, bridge.mcpConfig) : null
      const prompt = [
        args.system.trim() ? '[System]\n' + args.system.trim() : '',
        '[User]\n' + args.user
      ].filter(Boolean).join('\n\n')
      const cliArgs = [
        '--print',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--model',
        cursorCliModel(args.modelId),
        '--trust',
        '--workspace',
        workdir
      ]
      if (bridge) cliArgs.push('--approve-mcps')
      if (args.mode === 'ask') cliArgs.push('--mode', 'ask')
      else cliArgs.push('--force')
      const persistedSessionId = args.conversationId ? this.sessions.get(args.conversationId) : null
      if (persistedSessionId) cliArgs.push('--resume', persistedSessionId)
      cliArgs.push(prompt)

      try {
        return await new Promise((resolve, reject) => {
          const child = spawn(CURSOR_BIN, cliArgs, {
            cwd: workdir,
            env: bridge ? { ...process.env, ...bridge.env } : process.env,
            stdio: ['ignore', 'pipe', 'pipe']
          })

          if (args.requestId) this.activeProcesses.set(args.requestId, child)

          let settled = false
          let emittedText = ''
          let finalText: string | null = null
          let finalUsage: CursorUsage | undefined
          let stderr = ''

          const persistSessionId = (value: unknown): void => {
            if (!args.conversationId || typeof value !== 'string' || !value.trim()) return
            this.sessions.set(args.conversationId, value)
          }

          const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            if (args.requestId) this.activeProcesses.delete(args.requestId)
            args.signal?.removeEventListener('abort', onAbort)
            stdoutRl.close()
            stderrRl.close()
            fn()
          }

          const emitDelta = (text: string): void => {
            if (!text) return
            let delta = text
            if (text.startsWith(emittedText)) delta = text.slice(emittedText.length)
            if (!delta) return
            emittedText += delta
            if (args.requestId) this.emit({ requestId: args.requestId, type: 'delta', text: delta })
          }

          const onAbort = (): void => {
            child.kill('SIGTERM')
            setTimeout(() => {
              if (child.exitCode === null) child.kill('SIGKILL')
            }, 1500).unref()
          }

          if (args.signal?.aborted) {
            onAbort()
          } else {
            args.signal?.addEventListener('abort', onAbort, { once: true })
          }

          const stdoutRl = createInterface({ input: child.stdout })
          stdoutRl.on('line', (line) => {
            const trimmed = line.trim()
            if (!trimmed) return
            let msg: any
            try {
              msg = JSON.parse(trimmed)
            } catch {
              return
            }

            persistSessionId(msg.session_id)

            if (msg.type === 'tool_call') {
              if (args.requestId && msg.subtype === 'started' && typeof msg.call_id === 'string') {
                this.emit({
                  requestId: args.requestId,
                  type: 'tool_call',
                  tool: formatCursorToolName(msg.tool_call),
                  args: cursorToolArgs(msg.tool_call),
                  callId: msg.call_id
                })
              } else if (args.requestId && msg.subtype === 'completed' && typeof msg.call_id === 'string') {
                this.emit({
                  requestId: args.requestId,
                  type: 'tool_result',
                  callId: msg.call_id,
                  ok: cursorToolOk(msg.tool_call),
                  preview: cursorToolPreview(msg.tool_call)
                })
              }
              return
            }

            if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
              const text = assistantMessageText(msg)
              const kind = classifyAssistantEvent(msg)
              if (shouldEmitAssistantStreamText(kind)) emitDelta(text)
              return
            }

            if (msg.type === 'result') {
              if (typeof msg.result === 'string') {
                finalText = msg.result
                emitDelta(msg.result)
              }
              finalUsage = normalizeUsage(msg.usage)
              if (msg.is_error || msg.subtype === 'error') {
                const message = typeof msg.result === 'string' && msg.result.trim()
                  ? msg.result
                  : 'Cursor Agent returned an error.'
                finish(() => reject(new Error(message)))
              }
            }
          })

          const stderrRl = createInterface({ input: child.stderr })
          stderrRl.on('line', (line) => {
            stderr += line + '\n'
            if (process.env.GLADDIS_CURSOR_DEBUG) process.stderr.write('[cursor] ' + line + '\n')
          })

          child.on('error', (error) => finish(() => reject(error)))
          child.on('close', (code) => {
            if (settled) return
            if (args.signal?.aborted) {
              finish(() => resolve({ text: finalText ?? emittedText, usage: finalUsage }))
              return
            }
            if (code && code !== 0) {
              const message = stderr.trim() || 'Cursor Agent exited with code ' + code
              finish(() => reject(new Error(message)))
              return
            }
            finish(() => resolve({ text: finalText ?? emittedText, usage: finalUsage }))
          })
        })
      } finally {
        await mcpConfig?.dispose()
        bridge?.dispose()
      }
    }

    // Only serialize when we might actually write the MCP config file. On warm
    // turns (fingerprint already cached) the write is skipped, so no lock needed.
    if (bridge && !isMcpConfigWarm(workdir, bridge.mcpConfig)) {
      return withWorkspaceMcpLock(workdir, runTurn)
    }
    return runTurn()
  }
}

/**
 * True when the MCP config for `workdir` is already written and matches the
 * bridge's config — meaning `ensureWorkspaceMcpConfig` will be a no-op and the
 * workspace lock can be skipped entirely.
 */
export function isMcpConfigWarm(workdir: string, mcpConfigJson: string): boolean {
  const bridgeConfig = parseMcpConfig(mcpConfigJson)
  const gladdisEntry = bridgeConfig.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]
  if (!gladdisEntry) return true
  const fingerprint = JSON.stringify(gladdisEntry)
  return workspaceMcpFingerprints.get(workdir) === fingerprint
}

/** Keep a stable Gladdis MCP entry in `.cursor/mcp.json`; write only when it changes. */
export async function ensureWorkspaceMcpConfig(
  workdir: string,
  mcpConfigJson: string
): Promise<{ dispose: () => Promise<void> }> {
  const bridgeConfig = parseMcpConfig(mcpConfigJson)
  const gladdisEntry = bridgeConfig.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]
  const fingerprint = JSON.stringify(gladdisEntry ?? null)
  if (!gladdisEntry) {
    return { dispose: async () => {} }
  }

  const cached = workspaceMcpFingerprints.get(workdir)
  if (cached === fingerprint) {
    return { dispose: async () => {} }
  }

  const file = join(workdir, '.cursor', 'mcp.json')
  let previous: string | null = null
  try {
    previous = await readFile(file, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  const existing = parseMcpConfig(previous)
  const onDiskGladdis = JSON.stringify(existing.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME] ?? null)
  if (previous !== null && onDiskGladdis === fingerprint) {
    workspaceMcpFingerprints.set(workdir, fingerprint)
    return { dispose: async () => {} }
  }

  const merged = mergeMcpConfig(existing, bridgeConfig)

  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  workspaceMcpFingerprints.set(workdir, fingerprint)
  return { dispose: async () => {} }
}

function parseMcpConfig(raw: string | null): { mcpServers: Record<string, any> } {
  if (!raw?.trim()) return { mcpServers: {} }
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, any> }
  return {
    ...parsed,
    mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? parsed.mcpServers
      : {}
  }
}

function mergeMcpConfig(
  base: { mcpServers: Record<string, any> },
  bridge: { mcpServers: Record<string, any> }
): { mcpServers: Record<string, any> } {
  return {
    ...base,
    mcpServers: {
      ...base.mcpServers,
      ...bridge.mcpServers
    }
  }
}

function cursorCliModel(modelId: string): string {
  switch (modelId) {
    case 'composer-2.5':
      return 'composer-2.5'
    default:
      return modelId
  }
}

function normalizeUsage(value: any): CursorUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  return {
    inputTokens: numeric(value.inputTokens),
    outputTokens: numeric(value.outputTokens),
    cachedInputTokens: numeric(value.cacheReadTokens ?? value.cachedInputTokens)
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function assistantMessageText(msg: any): string {
  if (!Array.isArray(msg?.message?.content)) return ''
  return msg.message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('')
}

/**
 * Cursor's `--stream-partial-output` sends duplicate assistant snapshots before
 * tool calls and again right before the terminal `result`. Events with
 * `timestamp_ms` and no `model_call_id` are live deltas; bare snapshots without
 * `timestamp_ms` are final flushes that may carry text not yet streamed.
 * Tool-boundary flushes (with `model_call_id`) stay suppressed — they repeat
 * text already shown right before a tool call.
 */
export function classifyAssistantEvent(msg: any): CursorAssistantEventKind {
  const hasText = assistantMessageText(msg).length > 0
  if (!hasText) return 'unknown'
  const hasTimestamp = typeof msg?.timestamp_ms === 'number'
  const hasModelCallId = typeof msg?.model_call_id === 'string' && msg.model_call_id.trim().length > 0
  if (hasTimestamp && !hasModelCallId) return 'stream_delta'
  if (hasTimestamp && hasModelCallId) return 'tool_boundary_flush'
  if (!hasTimestamp && !hasModelCallId) return 'final_flush'
  return 'unknown'
}

/** True when an assistant snapshot should contribute new streamed chat text. */
export function shouldEmitAssistantStreamText(kind: CursorAssistantEventKind): boolean {
  return kind === 'stream_delta' || kind === 'final_flush'
}

function formatCursorToolName(toolCall: any): string {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const [firstKey, firstValue] = firstCursorToolEntry(payload)
  if (firstKey === 'mcpToolCall') {
    const serverName = typeof firstValue?.serverName === 'string' ? firstValue.serverName.trim() : ''
    const toolName = typeof firstValue?.toolName === 'string' ? firstValue.toolName.trim() : ''
    if (serverName && toolName) return `${serverName}.${toolName}`
    if (toolName) return toolName
  }
  return normalizeCursorToolName(firstKey)
}

function cursorToolArgs(toolCall: any): unknown {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const [, firstValue] = firstCursorToolEntry(payload)
  if (!firstValue || typeof firstValue !== 'object') return {}
  if (firstValue.args && typeof firstValue.args === 'object') return firstValue.args
  if (firstValue.input && typeof firstValue.input === 'object') return firstValue.input
  return {}
}

function cursorToolOk(toolCall: any): boolean {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const [, firstValue] = firstCursorToolEntry(payload)
  if (!firstValue || typeof firstValue !== 'object') return true
  const result = firstValue.result
  if (result == null) return true
  if (typeof result !== 'object') return true
  if ('error' in result && result.error) return false
  if ('success' in result && result.success === false) return false
  if ('ok' in result && result.ok === false) return false
  if ('isError' in result && result.isError === true) return false
  return true
}

function cursorToolPreview(toolCall: any): string {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const [firstKey, firstValue] = firstCursorToolEntry(payload)
  if (!firstValue || typeof firstValue !== 'object') return 'Tool completed.'
  const args = cursorToolArgs(toolCall)
  const description = firstTextValue(firstValue.description)
  const result = firstValue.result
  const resultText = firstNonEmptyText([
    result,
    (result as any)?.success,
    (result as any)?.error,
    (result as any)?.output,
    (result as any)?.content
  ])
  if (resultText) return resultText

  if (description) return description

  if (args && typeof args === 'object') {
    const argPreview = summarizeArgs(args as Record<string, unknown>)
    if (argPreview) return argPreview
  }

  const fallbackName = normalizeCursorToolName(firstKey)
  return fallbackName === 'search_files' ? 'Search completed.' : 'Tool completed.'
}

function firstCursorToolEntry(payload: Record<string, any>): [string, any] {
  const firstKey = Object.keys(payload)[0] ?? ''
  return [firstKey, firstKey ? payload[firstKey] : undefined]
}

function normalizeCursorToolName(key: string): string {
  switch (key) {
    case 'shellToolCall':
      return 'execute_in_browser'
    case 'readToolCall':
    case 'fileReadToolCall':
      return 'read_file'
    case 'editToolCall':
    case 'fileEditToolCall':
      return 'edit_file'
    case 'writeToolCall':
    case 'fileWriteToolCall':
      return 'write_file'
    case 'grepToolCall':
    case 'searchToolCall':
    case 'codebaseSearchToolCall':
      return 'search_files'
    case 'listDirToolCall':
    case 'lsToolCall':
      return 'list_dir'
    case 'runValidationToolCall':
      return 'run_validation'
    case 'mcpToolCall':
      return 'tool'
    default: {
      const base = key.replace(/ToolCall$/, '')
      const snake = base
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .toLowerCase()
        .replace(/^_+|_+$/g, '')
      return snake || 'tool'
    }
  }
}

function firstNonEmptyText(values: unknown[]): string {
  for (const value of values) {
    const text = extractPreviewText(value)
    if (text) return text
  }
  return ''
}

function extractPreviewText(value: unknown, seen = new Set<unknown>()): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (seen.has(value)) return ''
  if (Array.isArray(value)) {
    seen.add(value)
    for (const item of value) {
      const text = extractPreviewText(item, seen)
      if (text) return text
    }
    return ''
  }
  if (typeof value !== 'object') return ''

  seen.add(value)
  const record = value as Record<string, unknown>
  for (const key of ['message', 'stderr', 'stdout', 'output', 'text', 'content', 'description', 'summary', 'title']) {
    const text = extractPreviewText(record[key], seen)
    if (text) return text
  }
  for (const nested of Object.values(record)) {
    const text = extractPreviewText(nested, seen)
    if (text) return text
  }
  return ''
}

function firstTextValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function summarizeArgs(args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  if (path) return path
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (query) return query
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (url) return url
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command) return command
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (text) return text
  const method = typeof args.method === 'string' ? args.method.trim() : ''
  if (method) return method
  return ''
}

async function withWorkspaceMcpLock<T>(workdir: string, task: () => Promise<T>): Promise<T> {
  const prior = workspaceMcpLocks.get(workdir) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = prior.then(() => gate)
  workspaceMcpLocks.set(workdir, current)
  await prior
  try {
    return await task()
  } finally {
    release()
    if (workspaceMcpLocks.get(workdir) === current) workspaceMcpLocks.delete(workdir)
  }
}
