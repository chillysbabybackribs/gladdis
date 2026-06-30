import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import type { KeyStore } from './KeyStore'
import {
  MODELS,
  isBareContinuation,
  type ChatInterjectionRequest,
  type ChatRequest,
  type ChatStreamEvent,
  type CodexStatus,
  type CodexWorkspace,
  type CursorStatus,
  type DreamAdoptResult,
  type DreamDiff,
  type DreamDiscardResult,
  type DreamProgressEvent,
  type DreamRunRequest,
  type DreamRunResult,
  type DreamStatus,
  type ModelOption,
  type OptimizeAgentInput,
  type OptimizeAgentResult,
} from '../../../shared/types'
import { Dreamer } from './memory/Dreamer'
import { BrowserTools, type ToolContext } from './browserTools'
import {
  knownToolByName,
  normalizeToolName,
  selectAgentToolProfile
} from './agentTools'
import { ChatStore } from './ChatStore'
import { CodexClient } from './codex/CodexClient'
import { ClaudeCodeBridgeServer } from './claudeCode/ClaudeCodeBridgeServer'
import { ClaudeCodeClient } from './claudeCode/ClaudeCodeClient'
import { CursorClient } from './cursor/CursorClient'
import { CapabilityBroker } from './capabilities/CapabilityBroker'
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService'
import { ResearchDossierService } from './capabilities/ResearchDossierService'
import { ValidationService } from './capabilities/ValidationService'
import type { LlmComplete, LlmCompleteOptions } from '../pipeline/Planner'
import type { ModelCallLedger } from './ModelCallLedger'
import { ASK_SYSTEM, CLAUDE_CODE_SYSTEM, CODEX_SYSTEM, buildAgentSystem, buildCursorSystem } from './prompts'
import { stripActivePagePreamble } from './routing'
import { openCodexLocalPreviewIfRequested } from './localPreviewBridge'
import { generateChatTitle } from './chatTitleService'
import { runProviderAgenticTurn } from './agentLoopRunner'
import { runCodexHandoff } from './codex/codexHandoff'
import { dispatchAgenticTurn, dispatchStreamPlain } from './providerRouting'
import { prependDateContextToText } from './providers/dateContext'
import {
  buildContractTrace,
  resolveTurnContextPolicy,
  shouldEnableCursorMcpBridge,
  stripStaleActivePageContext,
  type TurnContextPolicy
} from './turnContextPolicy'
import { createLoopStateEmitter, taskIdForRequest } from './loopStateEmitter'
import { createTurnSupervisor } from './turnSupervisor'
import { AgentOptimizerService } from './AgentOptimizerService'
import { AgentConfigurationService } from './AgentConfigurationService'
import {
  completeAnthropic,
  runAnthropicToolLoop,
  streamAnthropicPlain,
  stubOldResults
} from './providers/anthropic'
import {
  completeGoogle,
  runGoogleToolLoop,
  streamGooglePlain,
  stubOldGoogleResults
} from './providers/google'
import { completeGrok, runGrokToolLoop, streamGrokPlain } from './providers/grok'
import {
  completeOpenAi,
  runOpenAiToolLoop,
  streamOpenAiPlain
} from './providers/openai'
export {
  extractLocalPreviewUrl,
  hasActivePagePreamble,
  isUserFacingLocalPreviewRequest,
  stripActivePagePreamble
} from './routing'
export { stubOldResults } from './providers/anthropic'
export { stubOldGoogleResults } from './providers/google'

const VERBATIM_TOOL_RESULTS = 4

const MAX_OUTPUT_TOKENS = 32_000
const ANTHROPIC_MAX_TOKENS = MAX_OUTPUT_TOKENS
const DEFAULT_COMPLETE_MAX_OUTPUT_TOKENS = 4_096
const EMBEDDED_BROWSER_LLM_MODEL_ORDER = [
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'openai-gpt-4o-mini',
  'openai-gpt-4-1-mini',
  'openai-gpt-5.4-mini',
  'grok-build-0.1',
  'claude-haiku-4-5',
  'claude-sonnet-4-6'
] as const

// The agent loop is NOT capped by a turn count — it runs until the model stops
// calling tools (goal reached) or the user hits stop (abort signal). Both loops
// check `signal.aborted` every turn and before every tool call, so the user
// always retains control; there is no artificial ceiling on how much work the
// model can do in one request.

/**
 * Per-request gate that lets the agent loop hold mid-task at an iteration
 * boundary. While `paused` is true, `wait()` blocks until either `resume()`
 * is called or the supplied `signal` aborts (whichever comes first). This is
 * intentionally not an `AbortController`: pausing must NOT cancel the current
 * model stream — only the next iteration.
 *
 * The gate is allocated lazily on the first pause() so unpaused requests pay
 * nothing. ChatService keeps one per requestId and drops it when the request
 * finishes or aborts.
 */
export class PauseGate {
  private paused = false
  private waiters: Array<() => void> = []

