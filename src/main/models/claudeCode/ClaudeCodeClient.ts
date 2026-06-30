import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { ChatRequest, ChatStreamEvent, ClaudeCodeStatus } from '../../../../shared/types'
import { CLAUDE_CODE_BROWSER_TOOL_NAMES } from './browserTools'

const execFileAsync = promisify(execFile)
const CLAUDE_BIN = process.env.GLADDIS_CLAUDE_CODE_BIN || 'claude'
const PROBE_CACHE_TTL_MS = 5000

let activeProbe: Promise<{ installed: boolean; version: string | null }> | null = null
let cachedProbe: { installed: boolean; version: string | null } | null = null
let lastProbeTime = 0

export interface PersistedClaudeCodeSessions {
  get: (conversationId: string) => string | null
  set: (conversationId: string, sessionId: string | null) => void
}

interface ClaudeCodeBridgeRegistration {
  dispose: () => void
  env: Record<string, string>
  mcpConfig: string
}

type CreateClaudeCodeBridgeSession = (args: {
  conversationId: string | null
  modelId: string
  requestId: string | null
}) => Promise<ClaudeCodeBridgeRegistration>

function probeClaudeCodeBinary(): Promise<{ installed: boolean; version: string | null }> {
  const now = Date.now()
  if (cachedProbe && now - lastProbeTime < PROBE_CACHE_TTL_MS) return Promise.resolve(cachedProbe)
  if (activeProbe) return activeProbe
  activeProbe = (async () => {
    try {
      const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], { timeout: 8000 })
      const version = stdout.trim().split(/\s+/).pop() || stdout.trim() || null
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

export class ClaudeCodeClient {
  /** requestId → live child process (for pause/resume) */
  private readonly activeProcesses = new Map<string, import('node:child_process').ChildProcess>()
  /** requestId → pause state */
  private readonly pausedRequests = new Set<string>()
  /** requestId → resume resolver (wakes the paused send() loop) */
  private readonly resumeResolvers = new Map<string, () => void>()

  constructor(
    private readonly emit: (e: ChatStreamEvent) => void,
    private readonly getWorkspaceRoot: () => string | null,
    private readonly sessions: PersistedClaudeCodeSessions,
    private readonly createBridgeSession?: CreateClaudeCodeBridgeSession
  ) {}

  pauseRequest(requestId: string): boolean {
    if (!this.activeProcesses.has(requestId) || this.pausedRequests.has(requestId)) return false
    this.pausedRequests.add(requestId)
    const child = this.activeProcesses.get(requestId)
    child?.kill('SIGTERM')
    return true
  }

  resumeRequest(requestId: string): boolean {
    if (!this.pausedRequests.has(requestId)) return false
    this.pausedRequests.delete(requestId)
    const resolve = this.resumeResolvers.get(requestId)
    if (resolve) {
      this.resumeResolvers.delete(requestId)
      resolve()
    }
    return true
  }

  async status(): Promise<ClaudeCodeStatus> {
    const probe = await probeClaudeCodeBinary()
    if (!probe.installed) {
      return {
        installed: false,
        authenticated: false,
        authMethod: null,
        version: null,
        detail: 'Claude Code CLI not found. Install with `npm i -g @anthropic-ai/claude-code`, then run `claude auth login`.'
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(CLAUDE_BIN, ['auth', 'status', '--text'], {
        timeout: 8000
      })
      const text = `${stdout}\n${stderr}`.trim()
      const authenticated = looksAuthenticated(text)
      return {
        installed: true,
        authenticated,
        authMethod: authenticated ? inferAuthMethod(text) : null,
        version: probe.version,
        detail: authenticated ? null : 'Claude Code is installed but not logged in. Run `claude auth login`.'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        installed: true,
        authenticated: false,
        authMethod: null,
        version: probe.version,
        detail: `Claude Code auth check failed: ${message}`
      }
    }
  }

  async complete(
    modelId: string,
    system: string,
    user: string,
    conversationId?: string | null,
    options: { enableBrowserTools?: boolean } = {}
  ): Promise<{ text: string; usage?: ClaudeUsage }> {
    return this.runTurn({
      modelId,
      system,
      user,
      conversationId: conversationId ?? null,
      requestId: null,
      signal: null,
      enableBrowserTools: options.enableBrowserTools === true
    })
  }

  async send(
    req: ChatRequest,
    signal: AbortSignal,
    system: string,
    user: string
  ): Promise<string> {
    const result = await this.runTurn({
      modelId: req.modelId,
      system,
      user,
      conversationId: req.conversationId ?? null,
      requestId: req.requestId,
      signal,
      enableBrowserTools: true
    })
    return result.text
  }

  private async runTurn(args: {
    modelId: string
    system: string
    user: string
    conversationId: string | null
    requestId: string | null
    signal: AbortSignal | null
    enableBrowserTools: boolean
  }): Promise<{ text: string; usage?: ClaudeUsage }> {
    const probe = await probeClaudeCodeBinary()
    if (!probe.installed) throw new Error('Claude Code CLI not found')

    const workdir = this.getWorkspaceRoot() ?? process.cwd()
    const persistedSessionId = args.conversationId ? this.sessions.get(args.conversationId) : null
    const sessionId = persistedSessionId || randomUUID()
    const cliModel = claudeCliModel(args.modelId)
    const bridge = args.enableBrowserTools && this.createBridgeSession
      ? await this.createBridgeSession({
          conversationId: args.conversationId,
          modelId: args.modelId,
          requestId: args.requestId
        })
      : null
    const baseCliArgs = [
      '--dangerously-skip-permissions',
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--model',
      cliModel,
      '--append-system-prompt',
      args.system
    ]
    if (bridge) {
      baseCliArgs.push(
        '--strict-mcp-config',
        '--mcp-config', bridge.mcpConfig,
        '--allowedTools', 'mcp__gladdis__*'
      )
    }

    const buildCliArgs = (resumeId: string | null): string[] => {
      const a = [...baseCliArgs]
      if (resumeId) a.push('--resume', resumeId)
      else a.push('--session-id', sessionId)
      a.push(args.user)
      return a
    }

    // Pause/resume loop: re-spawn with --resume after each SIGTERM-based pause.
    let accumulatedText = ''
    let accumulatedUsage: ClaudeUsage | undefined
    let currentResumeId = persistedSessionId

    while (true) {
      const runResult = await this.spawnTurn(args, buildCliArgs(currentResumeId), workdir, bridge)
      accumulatedText = runResult.text
      accumulatedUsage = mergeUsage(accumulatedUsage, runResult.usage)

      if (!runResult.pausedForResume || args.signal?.aborted) break

      // Wait for resumeRequest() to call the resolver before re-spawning.
      await new Promise<void>((resolve) => {
        if (!this.pausedRequests.has(args.requestId ?? '')) {
          resolve()
          return
        }
        this.resumeResolvers.set(args.requestId ?? '', resolve)
      })

      if (args.signal?.aborted) break

      // Use the session ID persisted by the just-completed spawn.
      currentResumeId = args.conversationId ? this.sessions.get(args.conversationId) : null
      if (!currentResumeId) break
    }

    bridge?.dispose()
    return { text: accumulatedText, usage: accumulatedUsage }
  }

  private async spawnTurn(
    args: {
      modelId: string
      system: string
      user: string
      conversationId: string | null
      requestId: string | null
      signal: AbortSignal | null
      enableBrowserTools: boolean
    },
    cliArgs: string[],
    workdir: string,
    bridge: ClaudeCodeBridgeRegistration | null
  ): Promise<{ text: string; usage?: ClaudeUsage; pausedForResume: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, cliArgs, {
        cwd: workdir,
        env: bridge ? { ...process.env, ...bridge.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      if (args.requestId) this.activeProcesses.set(args.requestId, child)

      let settled = false
      let collectedText = ''
      let finalText: string | null = null
      let finalUsage: ClaudeUsage | undefined
      let finalError: Error | null = null
      let stderr = ''
      const toolJsonByIndex = new Map<number, string>()
      // Track live tool chips emitted from content_block_start so we don't
      // double-emit from the post-hoc assistant message block.
      const liveChippedIds = new Set<string>()

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (args.requestId) this.activeProcesses.delete(args.requestId)
        args.signal?.removeEventListener('abort', onAbort)
        stdoutRl.close()
        stderrRl.close()
        fn()
      }

      const persistSessionId = (value: unknown): void => {
        if (!args.conversationId || typeof value !== 'string' || !value.trim()) return
        this.sessions.set(args.conversationId, value)
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

        if (msg.type === 'stream_event') {
          const event = msg.event ?? {}
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            const cb = event.content_block
            toolJsonByIndex.set(event.index, '')
            // Emit live tool chip as soon as we know name + id, before args stream in.
            if (args.requestId && typeof cb.id === 'string' && typeof cb.name === 'string') {
              liveChippedIds.add(cb.id)
              this.emit({
                requestId: args.requestId,
                type: 'tool_call',
                tool: formatClaudeToolName(cb.name),
                args: {},
                callId: cb.id
              })
            }
          } else if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            typeof event.index === 'number'
          ) {
            const prior = toolJsonByIndex.get(event.index) ?? ''
            toolJsonByIndex.set(event.index, prior + String(event.delta.partial_json ?? ''))
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const delta = String(event.delta.text ?? '')
            if (!delta) return
            collectedText += delta
            if (args.requestId) this.emit({ requestId: args.requestId, type: 'delta', text: delta })
          }
          return
        }

        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
            // Already live-chipped — skip to avoid duplicate tool_call events.
            if (liveChippedIds.has(block.id)) continue
            const blockArgs = block.input && typeof block.input === 'object'
              ? block.input
              : safeParseJson(blockJsonFor(block, toolJsonByIndex))
            if (args.requestId) {
              this.emit({
                requestId: args.requestId,
                type: 'tool_call',
                tool: formatClaudeToolName(block.name),
                args: blockArgs ?? {},
                callId: block.id
              })
            }
          }
          return
        }

        if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            if (!args.requestId) continue
            this.emit({
              requestId: args.requestId,
              type: 'tool_result',
              callId: block.tool_use_id,
              ok: block.is_error !== true,
              preview: toolResultPreview(block.content, msg.tool_use_result),
              imageDataUrl: toolResultImage(block.content)
            })
          }
          return
        }

        if (msg.type === 'result') {
          persistSessionId(msg.session_id)
          finalText = typeof msg.result === 'string' ? msg.result : collectedText
          if (msg.is_error) {
            finalError = new Error(finalText || msg.api_error_status || 'Claude Code turn failed')
          }
          finalUsage = usageFromResult(msg.usage)
        }
      })

      const stderrRl = createInterface({ input: child.stderr })
      stderrRl.on('line', (line) => {
        stderr += `${line}\n`
        if (process.env.GLADDIS_CLAUDE_CODE_DEBUG) process.stderr.write(`[claude-code] ${line}\n`)
      })

      child.on('error', (error) => {
        finish(() => reject(error))
      })

      child.on('close', (code, signalName) => {
        const aborted = args.signal?.aborted === true
        // Paused via pauseRequest(): SIGTERM was sent, child died with non-zero
        // code, and the request is still in pausedRequests. Resolve cleanly so
        // the outer loop can wait for resumeRequest().
        const paused = args.requestId ? this.pausedRequests.has(args.requestId) : false
        if (paused) {
          const text = finalText ?? collectedText
          finish(() => resolve({ text, usage: finalUsage, pausedForResume: true }))
          return
        }
        if (aborted) {
          finish(() => reject(new Error('Claude Code turn aborted')))
          return
        }
        if (finalError) {
          finish(() => reject(finalError!))
          return
        }
        if (code !== 0) {
          const detail = stderr.trim() || `Claude Code exited with code ${code}${signalName ? ` (${signalName})` : ''}`
          finish(() => reject(new Error(detail)))
          return
        }
        const text = finalText ?? collectedText
        finish(() => resolve({ text, usage: finalUsage, pausedForResume: false }))
      })
    })
  }
}

