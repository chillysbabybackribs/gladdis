import type {
  ChatRequest,
  ChatStreamEvent,
  CodexStatus,
  CodexWorkspace,
  ModelOption
} from '../../../../shared/types'
import type { BrowserTools } from '../browserTools'
import type { LlmComplete } from '../../pipeline/Planner'
import { CodexAppServer, probeCodexBinary } from './CodexAppServer'
import { ThreadCompactor } from './ThreadCompactor'
import { resolveCodexPosture, type CodexPosture } from './posture'
import { textInput } from './protocol'
import { TOOL_ITEM_TYPES, codexToolName, isGladdisDynamicToolCall, toolArgs, toolOk, toolPreview } from './toolItems'
import { findCodexToolPolicyViolation } from './toolPolicy'
import {
  CODEX_BROWSER_TOOLS,
  CODEX_DISABLED_NATIVE_CONFIG,
  respondToCodexBrowserToolCall
} from './dynamicBrowserTools'
import { unsubscribeThread } from './threadLifecycle'
import {
  requestWithOptimizationFallback,
  serviceTierForModel,
  turnReasoningOverrides
} from './turnOptions'
import type {
  AgentMessageDeltaParams,
  CodexModelEntry,
  ErrorParams,
  GetAuthStatusResponse,
  ItemLifecycleParams,
  JsonValue,
  ModelListResponse,
  ServerNotification,
  ServerRequest,
  ThreadTokenUsage,
  ThreadItem,
  ThreadResumeParams,
  ThreadStartParams,
  TurnLifecycleParams,
  TurnStartParams,
  UserInput
} from './protocol'

interface ActiveTurn {
  requestId: string
  conversationId: string | null
  /** The Codex model driving this turn — also used to plan any browse_task it invokes. */
  modelId: string
  threadId: string | null
  turnId: string | null
  done: () => void
  aborted: boolean
  text: string
  silent: boolean
  error: Error | null
  toolItems: Map<string, { tool: string }>
  blockedItems: Set<string>
}

interface ThreadResolution {
  threadId: string
  /** True when a stale binding can still be discarded and retried once. */
  canRetryFresh: boolean
}

/** Translates Codex app-server threads/turns into gladdis ChatStreamEvents. */
export class CodexClient {
  private server: CodexAppServer | null = null
  /** conversationId -> Codex threadId. */
  private threads = new Map<string, string>()
  /** gladdis requestId -> active turn. */
  private active = new Map<string, ActiveTurn>()
  /** model id -> latest metadata from model/list. */
  private modelCatalog = new Map<string, CodexModelEntry>()
  private readonly compactor = new ThreadCompactor()
  /** Wall-clock (ms) the previous tool item finished, for GLADDIS_CODEX_DEBUG
   *  reasoning-gap timing. Cross-turn is fine — it only labels diagnostics. */
  private lastToolEndAt = 0
  /** server requestId -> the gladdis requestId it belongs to (for routing). */

  constructor(
    private readonly emit: (e: ChatStreamEvent) => void,
    private getWorkspace: () => CodexWorkspace,
    private readonly browserTools: BrowserTools,
    private readonly persistedThreads: {
      get: (conversationId: string) => string | null
      set: (conversationId: string, threadId: string | null) => void
    }
  ) {}