  isPaused(): boolean {
    return this.paused
  }

  pause(): boolean {
    if (this.paused) return false
    this.paused = true
    return true
  }

  resume(): boolean {
    if (!this.paused) return false
    this.paused = false
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
    return true
  }

  /** Wake any waiters (used on abort / request teardown). */
  release(): void {
    this.paused = false
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  /**
   * Block while paused, returning when resumed or aborted. Returning does
   * NOT imply "still running" — the caller must re-check `signal.aborted`
   * before doing more work.
   */
  wait(signal: AbortSignal): Promise<void> {
    if (!this.paused || signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const settle = () => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => settle()
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(settle)
    })
  }
}

export class ChatService {
  private aborts = new Map<string, AbortController>()
  private pauseGates = new Map<string, PauseGate>()
  private queuedInterjections = new Map<string, string[]>()
  private assistantMessageIds = new Map<string, string>()
  /** Codex starting cwd. Access is always unrestricted full OS-user access. */
  private codexWorkspace: CodexWorkspace = { folder: null }
  /** Lazily-created Codex driver (spawns the app-server on first use). */
  private codexClient: CodexClient | null = null
  /** Lazily-created Claude Code driver (spawns the local CLI per turn). */
  private claudeCodeClient: ClaudeCodeClient | null = null
  /** Lazily-created Cursor Agent driver (spawns the local CLI per turn). */
  private cursorClient: CursorClient | null = null
  /** Lazily-created local HTTP MCP server for Claude Code browser/context tools. */
  private claudeCodeBridgeServer: ClaudeCodeBridgeServer | null = null
  private dynamicModels = new Map<string, ModelOption>()
  /** Provider SDK clients, cached by their API key so connection pools persist. */
  private anthropicClient: { key: string; client: Anthropic } | null = null
  private googleClient: { key: string; client: GoogleGenAI } | null = null
  private readonly toolStarts = new Map<string, number>()
  private readonly capabilityBroker: CapabilityBroker
  private readonly repoIntelligence: RepoIntelligenceService
  private readonly researchDossier: ResearchDossierService
  public readonly agentOptimizer: AgentOptimizerService
  public readonly agentConfig: AgentConfigurationService
  /** Lazily-created so unit tests that construct ChatService don't trip on memory I/O. */
  private dreamer: Dreamer | null = null

  constructor(
    private readonly keys: KeyStore,
    private readonly sendStreamEvent: (e: ChatStreamEvent) => void,
    public readonly tools: BrowserTools,
    private readonly audit: ModelCallLedger,
    private readonly chats: ChatStore,
    /**
     * Memory-dream progress sink. Optional so unit tests (and any caller that
     * builds ChatService without the renderer attached) can stay quiet.
     */
    private readonly sendDreamProgress?: (e: DreamProgressEvent) => void
  ) {
    this.repoIntelligence = new RepoIntelligenceService()
    this.researchDossier = new ResearchDossierService(() => this.google(), this.repoIntelligence)
    const validation = new ValidationService()
    this.capabilityBroker = new CapabilityBroker(
      {
        repoOverview: (input) => this.repoIntelligence.repoOverview(input),
        searchRepo: (input) => this.repoIntelligence.searchRepo(input),
        repoGrepTask: (input) => this.repoIntelligence.repoGrepTask(input),
        readSpans: (input) => this.repoIntelligence.readSpans(input),
        researchDossier: (input) => this.researchDossier.researchDossier(input),
        verifyChange: (input) => validation.verifyChange(input)
      },
      this.emit,
      ({ requestId, assistantMessageId, taskId, event, phase, iteration, summary }) =>
        this.emit({
          requestId,
          ...(assistantMessageId ? { assistantMessageId } : {}),
          type: 'loop_state',
          taskId,
          event,
          phase,
          iteration,
          summary
        })
    )
    this.tools.setCapabilityBroker(this.capabilityBroker)
    this.agentOptimizer = new AgentOptimizerService(
      this.keys,
      () => this.codex(),
      this.repoIntelligence,
      this.researchDossier,
      this.tools,
      (id) => this.model(id),
      (modelId, system, user, options) => this.complete(modelId, system, user, options)
    )
    this.agentConfig = new AgentConfigurationService(this.tools, this.repoIntelligence, (e) => this.emit(e))
  }

  private emit = (event: ChatStreamEvent): void => {
    if (event.type === 'tool_call') {
      const startedAt = event.startedAt ?? Date.now()
      this.toolStarts.set(`${event.requestId}:${event.callId}`, startedAt)
      event = { ...event, startedAt }
    } else if (event.type === 'tool_result') {
      const endedAt = event.endedAt ?? Date.now()
      const key = `${event.requestId}:${event.callId}`
      const startedAt = this.toolStarts.get(key)
      this.toolStarts.delete(key)
      event = {
        ...event,
        endedAt,
        durationMs: event.durationMs ?? (startedAt ? Math.max(0, endedAt - startedAt) : undefined)
      }
    } else if (event.type === 'done' || event.type === 'error') {
      const prefix = `${event.requestId}:`
      for (const key of this.toolStarts.keys()) if (key.startsWith(prefix)) this.toolStarts.delete(key)
    }
    const assistantMessageId =
      event.assistantMessageId ?? this.assistantMessageIds.get(event.requestId)
    this.sendStreamEvent(assistantMessageId ? { ...event, assistantMessageId } : event)
  }

