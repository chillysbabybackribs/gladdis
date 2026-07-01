import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { ChatRequest, ChatStreamEvent, CursorStatus, ModelOption } from '../../../../shared/types'
import type { ChatMessage } from '../../../../shared/chat'
import type { BridgeRegistration } from '../claudeCode/ClaudeCodeBridgeServer'
import { CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME } from '../claudeCode/browserTools'
import { formatCursorConversationPrompt } from './cursorPrompt'

const execFileAsync = promisify(execFile)
const CURSOR_BIN = process.env.GLADDIS_CURSOR_BIN || 'agent'
const FAILED_PROBE_RETRY_MS = 5000
const STATUS_CACHE_TTL_MS = 10_000
const DEFAULT_CURSOR_RESUME_PROMPT = 'Continue from where you left off.'

function cursorDebug(message: string): void {
  if (!process.env.GLADDIS_CURSOR_DEBUG) return
  process.stderr.write(`[cursor] ${message}\n`)
}

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
  allowedToolNames?: ReadonlySet<string>
}) => Promise<BridgeRegistration>

function probeCursorBinary(): Promise<{ installed: boolean; version: string | null }> {
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
  private readonly pausedRequests = new Set<string>()
  private readonly resumeResolvers = new Map<string, () => void>()

  constructor(
    private readonly emit: (e: ChatStreamEvent) => void,
    private readonly getWorkspaceRoot: () => string | null,
    private readonly sessions: PersistedCursorSessions,
    private readonly createBridgeSession?: CreateCursorBridgeSession
  ) {}

  pauseRequest(requestId: string): boolean {
    if (!this.activeProcesses.has(requestId) || this.pausedRequests.has(requestId)) return false
    this.pausedRequests.add(requestId)
    return this.stopRequest(requestId)
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

  /**
   * Live model catalog from `agent models`. Returns [] if Cursor isn't
   * installed/reachable so the caller can fall back to static picker entries.
   */
  async listModels(): Promise<ModelOption[]> {
    const probe = await probeCursorBinary()
    if (!probe.installed) return []
    try {
      const { stdout, stderr } = await execFileAsync(CURSOR_BIN, ['models'], { timeout: 8000 })
      return parseCursorModels(stdout + '\n' + stderr)
    } catch (error) {
      console.warn('[cursor] models failed:', error instanceof Error ? error.message : error)
      return []
    }
  }

  /**
   * Pre-warm the MCP bridge server for an imminent browser-enabled turn.
   * We intentionally dispose the warmup session immediately so later turns
   * always bind browser tool calls to the user's selected model.
   */
  async warmBridge(): Promise<void> {
    if (!this.createBridgeSession) return
    const bridge = await this.createBridgeSession({
      conversationId: null,
      modelId: 'warmup',
      requestId: null
    })
    bridge.dispose()
    cursorDebug(`bridge server warmed for ${this.getWorkspaceRoot() ?? process.cwd()}`)
  }

  /** Clear the warmed bridge, disposing if present. */
  clearWarmedBridge(): void {
    cursorDebug('bridge warm cleared')
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
    options: { enableBrowserTools?: boolean; allowedToolNames?: ReadonlySet<string> } = {}
  ): Promise<{ text: string; usage?: CursorUsage }> {
    return this.runTurn({
      modelId,
      system,
      messages: [{ role: 'user', content: user }],
      latestUserText: user,
      conversationId: conversationId ?? null,
      requestId: null,
      signal: null,
      mode: 'ask',
      enableBrowserTools: options.enableBrowserTools === true,
      allowedToolNames: options.allowedToolNames
    })
  }

  async send(
    req: ChatRequest,
    signal: AbortSignal,
    system: string,
    user: string,
    mode: 'ask' | 'agent',
    options: {
      enableBrowserTools?: boolean
      allowedToolNames?: ReadonlySet<string>
      getQueuedContext?: () => string | null
    } = {}
  ): Promise<{ text: string; usage?: CursorUsage }> {
    return this.runTurn({
      modelId: req.modelId,
      system,
      messages: req.messages,
      latestUserText: user,
      conversationId: req.conversationId ?? null,
      requestId: req.requestId,
      signal,
      mode,
      enableBrowserTools: options.enableBrowserTools === true,
      allowedToolNames: options.allowedToolNames,
      getQueuedContext: options.getQueuedContext
    })
  }

  private async runTurn(args: {
    modelId: string
    system: string
    messages: ChatMessage[]
    latestUserText: string
    conversationId: string | null
    requestId: string | null
    signal: AbortSignal | null
    mode: 'ask' | 'agent'
    enableBrowserTools: boolean
    allowedToolNames?: ReadonlySet<string>
    getQueuedContext?: () => string | null
  }): Promise<{ text: string; usage?: CursorUsage }> {
    const turnStart = Date.now()
    cursorDebug(`turn start requestId=${args.requestId ?? 'none'}`)
    const probe = await probeCursorBinary()
    if (!probe.installed) throw new Error('Cursor Agent CLI not found')

    const workdir = this.getWorkspaceRoot() ?? process.cwd()
    const needsMcpBridge = args.enableBrowserTools && !!this.createBridgeSession

    // Use pre-warmed bridge if available and valid, otherwise create fresh
    let bridge: Awaited<ReturnType<CreateCursorBridgeSession>> | null = null
    if (needsMcpBridge) {
      bridge = await this.createBridgeSession!({
        conversationId: args.conversationId,
        modelId: args.modelId,
        requestId: args.requestId,
        allowedToolNames: args.allowedToolNames
      })
      cursorDebug(`bridge created fresh +${Date.now() - turnStart}ms`)
    }

    const buildUserBody = (resumeId: string | null, userText: string): string => {
      if (resumeId) return userText.trim()
      return formatCursorConversationPrompt(args.messages, userText, {
        includeHistory: true
      })
    }

    const buildPrompt = (resumeId: string | null, userText: string): string => [
      args.system.trim() ? '[System]\n' + args.system.trim() : '',
      '[User]\n' + buildUserBody(resumeId, userText)
    ].filter(Boolean).join('\n\n')

    const buildCliArgs = (resumeId: string | null, userText: string): string[] => {
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
      if (resumeId) cliArgs.push('--resume', resumeId)
      cliArgs.push(buildPrompt(resumeId, userText))
      return cliArgs
    }

    let accumulatedText = ''
    let accumulatedUsage: CursorUsage | undefined
    let currentResumeId = args.conversationId ? this.sessions.get(args.conversationId) : null
    let currentUserText = args.latestUserText

    try {
      while (true) {
        if (bridge) {
          await ensureWorkspaceMcpConfigLocked(workdir, bridge.mcpConfig)
          cursorDebug(`mcp config ready +${Date.now() - turnStart}ms`)
        }

        const runResult = await this.spawnTurn(
          args,
          buildCliArgs(currentResumeId, currentUserText),
          workdir,
          bridge,
          turnStart
        )
        accumulatedText = runResult.text
        accumulatedUsage = mergeCursorUsage(accumulatedUsage, runResult.usage)

        if (!runResult.pausedForResume || args.signal?.aborted) break

        await new Promise<void>((resolve) => {
          if (!args.requestId || !this.pausedRequests.has(args.requestId)) {
            resolve()
            return
          }
          this.resumeResolvers.set(args.requestId, resolve)
        })

        if (args.signal?.aborted) break

        const queuedContext = args.getQueuedContext?.()?.trim()
        currentUserText =
          queuedContext && queuedContext.length > 0 ? queuedContext : DEFAULT_CURSOR_RESUME_PROMPT
        currentResumeId = args.conversationId ? this.sessions.get(args.conversationId) : null
        if (!currentResumeId) break
      }

      return { text: accumulatedText, usage: accumulatedUsage }
    } finally {
      bridge?.dispose()
      cursorDebug(`turn done +${Date.now() - turnStart}ms`)
    }
  }

  private async spawnTurn(
    args: {
      modelId: string
      system: string
      messages: ChatMessage[]
      latestUserText: string
      conversationId: string | null
      requestId: string | null
      signal: AbortSignal | null
      mode: 'ask' | 'agent'
      enableBrowserTools: boolean
    },
    cliArgs: string[],
    workdir: string,
    bridge: BridgeRegistration | null,
    turnStart: number
  ): Promise<{ text: string; usage?: CursorUsage; pausedForResume: boolean }> {
    return new Promise((resolve, reject) => {
      const prompt = cliArgs.at(-1) ?? ''
      const flags = [
        cliArgs.includes('--resume') ? 'resume' : 'fresh',
        cliArgs.includes('--approve-mcps') ? 'mcp' : 'no-mcp',
        args.mode
      ].join(' ')
      cursorDebug(
        `spawn +${Date.now() - turnStart}ms promptChars=${prompt.length} ${flags}`
      )
      const child = spawn(CURSOR_BIN, cliArgs, {
        cwd: workdir,
        env: bridge ? { ...process.env, ...bridge.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      if (args.requestId) this.activeProcesses.set(args.requestId, child)

      let settled = false
      let emittedText = ''
      let loggedFirstToken = false
      let loggedFirstStdout = false
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

      const emitDelta = (text: string, kind: CursorAssistantEventKind): void => {
        const { delta, nextEmitted } = computeCursorEmitDelta(emittedText, text, kind)
        emittedText = nextEmitted
        if (!delta) return
        if (!loggedFirstToken) {
          loggedFirstToken = true
          cursorDebug(`first token +${Date.now() - turnStart}ms`)
        }
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
            if (!loggedFirstStdout) {
              loggedFirstStdout = true
              cursorDebug(`first stdout +${Date.now() - turnStart}ms`)
            }
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
          if (shouldEmitAssistantStreamText(kind)) emitDelta(text, kind)
          return
        }

        if (msg.type === 'result') {
          if (typeof msg.result === 'string') {
            finalText = msg.result
            emitDelta(msg.result, 'final_flush')
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
        if (process.env.GLADDIS_CURSOR_DEBUG) {
          const trimmed = line.trim()
          if (trimmed) cursorDebug(`stderr +${Date.now() - turnStart}ms ${trimmed}`)
        }
      })

      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', (code) => {
        if (settled) return
        const paused = args.requestId ? this.pausedRequests.has(args.requestId) : false
        if (paused) {
          finish(() => resolve({
            text: finalText ?? emittedText,
            usage: finalUsage,
            pausedForResume: true
          }))
          return
        }
        if (args.signal?.aborted) {
          finish(() => resolve({ text: finalText ?? emittedText, usage: finalUsage, pausedForResume: false }))
          return
        }
        if (code && code !== 0) {
          const message = stderr.trim() || 'Cursor Agent exited with code ' + code
          finish(() => reject(new Error(message)))
          return
        }
        finish(() => resolve({ text: finalText ?? emittedText, usage: finalUsage, pausedForResume: false }))
      })
    })
  }
}

function mergeCursorUsage(base: CursorUsage | undefined, next: CursorUsage | undefined): CursorUsage | undefined {
  if (!next) return base
  if (!base) return next
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cachedInputTokens: (base.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0)
  }
}

export function parseCursorModels(text: string): ModelOption[] {
  const models: ModelOption[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line === 'Available models' || line.startsWith('Tip:') || line.startsWith('Usage:')) {
      continue
    }
    const match = /^([^\s]+)\s+-\s+(.+)$/.exec(line)
    if (!match) continue
    const id = match[1]?.trim()
    const rawLabel = match[2]?.trim()
    if (!id || !rawLabel) continue
    const label = rawLabel.replace(/\s+\((?:default|current)\)\s*$/i, '').trim()
    models.push({
      id,
      label: `Cursor · ${label}`,
      provider: 'cursor'
    })
  }
  return models
}