interface ClaudeUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

function claudeCliModel(modelId: string): string {
  switch (modelId) {
    case 'claude-code-opus':
      return 'opus'
    case 'claude-code-sonnet':
      return 'sonnet'
    case 'claude-code-haiku':
      return 'haiku'
    default:
      return modelId
  }
}

function looksAuthenticated(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    (
      lower.includes('logged in') ||
      lower.includes('authenticated') ||
      lower.includes('active') ||
      lower.includes('login method:')
    ) &&
    !lower.includes('not logged in') &&
    !lower.includes('no active')
  )
}

function inferAuthMethod(text: string): string | null {
  const lower = text.toLowerCase()
  if (lower.includes('claude max account') || lower.includes('max account')) return 'claude-max'
  if (lower.includes('api key')) return 'apikey'
  if (lower.includes('oauth') || lower.includes('logged in')) return 'oauth'
  return 'authenticated'
}

function blockJsonFor(
  block: Record<string, unknown>,
  toolJsonByIndex: Map<number, string>
): string {
  if (typeof block.index === 'number') return toolJsonByIndex.get(block.index) ?? ''
  for (const value of toolJsonByIndex.values()) return value
  return ''
}

function safeParseJson(value: string): unknown {
  if (!value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function formatClaudeToolName(name: unknown): string {
  const tool = typeof name === 'string' ? name : 'tool'
  return CLAUDE_CODE_BROWSER_TOOL_NAMES.has(tool) ? `gladdis.${tool}` : `claude.${tool}`
}

function toolResultPreview(content: unknown, toolUseResult: Record<string, unknown> | null | undefined): string {
  if (toolUseResult) {
    const stdout = typeof toolUseResult.stdout === 'string' ? toolUseResult.stdout.trim() : ''
    const stderr = typeof toolUseResult.stderr === 'string' ? toolUseResult.stderr.trim() : ''
    if (stdout && stderr) return `${stdout}\n${stderr}`.trim()
    if (stdout || stderr) return (stdout || stderr).trim()
  }
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item && typeof (item as any).text === 'string') {
          return (item as any).text
        }
        return JSON.stringify(item)
      })
      .join('\n')
      .trim()
    if (text) return text
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function toolResultImage(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (
      item &&
      typeof item === 'object' &&
      (item as any).type === 'image' &&
      typeof (item as any).data === 'string' &&
      (item as any).data.trim()
    ) {
      return `data:${typeof (item as any).mimeType === 'string' ? (item as any).mimeType : 'image/png'};base64,${(item as any).data}`
    }
  }
  return undefined
}

function usageFromResult(usage: any): ClaudeUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = num(usage.input_tokens)
  const outputTokens = num(usage.output_tokens)
  const cachedInputTokens = num(usage.cache_read_input_tokens)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined
  }
  return { inputTokens, outputTokens, cachedInputTokens }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mergeUsage(a: ClaudeUsage | undefined, b: ClaudeUsage | undefined): ClaudeUsage | undefined {
  if (!a && !b) return undefined
  const add = (x: number | undefined, y: number | undefined): number | undefined =>
    x !== undefined || y !== undefined ? (x ?? 0) + (y ?? 0) : undefined
  return {
    inputTokens: add(a?.inputTokens, b?.inputTokens),
    outputTokens: add(a?.outputTokens, b?.outputTokens),
    cachedInputTokens: add(a?.cachedInputTokens, b?.cachedInputTokens)
  }
}