  private emitLoopState(
    req: Pick<ChatRequest, 'requestId' | 'conversationId'>,
    event: {
      event:
        | 'task_started'
        | 'phase_changed'
        | 'iteration_started'
        | 'iteration_completed'
        | 'checkpoint_created'
        | 'context_queued'
        | 'context_applied'
        | 'task_paused'
        | 'task_blocked'
        | 'task_completed'
        | 'task_aborted'
      phase: 'inspect' | 'recon' | 'plan' | 'act' | 'validate' | 'decide' | 'handoff' | 'done'
      iteration?: number
      reason?: string
      summary?: string
    }
  ): void {
    createLoopStateEmitter(req, this.emit)(event)
  }

  private model(modelId: string): ModelOption | undefined {
    return MODELS.find((m) => m.id === modelId) ?? this.dynamicModels.get(modelId)
  }

  /** Lazily build the Codex client, sharing one app-server across turns. */
  private codex(): CodexClient {
    if (!this.codexClient) {
      this.codexClient = new CodexClient(
        this.emit,
        () => this.codexWorkspace,
        this.tools,
        {
          get: (conversationId) => this.chats.get(conversationId)?.codexThreadId ?? null,
          set: (conversationId, threadId) => this.chats.setCodexThreadId(conversationId, threadId)
        }
      )
    }
    return this.codexClient
  }

  /** Install + auth status of the local Codex CLI (for the UI). */
  codexStatus(): Promise<CodexStatus> {
    return this.codex().status()
  }

  /** Install + auth status of the local Claude Code CLI (for the UI). */
  claudeCodeStatus(): Promise<CodexStatus> {
    return this.claudeCode().status()
  }

  /** Install + auth status of the local Cursor Agent CLI (for the UI). */
  cursorStatus(): Promise<CursorStatus> {
    return this.cursor().status()
  }

  /**
   * Live Codex model catalog from the app-server's `model/list`, so the picker
   * always matches the installed CLI. Returns [] if Codex isn't reachable; the
   * renderer then falls back to the static codex entries in MODELS.
   */
  codexModels(): Promise<ModelOption[]> {
    return this.codex().listModels().then((models) => {
      for (const model of models) this.dynamicModels.set(model.id, model)
      return models
    })
  }

  /** Current Codex starting cwd choice. */
  getCodexWorkspace(): CodexWorkspace {
    return this.codexWorkspace
  }

  /** Lazily build the Claude Code client. */
  private claudeCode(): ClaudeCodeClient {
    if (!this.claudeCodeClient) {
      this.claudeCodeClient = new ClaudeCodeClient(
        this.emit,
        () => this.tools.getWorkspaceRoot(),
        {
          get: (conversationId) => this.chats.get(conversationId)?.claudeCodeSessionId ?? null,
          set: (conversationId, sessionId) => this.chats.setClaudeCodeSessionId(conversationId, sessionId)
        },
        (args) =>
          this.claudeCodeBridge().registerSession(
            {
              conversationId: args.conversationId,
              modelId: args.modelId,
              requestId: args.requestId,
              browserLlm: (system, user, options) =>
                this.embeddedBrowserLlm(system, user, {
                  ...options,
                  conversationId: null
                })
            }
          )
      )
    }
    return this.claudeCodeClient
  }

  /** Lazily build the Cursor Agent client. */
  private cursor(): CursorClient {
    if (!this.cursorClient) {
      this.cursorClient = new CursorClient(
        this.emit,
        () => this.tools.getWorkspaceRoot(),
        {
          get: (conversationId) => this.chats.get(conversationId)?.cursorSessionId ?? null,
          set: (conversationId, sessionId) => this.chats.setCursorSessionId(conversationId, sessionId)
        },
        (args) => {
          const workdir = this.tools.getWorkspaceRoot() ?? process.cwd()
          return this.claudeCodeBridge().registerSession(
            {
              conversationId: args.conversationId,
              modelId: args.modelId,
              requestId: args.requestId,
              browserLlm: (system, user, options) =>
                this.embeddedBrowserLlm(system, user, {
                  ...options,
                  conversationId: null
                })
            },
            { persistTokenKey: workdir }
          )
        }
      )
    }
    return this.cursorClient
  }

  private claudeCodeBridge(): ClaudeCodeBridgeServer {
    if (!this.claudeCodeBridgeServer) {
      this.claudeCodeBridgeServer = new ClaudeCodeBridgeServer(this.tools, this.emit)
    }
    return this.claudeCodeBridgeServer
  }