function gladdisMcpFingerprint(mcpConfigJson: string): string | null {
  const bridgeConfig = parseMcpConfig(mcpConfigJson)
  const gladdisEntry = bridgeConfig.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]
  if (!gladdisEntry) return null
  return JSON.stringify(gladdisEntry)
}

/**
 * True when the in-memory fingerprint matches — fast path only.
 */
export function isMcpConfigWarm(workdir: string, mcpConfigJson: string): boolean {
  const fingerprint = gladdisMcpFingerprint(mcpConfigJson)
  if (fingerprint === null) return true
  return workspaceMcpFingerprints.get(workdir) === fingerprint
}

/**
 * True when `ensureWorkspaceMcpConfig` would be a no-op. Checks the on-disk
 * file after a cache miss so cold app restarts can skip the workspace lock.
 */
export async function probeMcpConfigWarm(workdir: string, mcpConfigJson: string): Promise<boolean> {
  const fingerprint = gladdisMcpFingerprint(mcpConfigJson)
  if (fingerprint === null) return true
  if (workspaceMcpFingerprints.get(workdir) === fingerprint) return true

  const file = join(workdir, '.cursor', 'mcp.json')
  try {
    const previous = await readFile(file, 'utf8')
    const existing = parseMcpConfig(previous)
    const onDisk = JSON.stringify(existing.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME] ?? null)
    if (onDisk === fingerprint) {
      workspaceMcpFingerprints.set(workdir, fingerprint)
      return true
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  return false
}

async function ensureWorkspaceMcpConfigLocked(
  workdir: string,
  mcpConfigJson: string
): Promise<{ dispose: () => Promise<void> }> {
  // Fast path: memory-only check avoids async disk I/O when already warm
  if (isMcpConfigWarm(workdir, mcpConfigJson)) {
    return { dispose: async () => {} }
  }
  return withWorkspaceMcpLock(workdir, async () => {
    // Double-check inside lock: another concurrent call may have warmed it
    if (isMcpConfigWarm(workdir, mcpConfigJson)) {
      return { dispose: async () => {} }
    }
    // Cold path: verify against disk before writing
    if (await probeMcpConfigWarm(workdir, mcpConfigJson)) {
      return { dispose: async () => {} }
    }
    return ensureWorkspaceMcpConfig(workdir, mcpConfigJson)
  })
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
    case 'composer-2.5-fast':
      return 'composer-2.5-fast'
    default:
      return modelId
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * Compute the next stream delta for Cursor CLI assistant text.
 * Handles cumulative snapshots, incremental suffix chunks ("p" + "ong"), and
 * reformatted final_flush snapshots that would otherwise re-emit the full reply.
 */
export function computeCursorEmitDelta(
  emitted: string,
  text: string,
  kind: CursorAssistantEventKind
): { delta: string; nextEmitted: string } {
  if (!text) return { delta: '', nextEmitted: emitted }

  if (text.startsWith(emitted)) {
    return { delta: text.slice(emitted.length), nextEmitted: text }
  }

  if (kind === 'stream_delta') {
    return { delta: text, nextEmitted: emitted + text }
  }

  if (kind === 'final_flush' && emitted) {
    const normText = collapseWhitespace(text)
    const normEmitted = collapseWhitespace(emitted)
    if (normText === normEmitted) {
      return { delta: '', nextEmitted: text }
    }
    if (normText.startsWith(normEmitted) && normText.length > normEmitted.length) {
      const delta = reconcileNormalizedSuffix(emitted, text)
      return { delta, nextEmitted: text }
    }
    // The terminal `result` (and some final_flush snapshots) restate the
    // pre-tool-call preamble plus a reformatted/partial reply — content that was
    // already streamed across tool boundaries. Such a snapshot is a substring of
    // what we emitted rather than a prefix of it, so the checks above miss it and
    // the fallthrough would re-emit the whole reply (the "answer repeated N times,
    // one per tool call" bug). If everything in this snapshot was already shown,
    // emit nothing and keep the longer accumulated text as the source of truth.
    if (normEmitted.includes(normText)) {
      return { delta: '', nextEmitted: emitted }
    }
  }

  return { delta: text, nextEmitted: emitted + text }
}

function reconcileNormalizedSuffix(emitted: string, text: string): string {
  const target = collapseWhitespace(text)
  for (let start = emitted.length; start <= text.length; start++) {
    const suffix = text.slice(start)
    if (collapseWhitespace(emitted + suffix) === target) return suffix
  }
  for (let start = 0; start < text.length; start++) {
    const suffix = text.slice(start)
    if (suffix && collapseWhitespace(emitted + suffix) === target) return suffix
  }
  return ''
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

export function formatCursorToolName(toolCall: any): string {
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

export function cursorToolOk(toolCall: any): boolean {
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
  if ('status' in result && typeof result.status === 'string' && /^(error|failed)$/i.test(result.status)) {
    return false
  }
  if ('exitCode' in result && typeof result.exitCode === 'number' && result.exitCode !== 0) return false
  return true
}

export function cursorToolPreview(toolCall: any): string {
  const payload = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const [firstKey, firstValue] = firstCursorToolEntry(payload)
  if (!firstValue || typeof firstValue !== 'object') return 'Tool completed.'
  const args = cursorToolArgs(toolCall)
  const description = firstTextValue(firstValue.description)
  const result = firstValue.result
  const ok = cursorToolOk(toolCall)

  if (firstKey === 'mcpToolCall') {
    const serverName = typeof firstValue.serverName === 'string' ? firstValue.serverName.trim() : ''
    const mcpToolName = typeof firstValue.toolName === 'string' ? firstValue.toolName.trim() : ''
    const qualified = serverName && mcpToolName ? `${serverName}.${mcpToolName}` : mcpToolName || 'tool'
    const resultText = extractMcpToolResultText(mcpToolName, args, result, ok)
    if (resultText) return resultText
    const argPreview = summarizeArgs(args as Record<string, unknown>)
    if (ok) return argPreview ? `${qualified}: ${argPreview}` : `${qualified} completed.`
    return formatToolError(argPreview ? `${qualified}: ${argPreview}` : `${qualified} failed`)
  }

  const toolName = normalizeCursorToolName(firstKey)
  const resultText = extractToolResultText(toolName, args, result, ok)
  if (resultText) return resultText

  if (description) return description

  if (args && typeof args === 'object') {
    const argPreview = summarizeArgs(args as Record<string, unknown>)
    if (argPreview) return argPreview
  }

  return toolName === 'search_files' ? 'Search completed.' : 'Tool completed.'
}

function firstCursorToolEntry(payload: Record<string, any>): [string, any] {
  const firstKey = Object.keys(payload)[0] ?? ''
  return [firstKey, firstKey ? payload[firstKey] : undefined]
}

export function normalizeCursorToolName(key: string): string {
  switch (key) {
    case 'shellToolCall':
      return 'run_command'
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
  if (typeof value === 'number' || typeof value === 'boolean') return ''
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

function extractMcpToolResultText(
  toolName: string,
  args: unknown,
  result: unknown,
  ok: boolean
): string {
  const argRecord = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  const scope = summarizeArgs(argRecord)
  const body = compactPreview(extractMcpResultBody(result))
  const qualified = toolName ? `gladdis.${toolName}` : 'gladdis.tool'

  if (toolName === 'read_page' || toolName === 'read_a11y' || toolName === 'grep_page') {
    if (body) return ok ? body : formatToolError(scope ? prefixScope(scope, body) : body)
    if (ok) return scope ? `${qualified}: ${scope}` : `${qualified} completed.`
    return formatToolError(scope || `${qualified} failed`)
  }

  if (toolName === 'act' || toolName === 'grep_click' || toolName === 'grep_type') {
    if (body) return ok ? body : formatToolError(scope ? prefixScope(scope, body) : body)
    if (ok) return scope ? `${qualified}: ${scope}` : `${qualified} completed.`
    return formatToolError(scope || `${qualified} failed`)
  }

  if (toolName === 'navigate') {
    const url = typeof argRecord.url === 'string' ? argRecord.url.trim() : scope
    if (body) return ok ? body : formatToolError(url ? prefixScope(url, body) : body)
    if (ok) return url ? `Navigated to ${url}` : `${qualified} completed.`
    return formatToolError(url || `${qualified} failed`)
  }

  if (toolName === 'search') {
    const query = typeof argRecord.query === 'string' ? argRecord.query.trim() : scope
    if (body) return ok ? body : formatToolError(query ? prefixScope(query, body) : body)
    if (ok) return query ? `Searched for ${query}` : `${qualified} completed.`
    return formatToolError(query || `${qualified} failed`)
  }

  if (toolName === 'screenshot' || toolName === 'screenshot_app') {
    if (body) return ok ? body : formatToolError(body)
    return ok ? 'Screenshot captured.' : formatToolError(`${qualified} failed`)
  }

  if (toolName.startsWith('memory_')) {
    if (body) return ok ? body : formatToolError(body)
    if (ok) return scope ? `${qualified}: ${scope}` : `${qualified} completed.`
    return formatToolError(scope || `${qualified} failed`)
  }

  if (body) return ok ? body : formatToolError(scope ? prefixScope(scope, body) : body)
  if (ok) return scope ? `${qualified}: ${scope}` : `${qualified} completed.`
  return formatToolError(scope || `${qualified} failed`)
}

function extractMcpResultBody(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result.trim()
  if (typeof result !== 'object') return ''

  const record = result as Record<string, unknown>
  const contentText = extractPreviewText(record.content)
  if (contentText) return contentText

  return firstNonEmptyText([
    record.error,
    record.message,
    record.stderr,
    record.stdout,
    record.output,
    record.text,
    record.summary,
    record.description,
    record.title
  ])
}

function extractToolResultText(
  toolName: string,
  args: unknown,
  result: unknown,
  ok: boolean
): string {
  const argRecord = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  const scope = summarizeArgs(argRecord)
  const validationCheck =
    typeof argRecord.check === 'string' && argRecord.check.trim() ? argRecord.check.trim() : 'validation'

  if (toolName === 'run_validation') {
    const detail = compactPreview(
      firstNonEmptyText([
        resultRecord.error,
        resultRecord.message,
        resultRecord.stderr,
        resultRecord.stdout,
        resultRecord.output,
        resultRecord.summary,
        resultRecord.text,
        resultRecord.content
      ])
    )
    if (ok) return detail || `${validationCheck}: pass`
    return formatToolError(detail ? prefixScope(validationCheck, detail) : `${validationCheck}: failed`)
  }

  if (toolName === 'run_command') {
    const command =
      typeof argRecord.command === 'string' && argRecord.command.trim()
        ? argRecord.command.trim()
        : typeof argRecord.cmd === 'string' && argRecord.cmd.trim()
          ? argRecord.cmd.trim()
          : scope
    const detail = compactPreview(
      firstNonEmptyText([
        resultRecord.error,
        resultRecord.message,
        resultRecord.stderr,
        resultRecord.stdout,
        resultRecord.output,
        resultRecord.summary,
        resultRecord.text,
        resultRecord.content
      ])
    )
    if (ok) return detail || command || 'Command completed.'
    return formatToolError(detail ? prefixScope(command, detail) : command || 'Command failed')
  }

  if (toolName === 'edit_file' || toolName === 'write_file') {
    const path = typeof argRecord.path === 'string' ? argRecord.path.trim() : scope
    const detail = compactPreview(
      firstNonEmptyText([
        resultRecord.error,
        resultRecord.message,
        resultRecord.summary,
        resultRecord.output,
        resultRecord.text,
        resultRecord.content
      ])
    )
    if (detail) return ok ? detail : formatToolError(path ? prefixScope(path, detail) : detail)
    if (ok) return `${toolName === 'edit_file' ? 'Edited' : 'Wrote'} ${path || 'file'}`
    return formatToolError(path || `${toolName} failed`)
  }

  if (toolName === 'read_file') {
    const path = typeof argRecord.path === 'string' ? argRecord.path.trim() : scope
    const startLine = typeof argRecord.start_line === 'number' ? argRecord.start_line : undefined
    const endLine = typeof argRecord.end_line === 'number' ? argRecord.end_line : undefined
    const detail = compactPreview(
      firstNonEmptyText([
        resultRecord.error,
        resultRecord.message,
        resultRecord.summary,
        resultRecord.description,
        resultRecord.title
      ])
    )
    if (detail) return ok ? detail : formatToolError(path ? prefixScope(path, detail) : detail)
    if (ok) {
      if (path && startLine && endLine) return `Read ${path} (${startLine}-${endLine})`
      return path ? `Read ${path}` : 'Read file'
    }
    return formatToolError(path || 'read_file failed')
  }

  if (toolName === 'search_files') {
    const query = typeof argRecord.query === 'string' ? argRecord.query.trim() : scope
    const hitCount = searchHitCount(resultRecord)
    const detail = compactPreview(
      firstNonEmptyText([
        resultRecord.error,
        resultRecord.message,
        resultRecord.summary,
        resultRecord.output,
        resultRecord.text,
        resultRecord.description
      ])
    )
    if (detail) return ok ? detail : formatToolError(query ? prefixScope(query, detail) : detail)
    if (ok) {
      if (typeof hitCount === 'number') {
        return query ? `Search found ${hitCount} hit(s) for ${query}` : `Search found ${hitCount} hit(s)`
      }
      return query ? `Searched for ${query}` : 'Search completed.'
    }
    return formatToolError(query || 'search_files failed')
  }

  if (toolName === 'list_dir') {
    const path = typeof argRecord.path === 'string' ? argRecord.path.trim() : scope
    const detail = compactPreview(
      firstNonEmptyText([
        resultRecord.error,
        resultRecord.message,
        resultRecord.summary,
        resultRecord.output,
        resultRecord.text,
        resultRecord.description
      ])
    )
    if (detail) return ok ? detail : formatToolError(path ? prefixScope(path, detail) : detail)
    if (ok) return path ? `Listed ${path}` : 'Listed directory'
    return formatToolError(path || 'list_dir failed')
  }

  const detail = compactPreview(
    firstNonEmptyText([
      resultRecord.error,
      resultRecord.message,
      resultRecord.summary,
      resultRecord.stderr,
      resultRecord.stdout,
      resultRecord.output,
      resultRecord.text,
      resultRecord.content,
      result
    ])
  )
  if (detail) return ok ? detail : formatToolError(scope ? prefixScope(scope, detail) : detail)

  if (!ok) return formatToolError(scope || `${toolName} failed`)
  return ''
}

function prefixScope(scope: string, detail: string): string {
  if (!scope) return detail
  const normalizedScope = scope.trim()
  const normalizedDetail = detail.trim()
  if (!normalizedScope || !normalizedDetail) return normalizedScope || normalizedDetail
  if (normalizedDetail.toLowerCase().startsWith(normalizedScope.toLowerCase())) return normalizedDetail
  return `${normalizedScope}: ${normalizedDetail}`
}

function formatToolError(detail: string): string {
  const normalized = compactPreview(detail)
  if (!normalized) return '[tool error]'
  return normalized.startsWith('[tool error]') ? normalized : `[tool error] ${normalized}`
}

function compactPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > 280 ? normalized.slice(0, 279) + '…' : normalized
}

function searchHitCount(resultRecord: Record<string, unknown>): number | undefined {
  if (Array.isArray(resultRecord.hits)) return resultRecord.hits.length
  if (Array.isArray(resultRecord.matches)) return resultRecord.matches.length
  if (typeof resultRecord.hitCount === 'number' && Number.isFinite(resultRecord.hitCount)) return resultRecord.hitCount
  if (typeof resultRecord.count === 'number' && Number.isFinite(resultRecord.count)) return resultRecord.count
  if (typeof resultRecord.total === 'number' && Number.isFinite(resultRecord.total)) return resultRecord.total
  return undefined
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