  /** Report install + auth status for the ModelPicker / settings keys tab. */
  async status(): Promise<CodexStatus> {
    const probe = await probeCodexBinary()
    if (!probe.installed) {
      return {
        installed: false,
        authenticated: false,
        authMethod: null,
        version: null,
        detail: 'Codex CLI not found. Install with `npm i -g @openai/codex`, then run `codex login`.'
      }
    }
    try {
      const server = await this.ensureServer()
      const auth = (await server.request('getAuthStatus', {
        includeToken: false,
        refreshToken: false
      })) as GetAuthStatusResponse
      const authenticated = !!auth.authMethod
      return {
        installed: true,
        authenticated,
        authMethod: auth.authMethod,
        version: probe.version,
        detail: authenticated ? null : 'Codex is installed but not logged in. Run `codex login`.'
      }
    } catch (e) {
      return {
        installed: true,
        authenticated: false,
        authMethod: null,
        version: probe.version,
        detail: `Codex app-server error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /**
   * Live model catalog from the app-server's `model/list`, mapped to gladdis
   * ModelOptions (provider 'codex'). Hidden models are dropped; the CLI default
   * is sorted first. Returns [] if Codex isn't installed/reachable so the caller
   * can fall back to the static catalog.
   */
  async listModels(): Promise<ModelOption[]> {
    const probe = await probeCodexBinary()
    if (!probe.installed) return []
    try {
      const server = await this.ensureServer()
      const res = (await server.request('model/list', { includeHidden: false })) as ModelListResponse
      const entries = res.data ?? res.items ?? res.models ?? []
      this.modelCatalog.clear()
      const withDefault = entries
        .filter((e) => !e.hidden)
        .map((e) => {
          const id = (e.id ?? e.model) as string | undefined
          if (!id) return null
          this.modelCatalog.set(id, e)
          const name = e.displayName ?? e.name ?? id
          return { id, label: `Codex · ${name}`, provider: 'codex' as const, isDefault: !!e.isDefault }
        })
        .filter((o): o is { id: string; label: string; provider: 'codex'; isDefault: boolean } => o !== null)
      // CLI default first, then preserve server order.
      withDefault.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      return withDefault.map(({ id, label, provider }) => ({ id, label, provider }))
    } catch (e) {
      console.warn('[codex] model/list failed:', e instanceof Error ? e.message : e)
      return []
    }
  }

  private async ensureServer(): Promise<CodexAppServer> {
    if (this.server && this.server.running) return this.server
    const server = new CodexAppServer()
    server.on('notification', (m: ServerNotification) => this.onNotification(m))
    server.on('serverRequest', (m: ServerRequest) => this.onServerRequest(m))
    server.on('exit', () => {
      // The process died; drop cached threads so the next turn starts fresh.
      this.threads.clear()
      if (this.server === server) this.server = null
    })
    await server.start()
    this.server = server
    return server
  }

  /**
   * Resolve the cwd + permission posture for a turn. The user's folder choice is
   * a launch location only; Codex always gets unrestricted OS-user access.
   */
  private posture(useWorkspace = true): CodexPosture {
    return resolveCodexPosture(useWorkspace ? this.getWorkspace().folder : null)
  }

  private threadKey(conversationId: string | null, useWorkspace = true): string {
    return conversationId ? conversationId : `__ephemeral__:${useWorkspace ? 'workspace' : 'ambient'}`
  }

  private rememberThread(conversationId: string | null, threadId: string, useWorkspace = true): void {
    this.threads.set(this.threadKey(conversationId, useWorkspace), threadId)
    if (conversationId) this.persistedThreads.set(conversationId, threadId)
  }

  private forgetThread(conversationId: string | null, threadId?: string, useWorkspace = true): void {
    const key = this.threadKey(conversationId, useWorkspace)
    if (!threadId || this.threads.get(key) === threadId) this.threads.delete(key)
    if (conversationId) this.persistedThreads.set(conversationId, null)
  }

  private async startThread(
    conversationId: string | null,
    modelId: string,
    system?: string,
    ephemeral = false,
    useWorkspace = true
  ): Promise<string> {
    const server = await this.ensureServer()
    const p = this.posture(useWorkspace)
    const serviceTier = serviceTierForModel(modelId)
    const params: ThreadStartParams = {
      model: modelId,
      cwd: p.cwd,
      approvalPolicy: p.approvalPolicy,
      sandbox: p.sandbox,
      config: await this.codexConfig(modelId),
      dynamicTools: CODEX_BROWSER_TOOLS,
      ...(serviceTier ? { serviceTier } : {}),
      ephemeral,
      // gladdis's identity for the thread. Without it, the codex CLI falls back to
      // its own default persona + global config (~/.codex), which leaks an
      // unrelated identity into gladdis's chat. Mirrors complete()'s instructions.
      ...(system ? { developerInstructions: system } : {})
    }
    const res = (await requestWithOptimizationFallback(server, 'thread/start', params)) as {
      thread: { id: string }
    }
    const threadId = res.thread.id
    if (!ephemeral) this.rememberThread(conversationId, threadId, useWorkspace)
    return threadId
  }

  private async resumeThread(
    conversationId: string,
    threadId: string,
    modelId: string,
    system?: string,
    useWorkspace = true
  ): Promise<string> {
    const server = await this.ensureServer()
    const p = this.posture(useWorkspace)
    const serviceTier = serviceTierForModel(modelId)
    const params: ThreadResumeParams = {
      threadId,
      model: modelId,
      cwd: p.cwd,
      approvalPolicy: p.approvalPolicy,
      sandbox: p.sandbox,
      config: await this.codexConfig(modelId),
      dynamicTools: CODEX_BROWSER_TOOLS,
      ...(serviceTier ? { serviceTier } : {}),
      ...(system ? { developerInstructions: system } : {})
    }
    const res = (await requestWithOptimizationFallback(server, 'thread/resume', params)) as {
      thread: { id: string }
    }
    const resumedThreadId = res.thread.id
    this.rememberThread(conversationId, resumedThreadId, useWorkspace)
    return resumedThreadId
  }

  private async codexConfig(modelId?: string): Promise<{ [key: string]: JsonValue }> {
    const serviceTier = modelId ? serviceTierForModel(modelId) : null
    return {
      // Disable native web search. The codex CLI's documented knob is the
      // top-level `web_search` string ("live" | "cached" | "disabled"); it
      // defaults to disabled, but we set it explicitly. Do NOT also set
      // `tools.web_search` — that field is the untagged WebSearchToolConfigInput
      // enum and `null` matches no variant, which makes thread/start fail with
      // "data did not match any variant of untagged enum WebSearchToolConfigInput".
      ...CODEX_DISABLED_NATIVE_CONFIG,
      ...(serviceTier
        ? {
            service_tier: serviceTier,
            ...(serviceTier === 'fast' ? { features: { fast_mode: true } } : {})
          }
        : {})
    }
  }

  /** Get (or recover) the Codex thread for this conversation. */
  private async ensureThread(
    req: ChatRequest,
    system?: string,
    useWorkspace = true
  ): Promise<ThreadResolution> {
    const conversationId = req.conversationId ?? null
    const key = this.threadKey(conversationId, useWorkspace)
    const cached = this.threads.get(key)
    if (cached) {
      await this.compactor.wait(cached)
      return { threadId: cached, canRetryFresh: !!conversationId }
    }
    if (!conversationId) {
      const threadId = await this.startThread(null, req.modelId, system, false, useWorkspace)
      return { threadId, canRetryFresh: false }
    }

    const persisted = this.persistedThreads.get(conversationId)
    if (persisted) {
      const threadId = await this.resumeThread(
        conversationId,
        persisted,
        req.modelId,
        system,
        useWorkspace
      )
      return { threadId, canRetryFresh: true }
    }

    const threadId = await this.startThread(conversationId, req.modelId, system, false, useWorkspace)
    return { threadId, canRetryFresh: false }
  }

  private beginTurn(
    requestId: string,
    threadId: string,
    silent: boolean,
    modelId: string,
    conversationId: string | null = null
  ): { turn: ActiveTurn; completion: Promise<void> } {
    const turn: ActiveTurn = {
      requestId,
      conversationId,
      modelId,
      threadId,
      turnId: null,
      done: () => {},
      aborted: false,
      text: '',
      silent,
      error: null,
      toolItems: new Map(),
      blockedItems: new Set()
    }
    this.active.set(requestId, turn)

    const completion = new Promise<void>((resolve) => {
      turn.done = resolve
    })
    return { turn, completion }
  }

  /** Run one non-streaming Codex turn → assistant text (browse_task/pipeline planning). */
  async complete(modelId: string, system: string, user: string): Promise<string> {
    const server = await this.ensureServer()
    const p = this.posture(false)
    const threadId = await this.startThread(null, modelId, system, true, false)
    const requestId = `codex-complete-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { turn, completion } = this.beginTurn(requestId, threadId, true, modelId, null)

    const params: TurnStartParams = {
      threadId,
      input: [textInput(user)],
      cwd: p.cwd,
      approvalPolicy: p.approvalPolicy,
      sandboxPolicy: p.sandboxPolicy,
      model: modelId,
      serviceTier: serviceTierForModel(modelId),
      ...turnReasoningOverrides(this.modelCatalog.get(modelId))
    }

    try {
      await requestWithOptimizationFallback(server, 'turn/start', params)
      await completion
      if (turn.error) throw turn.error
      return turn.text
    } finally {
      void unsubscribeThread(this.server, threadId)
      this.active.delete(requestId)
    }
  }

  /**
   * Run one user turn and stream its output. Resolves when the turn completes,
   * errors, or is aborted. The caller (ChatService) emits the final 'done'.
   */
  async send(
    req: ChatRequest,
    signal: AbortSignal,
    system?: string,
    useWorkspace = true
  ): Promise<string> {
    const server = await this.ensureServer()
    const resolution = await this.ensureThread(req, system, useWorkspace)
    const input: UserInput[] = [
      textInput([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '')
    ]

    const { turn, completion } = this.beginTurn(
      req.requestId,
      resolution.threadId,
      false,
      req.modelId,
      req.conversationId ?? null
    )

    // Wire abort -> turn/interrupt.
    const onAbort = (): void => {
      turn.aborted = true
      if (turn.threadId) {
        server.notify('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId })
      }
      turn.done()
    }
    if (signal.aborted) {
      this.active.delete(req.requestId)
      return ''
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const p = this.posture(useWorkspace)
    const params: TurnStartParams = {
      threadId: resolution.threadId,
      input,
      cwd: p.cwd,
      approvalPolicy: p.approvalPolicy,
      sandboxPolicy: p.sandboxPolicy,
      model: req.modelId,
      clientUserMessageId: req.requestId,
      serviceTier: serviceTierForModel(req.modelId),
      ...turnReasoningOverrides(this.modelCatalog.get(req.modelId))
    }

    try {
      try {
        await requestWithOptimizationFallback(server, 'turn/start', params)
      } catch (err) {
        if (!resolution.canRetryFresh || !req.conversationId) throw err
        this.forgetThread(req.conversationId, resolution.threadId, useWorkspace)
        const freshThreadId = await this.startThread(
          req.conversationId,
          req.modelId,
          system,
          false,
          useWorkspace
        )
        turn.threadId = freshThreadId
        params.threadId = freshThreadId
        params.input = input
        await requestWithOptimizationFallback(server, 'turn/start', params)
      }
      await completion
      if (!turn.aborted && !turn.error) this.compactor.schedule(this.server, turn.threadId)
      return turn.text
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.active.delete(req.requestId)
    }
  }

  /** Find the active turn a notification/request belongs to, by threadId. */
  private turnForThread(threadId: string | undefined): ActiveTurn | undefined {
    if (!threadId) {
      // Only one turn is typically active; fall back to the sole entry.
      return this.active.size === 1 ? [...this.active.values()][0] : undefined
    }
    for (const t of this.active.values()) if (t.threadId === threadId) return t
    return undefined
  }

  private onNotification(msg: ServerNotification): void {
    const method = msg.method
    const params = msg.params as any
    if (method === 'thread/tokenUsage/updated' && params?.threadId && params?.tokenUsage) {
      this.compactor.record(params.threadId, params.tokenUsage as ThreadTokenUsage)
      return
    }
    if (method === 'thread/compacted' || method === 'turn/completed') {
      this.compactor.finish(params?.threadId)
    }
    const turn = this.turnForThread(params?.threadId)
    if (!turn) return

    switch (method) {
      case 'turn/started': {
        const p = params as TurnLifecycleParams
        turn.turnId = p.turn?.id ?? turn.turnId
        break
      }
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaParams
        if (p.delta) {
          turn.text += p.delta
          if (!turn.silent) this.emit({ requestId: turn.requestId, type: 'delta', text: p.delta })
        }
        break
      }
      case 'item/started': {
        this.onItemStarted(turn, (params as ItemLifecycleParams).item)
        break
      }
      case 'item/completed': {
        this.onItemCompleted(turn, (params as ItemLifecycleParams).item)
        break
      }
      case 'turn/completed': {
        turn.done()
        break
      }
      case 'error': {
        const p = params as ErrorParams
        turn.error = new Error(p.message || 'Codex error')
        if (!turn.aborted) {
          if (!turn.silent) {
            this.emit({
              requestId: turn.requestId,
              type: 'error',
              message: turn.error.message
            })
          }
        }
        turn.done()
        break
      }
      default:
        break // ignore the many notifications gladdis doesn't surface
    }
  }

  /** A new ThreadItem began — surface tool-like ones as a running tool chip. */
  private onItemStarted(turn: ActiveTurn, item: ThreadItem): void {
    const type = item?.type
    if (!type || !TOOL_ITEM_TYPES.has(type)) return
    // gladdis.* browser tools chip via respondToCodexBrowserToolCall; don't double-chip.
    if (isGladdisDynamicToolCall(item)) return
    const violation = findCodexToolPolicyViolation(item)
    if (violation) {
      this.blockPolicyViolation(turn, item, violation)
      return
    }
    // Wall-clock the gap since the previous tool item finished — this is the
    // model-reasoning time *between* calls. Read alongside [codex-bridge] (the
    // gladdis-side per-call cost) to attribute the seconds-per-call lag: a small
    // bridge number + a large gap here means the latency is reasoning, not
    // transport. Gated on GLADDIS_CODEX_DEBUG.
    if (process.env.GLADDIS_CODEX_DEBUG) {
      const now = Date.now()
      const since = this.lastToolEndAt ? `${now - this.lastToolEndAt}ms since prev tool` : 'first tool'
      console.log(`[codex-turn] ${codexToolName(item)} starting — ${since} (model reasoning gap)`)
    }
    turn.toolItems.set(item.id, { tool: codexToolName(item) })
    if (!turn.silent) {
      this.emit({
        requestId: turn.requestId,
        type: 'tool_call',
        tool: codexToolName(item),
        args: toolArgs(item),
        callId: item.id
      })
    }
  }

  private blockPolicyViolation(
    turn: ActiveTurn,
    item: ThreadItem,
    violation: { reason: string; guidance: string }
  ): void {
    const server = this.server
    const tool = 'blocked_native_browser_tool'
    const command = (item as any).command
    turn.toolItems.set(item.id, { tool })
    turn.blockedItems.add(item.id)
    if (!turn.silent) {
      this.emit({
        requestId: turn.requestId,
        type: 'tool_call',
        tool,
        args: { command, reason: violation.reason },
        callId: item.id
      })
      this.emit({
        requestId: turn.requestId,
        type: 'tool_result',
        callId: item.id,
        ok: false,
        preview: `${violation.reason} ${violation.guidance}`
      })
      this.emit({
        requestId: turn.requestId,
        type: 'error',
        message: `${violation.reason} ${violation.guidance}`
      })
    }
    turn.error = new Error(`${violation.reason} ${violation.guidance}`)
    turn.aborted = true
    if (turn.threadId) {
      server?.notify('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId })
    }
    turn.done()
  }

  /** A ThreadItem finished — close its tool chip, or render a final agentMessage. */
  private onItemCompleted(turn: ActiveTurn, item: ThreadItem): void {
    const type = item?.type
    if (turn.blockedItems.delete(item.id)) {
      turn.toolItems.delete(item.id)
      return
    }
    // gladdis.* browser tools are chipped by respondToCodexBrowserToolCall.
    if (isGladdisDynamicToolCall(item)) return
    if (type && TOOL_ITEM_TYPES.has(type)) {
      const ok = toolOk(item)
      if (!turn.silent) {
        this.emit({
          requestId: turn.requestId,
          type: 'tool_result',
          callId: item.id,
          ok,
          preview: toolPreview(item)
        })
      }
      turn.toolItems.delete(item.id)
      if (process.env.GLADDIS_CODEX_DEBUG) this.lastToolEndAt = Date.now()
    }
    // agentMessage text is already streamed via item/agentMessage/delta, so we
    // don't re-emit it here (would duplicate). reasoning items are not surfaced.
  }

  private onServerRequest(msg: ServerRequest): void {
    const server = this.server
    if (!server) return
    const method = msg.method
    if (method === 'item/tool/call') {
      void this.respondToBrowserTool(msg)
    } else if (method === 'item/commandExecution/requestApproval') {
      server.respond(msg.id, { decision: 'accept' })
    } else if (method === 'item/fileChange/requestApproval') {
      server.respond(msg.id, { decision: 'accept' })
    } else {
      // Unknown server request: respond with an empty object so we don't block.
      server.respond(msg.id, {})
    }
  }

  private async respondToBrowserTool(msg: ServerRequest): Promise<void> {
    const server = this.server
    if (!server) return
    const turn = this.turnForThread(typeof (msg.params as any)?.threadId === 'string' ? (msg.params as any).threadId : undefined)
    await respondToCodexBrowserToolCall({
      msg,
      respond: (id, result) => server.respond(id, result),
      tools: this.browserTools,
      // browse_task / pipeline planning runs on the SAME Codex model driving this
      // turn — the user's picked model does the work, no substitution.
      llm: turn ? (system, user) => this.complete(turn.modelId, system, user) : null,
      conversationId: turn?.conversationId ?? null,
      requestId: turn && !turn.silent ? turn.requestId : undefined,
      emit: this.emit
    })
  }

  dispose(): void {
    this.compactor.dispose()
    this.server?.dispose()
    this.server = null
    this.threads.clear()
    this.active.clear()
  }
}