  /**
   * Set Codex's starting folder. null => start from the user's home directory.
   * This is not a sandbox; Codex keeps unrestricted read/write OS-user access.
   * Takes effect on the next thread.
   */
  setCodexFolder(folder: string | null): CodexWorkspace {
    this.codexWorkspace = { folder: folder || null }
    return this.codexWorkspace
  }

  abort(requestId: string): void {
    this.aborts.get(requestId)?.abort()
    this.aborts.delete(requestId)
    // Stop trumps pause: wake any waiter so the loop sees the abort flag and
    // exits its iteration check, instead of sitting forever in the gate.
    this.pauseGates.get(requestId)?.release()
    this.pauseGates.delete(requestId)
    this.queuedInterjections.delete(requestId)
  }

  interject(req: ChatInterjectionRequest): boolean {
    const text = req.text.trim()
    const controller = this.aborts.get(req.requestId)
    if (!text || !controller || controller.signal.aborted) return false

    const handledByCodex =
      this.codexClient?.interjectRequest(req.requestId, text, { autoResume: req.autoResume }) ?? false

    if (!handledByCodex) {
      const queued = this.queuedInterjections.get(req.requestId) ?? []
      queued.push(text)
      this.queuedInterjections.set(req.requestId, queued)
    }
    this.emit({
      requestId: req.requestId,
      type: 'loop_state',
      taskId: taskIdForRequest({ requestId: req.requestId, conversationId: null }),
      event: 'context_queued',
      phase: 'decide',
      iteration: 0,
      summary: req.autoResume
        ? 'Context added to the running task; it will continue automatically.'
        : 'Context queued for the next task step.'
    })
    if (!handledByCodex && req.pause) {
      this.pauseRequest(req.requestId)
      if (req.autoResume) this.resumeRequest(req.requestId)
    }
    return true
  }

  /**
   * Pause an in-flight agentic request at the next iteration boundary. Returns
   * true if the request exists and was newly paused; false otherwise (unknown
   * request, already paused, or already finished). The agent loop continues
   * to finish whatever model stream is in flight, then holds before the next
   * iteration. Emits a task_paused loop_state event so the activity panel
   * reflects the hold.
   */
  pauseRequest(requestId: string): boolean {
    const controller = this.aborts.get(requestId)
    if (!controller || controller.signal.aborted) return false
    let gate = this.pauseGates.get(requestId)
    if (!gate) {
      gate = new PauseGate()
      this.pauseGates.set(requestId, gate)
    }
    const gatePaused = gate.pause()
    // Codex and Claude Code turns don't run inside the agent loop gate; each
    // owns its own pause/resume lifecycle. We tell both so whichever one is
    // active handles it. Non-matching requests are silent no-ops.
    const codexPaused = this.codexClient?.pauseRequest(requestId) ?? false
    const claudeCodePaused = this.claudeCodeClient?.pauseRequest(requestId) ?? false
    if (!gatePaused && !codexPaused && !claudeCodePaused) return false
    this.emit({
      requestId,
      type: 'loop_state',
      taskId: taskIdForRequest({ requestId, conversationId: null }),
      event: 'task_paused',
      phase: 'decide',
      iteration: 0,
      summary: codexPaused
        ? 'Task paused — Codex interrupted the in-flight turn. Click resume to continue from the same step.'
        : claudeCodePaused
          ? 'Task paused — Claude Code interrupted the in-flight turn. Click resume to continue from the same step.'
          : 'Task paused — the agent is holding before its next step. Click resume to continue.'
    })
    return true
  }

  /**
   * Resume a previously-paused request. Returns true if a paused request was
   * actually unblocked; false otherwise. The loop wakes on its next gate
   * check and continues from the same iteration, with full message + tool
   * history preserved.
   */
  resumeRequest(requestId: string): boolean {
    const gate = this.pauseGates.get(requestId)
    const gateResumed = gate?.resume() ?? false
    const codexResumed = this.codexClient?.resumeRequest(requestId) ?? false
    const claudeCodeResumed = this.claudeCodeClient?.resumeRequest(requestId) ?? false
    const cursorResumed = this.cursorClient?.resumeRequest(requestId) ?? false
    if (!gateResumed && !codexResumed && !claudeCodeResumed && !cursorResumed) return false
    this.emit({
      requestId,
      type: 'loop_state',
      taskId: taskIdForRequest({ requestId, conversationId: null }),
      event: 'phase_changed',
      phase: 'act',
      iteration: 0,
      summary: codexResumed
        ? 'Task resumed - Codex is picking up the same step it was on when paused.'
        : claudeCodeResumed
          ? 'Task resumed - Claude Code is picking up from the same session.'
          : cursorResumed
            ? 'Task resumed - Cursor Agent is picking up from the same session.'
            : 'Task resumed - the agent is picking up where it left off.'
    })
    return true
  }

