import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { ChatRequest, ChatStreamEvent, CursorStatus } from '../../../../shared/types'
import type { BridgeRegistration } from '../claudeCode/ClaudeCodeBridgeServer'

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
    mode: 'ask' | 'agent'
  ): Promise<{ text: string; usage?: CursorUsage }> {
    return this.runTurn({
      modelId: req.modelId,
      system,
      user,
      conversationId: req.conversationId ?? null,
      requestId: req.requestId,
      signal,
      mode,
      enableBrowserTools: true
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
    return withWorkspaceMcpLock(workdir, async () => {
      const bridge = args.enableBrowserTools && this.createBridgeSession
        ? await this.createBridgeSession({
            conversationId: args.conversationId,
            modelId: args.modelId,
            requestId: args.requestId
          })
        : null
      const mcpConfig = bridge ? await installWorkspaceMcpConfig(workdir, bridge.mcpConfig) : null
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
              if (classifyAssistantEvent(msg) === 'stream_delta') emitDelta(text)
              return
            }

            if (msg.type === 'result') {
              if (typeof msg.result === 'string') {
                finalText = msg.result
                if (!emittedText) emitDelta(msg.result)
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
    })
  }
}

async function installWorkspaceMcpConfig(workdir: string, mcpConfigJson: string): Promise<{ dispose: () => Promise<void> }> {
  const file = join(workdir, '.cursor', 'mcp.json')
  const dir = dirname(file)
  let previous: string | null = null
  let hadCursorDir = true
  try {
    await stat(dir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') hadCursorDir = false
    else throw error
  }
  try {
    previous = await readFile(file, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  const bridgeConfig = parseMcpConfig(mcpConfigJson)
  const nextConfig = mergeMcpConfig(parseMcpConfig(previous), bridgeConfig)
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(nextConfig, null, 2) + '\n', { mode: 0o600 })

  return {
    dispose: async () => {
      if (previous === null) {
        await rm(file, { force: true })
        if (!hadCursorDir) {
          try {
            await rm(dir, { recursive: true, force: true })
          } catch (error: any) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EISDIR') throw error
          }
        }
        return
      }
      await writeFile(file, previous, { mode: 0o600 })
    }
  }
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
 * tool calls and again right before the terminal `result`. Only assistant
 * events with `timestamp_ms` and without `model_call_id` are fresh text.
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

function formatCursorToolName(toolCall: any): string {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  if (payload.mcpToolCall?.serverName && payload.mcpToolCall?.toolName) {
    return `${String(payload.mcpToolCall.serverName)}.${String(payload.mcpToolCall.toolName)}`
  }
  if (payload.shellToolCall) return 'cursor.shell'
  if (payload.fileReadToolCall) return 'cursor.read_file'
  if (payload.fileEditToolCall) return 'cursor.edit_file'
  if (payload.searchToolCall) return 'cursor.search'
  if (payload.listDirToolCall) return 'cursor.list_dir'
  const firstKey = Object.keys(payload)[0]
  return firstKey ? `cursor.${firstKey}` : 'cursor.tool'
}

function cursorToolArgs(toolCall: any): unknown {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const firstValue = Object.values(payload)[0] as any
  if (!firstValue || typeof firstValue !== 'object') return {}
  return firstValue.args && typeof firstValue.args === 'object' ? firstValue.args : {}
}

function cursorToolOk(toolCall: any): boolean {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const firstValue = Object.values(payload)[0] as any
  if (!firstValue || typeof firstValue !== 'object') return true
  const result = firstValue.result
  if (!result || typeof result !== 'object') return true
  return !('error' in result)
}

function cursorToolPreview(toolCall: any): string {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const firstValue = Object.values(payload)[0] as any
  if (!firstValue || typeof firstValue !== 'object') return 'Tool completed.'
  const description = typeof firstValue.description === 'string' ? firstValue.description.trim() : ''
  const result = firstValue.result
  if (result && typeof result === 'object') {
    const success = (result as any).success
    if (success && typeof success === 'object') {
      const stdout = typeof success.stdout === 'string' ? success.stdout.trim() : ''
      const stderr = typeof success.stderr === 'string' ? success.stderr.trim() : ''
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      if (output) return output
    }
    const error = (result as any).error
    if (error && typeof error === 'object') {
      const message = typeof error.message === 'string' ? error.message.trim() : ''
      if (message) return message
    }
  }
  return description || 'Tool completed.'
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
