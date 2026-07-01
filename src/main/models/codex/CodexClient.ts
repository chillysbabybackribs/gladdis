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
 * Continuation message sent on resume after a Codex pause. Phrased as an
 * explicit instruction from the user so Codex picks the work back up rather
 * than treating the resume as a new ask. Codex's thread memory carries the
 * partial state, so we don't need to replay any prior assistant text — we
 * just nudge it to keep going from exactly the same step.
 */
const CODEX_RESUME_PROMPT =
  'I just resumed you after a pause. Continue from exactly where you left off — same task, same step, same intent. Do not re-introduce or summarize what you were doing; just keep going.'

function buildCodexResumePrompt(context: string | null): string {
  if (!context) return CODEX_RESUME_PROMPT
  return [
    CODEX_RESUME_PROMPT,
    '',
    '[User context added while this task was running]',
    'Treat this as the latest user guidance. If it corrects the current direction, adjust before taking the next step.',
    '',
    context
  ].join('\n')
}

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
    server.on('serverRequest', (m: ServerRequest) => {
      // routeServerRequest is total (always responds, never rejects); the catch is
      // a last-resort backstop so a stray failure can never become an
      // UnhandledPromiseRejectionWarning out of this fire-and-forget handler.
      routeServerRequest(m, {
        emit: this.emit,
        server: () => this.server,
        turnForThread: (id) => this.turnForThread(id),
        browserTools: this.browserTools,
        completeWithModel: (modelId, system, user) => this.complete(modelId, system, user)
      }).catch(() => {})
    })
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
      paused: false,
      queuedUserContext: [],
      autoResumeAfterPause: false,
      resumeResolver: null,
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

  /**
   * Mint a fresh completion promise for the next pause/resume iteration of
   * a long-lived turn. Used internally by send() after resume — we need a
   * new resolver because the previous `turn.done()` already fired when the
   * pause/interrupt landed.
   */
  private resetTurnCompletion(turn: ActiveTurn): Promise<void> {
    return new Promise<void>((resolve) => {
      turn.done = resolve
    })
  }

  private consumeQueuedUserContext(turn: ActiveTurn): string | null {
    if (turn.queuedUserContext.length === 0) return null
    const text = turn.queuedUserContext.join('\n\n')
    turn.queuedUserContext = []
    return text
  }

  /** Run one non-streaming Codex turn → assistant text (used for nested LLM tool calls). */
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
   *
   * Pause/resume:
   *   Codex has no native iteration boundary we can hold at, so a pause is
   *   implemented as `turn/interrupt` + a continuation re-prompt on the
   *   SAME thread once the user resumes. This method becomes a small loop:
   *   each iteration starts an app-server turn and awaits its completion,
   *   and on `turn.paused` waits for `resumeResolver` before issuing a
   *   fresh `turn/start` with a continuation message. The gladdis-side
   *   `assistantMessageId` is preserved across iterations, so streamed
   *   deltas keep appending to the same assistant bubble — visually
   *   identical to the gate-based pause used by Anthropic / OpenAI /
   *   Google / Grok. Codex's thread memory carries the work-in-progress
   *   context, so the model picks up where it left off without us having
   *   to replay anything.
   */
  async send(
    req: ChatRequest,
    signal: AbortSignal,
    system?: string,
    useWorkspace = true,
    dynamicToolNames?: ReadonlySet<string>
  ): Promise<string> {
    const server = await this.ensureServer()
    const resolution = await this.threadStore.ensureThread(req, system, useWorkspace, dynamicToolNames)
    const originalUserText =
      [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''

    const { turn, completion: firstCompletion } = this.beginTurn(
      req.requestId,
      resolution.threadId,
      false,
      req.modelId,
      req.conversationId ?? null
    )
    turn.allowedToolNames = dynamicToolNames

    // Abort wins over pause: if the user hits stop while paused, wake the
    // pause waiter too so send() can return promptly. The onAbort hook
    // therefore handles both states.
    const onAbort = (): void => {
      turn.aborted = true
      if (turn.threadId) {
        server.notify('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId })
      }
      turn.done()
      const resolver = turn.resumeResolver
      turn.resumeResolver = null
      if (resolver) resolver()
    }
    if (signal.aborted) {
      this.active.delete(req.requestId)
      return ''
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const posture = this.threadStore.posture(useWorkspace)
    const baseParams: TurnStartParams = {
      threadId: resolution.threadId,
      input: [textInput(originalUserText)],
      cwd: posture.cwd,
      approvalPolicy: posture.approvalPolicy,
      sandboxPolicy: posture.sandboxPolicy,
      model: req.modelId,
      clientUserMessageId: req.requestId,
      serviceTier: serviceTierForModel(req.modelId),
      ...turnReasoningOverrides(this.modelCatalog.get(req.modelId))
    }

    let iterationParams: TurnStartParams = baseParams
    let completion = firstCompletion
    let firstIteration = true

    try {
      while (true) {
        // Per-iteration reset of fields a previous pause may have flipped.
        // text/toolItems intentionally persist so the assistant bubble keeps
        // its existing content as the model picks up.
        turn.paused = false
        turn.resumeResolver = null
        turn.error = null
        turn.turnId = null

        try {
          await requestWithOptimizationFallback(server, 'turn/start', iterationParams)
        } catch (err) {
          // First-turn stale-thread recovery. Only the very first turn/start
          // can fall back to a fresh thread — once we've streamed any text or
          // tool output, recreating the thread would lose context the user
          // can see, so a later failure is a real error.
          if (!firstIteration || !resolution.canRetryFresh || !req.conversationId) throw err
          this.threadStore.forget(req.conversationId, resolution.threadId, useWorkspace)
          const freshThreadId = await this.threadStore.startThread(
            req.conversationId,
            req.modelId,
            system,
            false,
            useWorkspace
          )
          turn.threadId = freshThreadId
          iterationParams = { ...iterationParams, threadId: freshThreadId }
          await requestWithOptimizationFallback(server, 'turn/start', iterationParams)
        }
        firstIteration = false

        await completion

        if (turn.aborted) return turn.text
        if (turn.error) throw turn.error

        if (turn.paused) {
          const autoResume = turn.autoResumeAfterPause
          turn.autoResumeAfterPause = false
          if (!autoResume) {
            // Wait for resume (or abort). resumeResolver is set here so that
            // resumeRequest() can wake us; the abort listener above also wakes
            // us so stop-while-paused exits the loop promptly.
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              turn.resumeResolver = () => {
                turn.resumeResolver = null
                resolve()
              }
            })
          }
          if (signal.aborted) return turn.text

          const queuedContext = this.consumeQueuedUserContext(turn)
          // Build the next iteration: a fresh completion promise plus a
          // continuation prompt that tells Codex to pick up. We keep the
          // same thread so its memory of the in-progress work is intact;
          // the only state the model gets fresh is the new user input.
          completion = this.resetTurnCompletion(turn)
          iterationParams = {
            ...baseParams,
            threadId: turn.threadId ?? baseParams.threadId,
            input: [textInput(buildCodexResumePrompt(queuedContext))]
          }
          continue
        }

        // Normal completion path: schedule background compaction and return.
        if (!turn.aborted && !turn.error) this.compactor.schedule(this.server, turn.threadId)
        return turn.text
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.active.delete(req.requestId)
    }
  }

  /**
   * Pause a Codex turn the user has marked as held in the composer. Returns
   * true if the request is currently a live Codex turn that has now been
   * marked paused; false if the request isn't a Codex turn or is already
   * paused / aborted / completed. Idempotent.
   *
   * The mechanism is `turn/interrupt` + a paused flag the send() loop reads
   * once the interrupt lands. The renderer's assistant bubble keeps its
   * current text and the turn stays "in flight" from its perspective.
   */
  pauseRequest(requestId: string): boolean {
    const turn = this.active.get(requestId)
    if (!turn || turn.aborted || turn.paused) return false
    turn.paused = true
    const server = this.server
    if (server && turn.threadId) {
      server.notify('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId })
    }
    // turn.done() resolves the completion promise the send() loop is
    // currently awaiting; it then sees `turn.paused === true` and falls
    // into the resume-wait branch instead of returning.
    turn.done()
    return true
  }

  interjectRequest(
    requestId: string,
    text: string,
    opts: { autoResume?: boolean } = {}
  ): boolean {
    const clean = text.trim()
    const turn = this.active.get(requestId)
    if (!clean || !turn || turn.aborted) return false
    turn.queuedUserContext.push(clean)
    turn.autoResumeAfterPause = opts.autoResume ?? true
    if (turn.paused) {
      const resolver = turn.resumeResolver
      if (turn.autoResumeAfterPause && resolver) resolver()
      return true
    }
    return this.pauseRequest(requestId)
  }

  /**
   * Resume a previously-paused Codex turn. Returns true if a paused turn
   * was actually unblocked; false otherwise. The send() loop wakes, kicks
   * off a fresh `turn/start` on the same thread with a continuation
   * prompt, and the model picks up from where it left off using its
   * thread-memory of the in-progress work.
   */
  resumeRequest(requestId: string): boolean {
    const turn = this.active.get(requestId)
    if (!turn || !turn.paused) return false
    const resolver = turn.resumeResolver
    if (!resolver) {
      // The pause flag was set but send() hasn't reached the wait yet (the
      // interrupt is still being processed). Clear the paused flag so the
      // loop falls through to the normal completion path when it lands.
      turn.paused = false
      return true
    }
    resolver()
    return true
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