  /** Per-request gate accessor used by the dispatch helpers. */
  getPauseGate(requestId: string): PauseGate | null {
    return this.pauseGates.get(requestId) ?? null
  }

  private consumeQueuedInterjection(requestId: string): string | null {
    const queued = this.queuedInterjections.get(requestId)
    if (!queued?.length) return null
    this.queuedInterjections.delete(requestId)
    const text = queued.join('\n\n')
    this.emit({
      requestId,
      type: 'loop_state',
      taskId: taskIdForRequest({ requestId, conversationId: null }),
      event: 'context_applied',
      phase: 'decide',
      iteration: 0,
      summary: 'Queued context applied to the next model step.'
    })
    return [
      '[User context added while this task was running]',
      'Treat this as the latest user guidance. If it corrects the current direction, adjust before taking the next step.',
      '',
      text
    ].join('\n')
  }

  /**
   * Produce a short conversation title from its messages via one cheap,
   * non-streaming call. Delegates to chatTitleService; returns null on any
   * failure so the caller can fall back to the first-message title.
   */
  async generateTitle(
    modelId: string,
    messages: { role: string; text: string }[]
  ): Promise<string | null> {
    const model = this.model(modelId)
    if (!model) return null
    return generateChatTitle({
      model,
      messages,
      deps: {
        audit: this.audit,
        anthropic: () => this.anthropic(),
        google: () => this.google(),
        openAiKey: () => this.openAiKey(),
        grokKey: () => this.grokKey(),
        claudeCodeComplete: (providerModelId, system, user) =>
          this.claudeCode().complete(providerModelId, system, user).then((result) => result.text),
        cursorComplete: (providerModelId, system, user) =>
          this.cursor().complete(providerModelId, system, user).then((result) => result.text)
      }
    })
  }

  /**
   * Memory-Dreaming entry points. The Dreamer is lazy because constructing it
   * just to satisfy the IPC layer at startup would pull in transcripts and
   * memory I/O before the user opens a workspace.
   */
  private getDreamer(): Dreamer {
    if (!this.dreamer) {
      this.dreamer = new Dreamer({
        chats: this.chats,
        complete: (modelId, system, user) => this.complete(modelId, system, user, { stage: 'dream' }),
        getKeyStatus: () => this.keys.status(),
        getDynamicCodexModels: () => this.codexModels().catch(() => [] as ModelOption[]),
        emitProgress: this.sendDreamProgress
      })
    }
    return this.dreamer
  }

  dreamRun(req: DreamRunRequest): Promise<DreamRunResult> {
    return this.getDreamer().run(req, 'manual')
  }

  dreamLoadLast(workspaceRoot: string): Promise<DreamDiff | null> {
    return this.getDreamer().loadLast(workspaceRoot)
  }

  dreamAdopt(
    workspaceRoot: string,
    selection?: import('../../../shared/types').DreamAdoptSelection
  ): Promise<DreamAdoptResult> {
    return this.getDreamer().adopt(workspaceRoot, selection)
  }

  dreamDiscard(workspaceRoot: string): Promise<DreamDiscardResult> {
    return this.getDreamer().discard(workspaceRoot)
  }

  dreamStatus(workspaceRoot: string): DreamStatus {
    return this.getDreamer().status(workspaceRoot)
  }

  /** Public accessor for the lazy Dreamer instance. Used by AutoDreamScheduler. */
  getDreamerInstance(): Dreamer {
    return this.getDreamer()
  }

