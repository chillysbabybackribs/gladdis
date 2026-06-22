import type {
  ChatRequest,
  ChatStreamEvent,
  CodexStatus,
  CodexWorkspace,
  ModelOption
} from '../../../../shared/types'
import type { BrowserTools } from '../browserTools'
import { CodexAppServer, probeCodexBinary } from './CodexAppServer'
import { ThreadCompactor } from './ThreadCompactor'
import { textInput } from './protocol'
import { unsubscribeThread } from './threadLifecycle'
import {
  requestWithOptimizationFallback,
  serviceTierForModel,
  turnReasoningOverrides
} from './turnOptions'
import { CodexThreadStore, type PersistedThreads } from './codexThreadStore'
import {
  routeNotification,
  routeServerRequest,
  type ActiveTurn
} from './codexTurnRouter'
import type {
  CodexModelEntry,
  GetAuthStatusResponse,
  ModelListResponse,
  ServerNotification,
  ServerRequest,
  TurnStartParams,
  UserInput
} from './protocol'

/**
 * Translates Codex app-server threads/turns into gladdis ChatStreamEvents.
 *
 * The class itself owns:
 *   • the live app-server process
 *   • the live-turn (`ActiveTurn`) map keyed by gladdis requestId
 *   • the live model catalog from `model/list` (for reasoning overrides)
 *
 * Thread lifecycle (start/resume/forget/posture) lives in `codexThreadStore`,
 * and notification + server-request routing lives in `codexTurnRouter` —
 * both pure-ish helpers that take the state they need explicitly.
 */
export class CodexClient {
  private server: CodexAppServer | null = null
  /** gladdis requestId -> active turn. */
  private active = new Map<string, ActiveTurn>()
  /** model id -> latest metadata from model/list. */
  private modelCatalog = new Map<string, CodexModelEntry>()
  private readonly compactor = new ThreadCompactor()
  /** Wall-clock (ms) of the previous tool-item end. Cross-turn is fine
   *  because it only labels diagnostics under GLADDIS_CODEX_DEBUG. */
  private readonly lastToolEndAt = { value: 0 }
  private readonly threadStore: CodexThreadStore

  constructor(
    private readonly emit: (e: ChatStreamEvent) => void,
    private getWorkspace: () => CodexWorkspace,
    private readonly browserTools: BrowserTools,
    persistedThreads: PersistedThreads
  ) {
    this.threadStore = new CodexThreadStore({
      ensureServer: () => this.ensureServer(),
      getWorkspace,
      compactor: this.compactor,
      persistedThreads
    })
  }

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
   * ModelOptions (provider 'codex'). Hidden models are dropped; the CLI
   * default is sorted first. Returns [] if Codex isn't installed/reachable so
   * the caller can fall back to the static catalog.
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
    server.on('notification', (m: ServerNotification) =>
      routeNotification(m, {
        emit: this.emit,
        compactor: this.compactor,
        turnForThread: (id) => this.turnForThread(id),
        server: () => this.server,
        lastToolEndAt: this.lastToolEndAt
      })
    )
    server.on('serverRequest', (m: ServerRequest) =>
      void routeServerRequest(m, {
        emit: this.emit,
        server: () => this.server,
        turnForThread: (id) => this.turnForThread(id),
        browserTools: this.browserTools,
        completeWithModel: (modelId, system, user) => this.complete(modelId, system, user)
      })
    )
    server.on('exit', () => {
      // The process died; drop cached threads so the next turn starts fresh.
      this.threadStore.clear()
      if (this.server === server) this.server = null
    })
    await server.start()
    this.server = server
    return server
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
    const p = this.threadStore.posture(false)
    const threadId = await this.threadStore.startThread(null, modelId, system, true, false)
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
   * Run one user turn and stream its output. Resolves when the turn
   * completes, errors, or is aborted. The caller (ChatService) emits the
   * final 'done'.
   */
  async send(
    req: ChatRequest,
    signal: AbortSignal,
    system?: string,
    useWorkspace = true
  ): Promise<string> {
    const server = await this.ensureServer()
    const resolution = await this.threadStore.ensureThread(req, system, useWorkspace)
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

    const p = this.threadStore.posture(useWorkspace)
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
        // Stale thread binding: the turn-start failed, but the conversation
        // is fresh enough that we can drop the binding and try once more
        // with a brand-new thread before bubbling the error up.
        if (!resolution.canRetryFresh || !req.conversationId) throw err
        this.threadStore.forget(req.conversationId, resolution.threadId, useWorkspace)
        const freshThreadId = await this.threadStore.startThread(
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

  dispose(): void {
    this.compactor.dispose()
    this.server?.dispose()
    this.server = null
    this.threadStore.clear()
    this.active.clear()
  }
}