  /**
   * Run a single, non-streaming text completion with a system instruction and user prompt.
   * Reuses the active provider adapter and handles provider details cleanly.
   */
  async complete(
    modelId: string,
    system: string,
    user: string,
    options: LlmCompleteOptions = {}
  ): Promise<string> {
    const model = this.model(modelId)
    if (!model) throw new Error(`Unknown model ${modelId}`)
    const maxOutputTokens = normalizeMaxOutputTokens(
      options.maxOutputTokens ?? DEFAULT_COMPLETE_MAX_OUTPUT_TOKENS
    )
    if (options.stage) {
      console.log(
        `[llm] ${options.stage} prompt≈${estimateTokens(system, user)} tokens ` +
          `maxOutput=${maxOutputTokens}`
      )
    }
    try {
      if (model.provider === 'anthropic') {
        return completeAnthropic({
          client: this.anthropic(),
          audit: this.audit,
          modelId,
          system,
          user,
          maxOutputTokens,
          stage: options.stage ?? 'complete'
        })
      } else if (model.provider === 'google') {
        return completeGoogle({
          ai: this.google(),
          audit: this.audit,
          modelId,
          system,
          user,
          maxOutputTokens,
          stage: options.stage ?? 'complete'
        })
      } else if (model.provider === 'openai') {
        return completeOpenAi({
          apiKey: this.openAiKey(),
          audit: this.audit,
          modelId,
          system,
          user,
          maxOutputTokens,
          stage: options.stage ?? 'complete',
          conversationId: options.conversationId
        })
      } else if (model.provider === 'grok') {
        return completeGrok({
          apiKey: this.grokKey(),
          audit: this.audit,
          modelId,
          system,
          user,
          maxOutputTokens,
          stage: options.stage ?? 'complete',
          conversationId: options.conversationId
        })
      } else if (model.provider === 'codex') {
        const call = this.audit.begin({
          provider: model.provider,
          modelId,
          stage: options.stage ?? 'complete',
          input: { system, user }
        })
        const text = await this.codex().complete(model.id, system, user)
        call.finish({ output: text })
        return text
      } else if (model.provider === 'claudecode') {
        const call = this.audit.begin({
          provider: model.provider,
          modelId,
          stage: options.stage ?? 'complete',
          input: { system, user }
        })
        const result = await this.claudeCode().complete(
          model.id,
          system,
          user,
          options.conversationId
        )
        call.finish({
          output: result.text,
          usage: {
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            cachedInputTokens: result.usage?.cachedInputTokens
          }
        })
        return result.text
      } else if (model.provider === 'cursor') {
        const call = this.audit.begin({
          provider: model.provider,
          modelId,
          stage: options.stage ?? 'complete',
          input: { system, user }
        })
        const result = await this.cursor().complete(model.id, system, user, options.conversationId)
        call.finish({
          output: result.text,
          usage: {
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            cachedInputTokens: result.usage?.cachedInputTokens
          }
        })
        return result.text
      } else {
        throw new Error(`complete() not supported for provider ${model.provider}`)
      }
    } catch (err) {
      throw err
    }
  }

  /**
   * Send a chat turn. This is the IPC entry point (index.ts → IPC.CHAT_SEND).
   * It owns the per-request lifecycle — abort controller, contract trace, the
   * agentic-vs-plain decision, done/error emission — and delegates the actual
   * provider work to the extracted routers (runCodexHandoff / dispatchAgenticTurn
   * / dispatchStreamPlain), which were pulled out of this method.
   */
  async send(req: ChatRequest): Promise<void> {
    if (req.assistantMessageId) {
      this.assistantMessageIds.set(req.requestId, req.assistantMessageId)
    }
    const model = this.model(req.modelId)
    if (!model) {
      this.emit({ requestId: req.requestId, type: 'error', message: `Unknown model ${req.modelId}` })
      this.assistantMessageIds.delete(req.requestId)
      return
    }
    const controller = new AbortController()
    this.aborts.set(req.requestId, controller)
    // The gate is created lazily by pauseRequest(), but the wait callback
    // resolves immediately when there's no gate, so a never-paused turn
    // pays nothing.
    const waitWhilePaused = (signal: AbortSignal): Promise<void> =>
      this.pauseGates.get(req.requestId)?.wait(signal) ?? Promise.resolve()
    try {
      const policy = resolveTurnContextPolicy(req)
      stripStaleActivePageContext(req, policy)
      this.emitContractTrace(req, policy, model.provider)
      const { profile: initialProfile } = policy
      // Apply date context to local CLI agents (Cursor, Claude Code, Codex) like API providers get via withDateContext
      const actionableText = prependDateContextToText(policy.actionableText)

      // Run the agentic loop (which carries request_tools) for any real task. Pure
      // chat with no folder open stays plain; a workspace folder being open means
      // the user is working on a project, so even a "conversation"-classified turn
      // can escalate into tools instead of dead-ending.
      const hasSelectedFolder = !!this.tools.getWorkspaceRoot()
      const agentic =
        req.mode === 'agent' && (!!req.agent || initialProfile.name !== 'conversation' || hasSelectedFolder)

      if (model.provider === 'codex') {
        await runCodexHandoff(
          req,
          model,
          actionableText,
          initialProfile,
          controller,
          this.codex(),
          this.audit,
          this.tools,
          this.agentConfig,
          (e) => this.emit(e),
          (r, e) => this.emitLoopState(r, e),
          (p, m, s) => this.logSystemPrompt(p, m, s)
        )
      } else if (model.provider === 'claudecode') {
        const resume = isBareContinuation(actionableText)
        const supervisor = createTurnSupervisor((event) => this.emitLoopState(req, event))
        supervisor.start(
          resume ? 'Resuming Claude Code task.' : 'Starting Claude Code task.',
          'Handing the task to the local Claude Code session.'
        )
        const call = this.audit.begin({
          requestId: req.requestId,
          conversationId: req.conversationId,
          provider: 'claudecode',
          modelId: model.id,
          stage: 'chat:claudecode',
          input: req.messages
        })
        try {
          const wsBlock = this.agentConfig.workspaceSystemBlock(initialProfile)
          const repoBlock = await this.agentConfig.codexRepoOverviewBlock(req, actionableText)
          const claudeSystem = [
            CLAUDE_CODE_SYSTEM,
            this.agentConfig.customAgentSystemBlock(req),
            wsBlock,
            repoBlock
          ]
            .filter(Boolean)
            .join('\n\n')
          this.logSystemPrompt('claudecode', 'claudecode', claudeSystem)
          const output = await this.claudeCode().send(req, controller.signal, claudeSystem, actionableText)
          supervisor.complete('Claude Code task completed.')
          call.finish({ output })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          supervisor.blocked(message, controller.signal.aborted)
          call.finish({ status: 'error', error: err })
          throw err
        }
      } else if (model.provider === 'cursor') {
        const resume = isBareContinuation(actionableText)
        const supervisor = createTurnSupervisor((event) => this.emitLoopState(req, event))
        supervisor.start(
          resume ? 'Resuming Cursor Agent task.' : 'Starting Cursor Agent task.',
          'Handing the task to the local Cursor Agent session.'
        )
        const call = this.audit.begin({
          requestId: req.requestId,
          conversationId: req.conversationId,
          provider: 'cursor',
          modelId: model.id,
          stage: 'chat:cursor',
          input: req.messages
        })
        try {
          const enableCursorMcp = shouldEnableCursorMcpBridge(policy)
          const cursorMode: 'ask' | 'agent' = agentic ? 'agent' : 'ask'
          const wsBlock = this.agentConfig.workspaceSystemBlock(initialProfile)
          const cursorSystem = [
            buildCursorSystem({ enableBrowserTools: enableCursorMcp }),
            this.agentConfig.customAgentSystemBlock(req),
            wsBlock
          ].filter(Boolean).join('\n\n')
          // Keep Cursor on the same top-level contract as the API providers:
          // plain/conversation turns stay read-only ask-mode, while agentic
          // turns opt into Cursor's local agent runtime. Browser MCP is a
          // separate policy gate and only comes on when the turn actually needs
          // page/web tools.
          this.logSystemPrompt('cursor', cursorMode, cursorSystem)
          const result = await this.cursor().send(
            req,
            controller.signal,
            cursorSystem,
            actionableText,
            cursorMode,
            { enableBrowserTools: enableCursorMcp }
          )
          supervisor.complete('Cursor Agent task completed.')
          call.finish({
            output: result.text,
            usage: {
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
              cachedInputTokens: result.usage?.cachedInputTokens
            }
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          supervisor.blocked(message, controller.signal.aborted)
          call.finish({ status: 'error', error: err })
          throw err
        }
      } else {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        const client = this.getModelClient(model.provider)
        const dispatchDeps = {
          tools: this.tools,
          agentConfig: this.agentConfig,
          audit: this.audit,
          emit: (e: ChatStreamEvent) => this.emit(e),
          emitLoopState: (r: Pick<ChatRequest, 'requestId' | 'conversationId'>, e: any) =>
            this.emitLoopState(r, e),
          logSystemPrompt: (p: string, m: string, s: string) => this.logSystemPrompt(p, m, s),
          buildToolContext: (r: ChatRequest, llm?: LlmComplete) => this.toolContext(r, llm),
          waitWhilePaused,
          getQueuedContext: () => this.consumeQueuedInterjection(req.requestId)
        }
        if (agentic) {
          await dispatchAgenticTurn({
            req,
            model,
            signal: controller.signal,
            client,
            browserLlm,
            maxOutputTokens: model.provider === 'google' ? MAX_OUTPUT_TOKENS : ANTHROPIC_MAX_TOKENS,
            deps: dispatchDeps
          })
        } else {
          this.logSystemPrompt(model.provider, 'plain', ASK_SYSTEM)
          await dispatchStreamPlain({
            req,
            model,
            signal: controller.signal,
            client,
            system: ASK_SYSTEM,
            maxOutputTokens:
              model.provider === 'anthropic' ? ANTHROPIC_MAX_TOKENS : MAX_OUTPUT_TOKENS,
            deps: { audit: this.audit, emit: (e: ChatStreamEvent) => this.emit(e) }
          })
        }
      }
      this.emit({ requestId: req.requestId, type: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        this.emit({ requestId: req.requestId, type: 'done' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.emit({ requestId: req.requestId, type: 'error', message })
      }
    } finally {
      this.aborts.delete(req.requestId)
      this.assistantMessageIds.delete(req.requestId)
      // Release any lingering gate so a paused request that hits done/error
      // doesn't leak waiters into the next turn.
      this.pauseGates.get(req.requestId)?.release()
      this.pauseGates.delete(req.requestId)
      this.queuedInterjections.delete(req.requestId)
    }
  }

  /**
   * The LLM that drives the browser pipeline for a turn. The model the user
   * PICKED does the work — no silent substitution.
   * For every provider this routes through this.complete(model.id, …), which
   * dispatches anthropic/google directly and codex through the app-server.
   */
  private browserPipelineLlm(
    requestedModel: ModelOption,
    conversationId?: string | null
  ): { model: ModelOption; llm: LlmComplete } {
    return {
      model: requestedModel,
      llm: (system, user, options) =>
        this.complete(requestedModel.id, system, user, {
          ...options,
          conversationId: options?.conversationId ?? conversationId
        })
    }
  }

  private embeddedBrowserLlm(
    system: string,
    user: string,
    options?: LlmCompleteOptions
  ): Promise<string> {
    const model = this.preferredEmbeddedBrowserModel()
    return this.complete(model.id, system, user, options)
  }

  private preferredEmbeddedBrowserModel(): ModelOption {
    const keyStatus = this.keys.status()
    for (const modelId of EMBEDDED_BROWSER_LLM_MODEL_ORDER) {
      const model = this.model(modelId)
      if (!model) continue
      if (model.provider === 'anthropic' && keyStatus.anthropic) return model
      if (model.provider === 'google' && keyStatus.google) return model
      if (model.provider === 'openai' && keyStatus.openai) return model
      if (model.provider === 'grok' && keyStatus.grok) return model
    }
    throw new Error('No API-backed browser helper model is available for embedded MCP tool work')
  }

  /* ============================ ASK MODE ============================ */

  /**
   * Dispatch a non-agentic ASK-mode turn to the right provider stream. All
   * four providers accept the same shape modulo client-vs-apiKey + token-cap
   * naming, so we inline the dispatch here instead of carrying four near-
   * identical wrappers.
   */
  private getModelClient(provider: string): any {
    switch(provider) {
      case 'anthropic': return this.anthropic()
      case 'google': return this.google()
      case 'openai': return this.openAiKey()
      case 'grok': return this.grokKey()
    }
  }

  private logSystemPrompt(provider: string, mode: string, system: string): void {
    // Dev aid only: dumping the full system prompt (tens of KB) to stderr on
    // every turn is a blocking sync write on the hot path. Off unless opted in.
    if (!process.env.GLADDIS_LOG_SYSTEM_PROMPT) return
    const bar = '='.repeat(78)
    process.stderr.write(
      `\n${bar}\n[SYSTEM PROMPT] provider=${provider} mode=${mode} chars=${system.length}\n${bar}\n` +
        `${system}\n${bar}\n\n`
    )
  }

  /* ============================ TEST DELEGATES ============================ */

  private agentToolProfile(req: ChatRequest) {
    return this.agentConfig.agentToolProfile(req)
  }

  private toolContext(req: ChatRequest, llm?: LlmComplete) {
    return this.agentConfig.toolContext(req, llm)
  }

  private latestSubstantiveUserText(req: ChatRequest) {
    return this.agentConfig.latestSubstantiveUserText(req)
  }

  private workspaceSystemBlock(profile?: ReturnType<typeof selectAgentToolProfile>) {
    return this.agentConfig.workspaceSystemBlock(profile)
  }

  private emitContractTrace(req: Pick<ChatRequest, 'requestId'>, policy: TurnContextPolicy, provider: ModelOption['provider']): void {
    const initialProfile = policy.profile
    const { actionableText } = policy
    this.emit({
      requestId: req.requestId,
      type: 'contract_trace',
      ...buildContractTrace({
        provider,
        profile: initialProfile,
        actionableText,
        selectedFolder: this.tools.getWorkspaceRoot(),
        attachedActivePageContext: policy.hadActivePagePreamble,
        activePageContextLabel: policy.activePageContextLabel,
        activePageFollowup: policy.activePageFollowup
      })
    })
  }

  private anthropic(): Anthropic {
    const key = this.keys.get('anthropic')
    if (!key) throw new Error('Anthropic API key not found in KeyStore')
    // Reuse one client per key so the SDK's HTTP keep-alive pool survives across
    // calls. The cache key is the secret itself, so a key change rebuilds the
    // client with no separate invalidation wiring.
    if (this.anthropicClient?.key !== key) {
      this.anthropicClient = { key, client: new Anthropic({ apiKey: key }) }
    }
    return this.anthropicClient.client
  }

  private google(): GoogleGenAI {
    const apiKey = this.keys.get('google')
    if (!apiKey) throw new Error('Google API key not found in KeyStore')
    if (this.googleClient?.key !== apiKey) {
      this.googleClient = { key: apiKey, client: new GoogleGenAI({ apiKey }) }
    }
    return this.googleClient.client
  }

  private openAiKey(): string {
    const key = this.keys.get('openai')
    if (!key) throw new Error('OpenAI API key not found in KeyStore')
    return key
  }

  private grokKey(): string {
    const key = this.keys.get('grok')
    if (!key) throw new Error('xAI/Grok API key not found in KeyStore')
    return key
  }
}

function normalizeMaxOutputTokens(value: number): number {
  return Math.min(Math.max(value, 1), MAX_OUTPUT_TOKENS)
}

function estimateTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / 4)
}
