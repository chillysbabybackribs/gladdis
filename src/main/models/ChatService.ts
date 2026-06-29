import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import type { KeyStore } from './KeyStore'
import {
  MODELS,
  isBareContinuation,
  type ChatRequest,
  type ChatStreamEvent,
  type CodexStatus,
  type CodexWorkspace,
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
import { CapabilityBroker } from './capabilities/CapabilityBroker'
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService'
import { ResearchDossierService } from './capabilities/ResearchDossierService'
import { ValidationService } from './capabilities/ValidationService'
import type { LlmComplete, LlmCompleteOptions } from '../pipeline/Planner'
import type { ModelCallLedger } from './ModelCallLedger'
import { ASK_SYSTEM, CODEX_SYSTEM, buildAgentSystem } from './prompts'
import { stripActivePagePreamble } from './routing'
import { openCodexLocalPreviewIfRequested } from './localPreviewBridge'
import { generateChatTitle } from './chatTitleService'
import { runProviderAgenticTurn } from './agentLoopRunner'
import {
  buildContractTrace,
  resolveTurnContextPolicy,
  stripStaleActivePageContext,
  type TurnContextPolicy
} from './turnContextPolicy'
import { createLoopStateEmitter, taskIdForRequest } from './loopStateEmitter'
import { createTurnSupervisor } from './turnSupervisor'
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
const AGENT_OPTIMIZER_MAX_OUTPUT_TOKENS = 2_800
const QUICK_OPTIMIZER_MODEL_ORDER = [
  'openai-gpt-4o-mini',
  'openai-gpt-4-1-mini',
  'openai-gpt-5.4-mini',
  'openai-gpt-5.4-nano',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'grok-build-0.1',
  'grok-4.3',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.5'
] as const

const DEEP_OPTIMIZER_MODEL_ORDER = [
  'claude-opus-4-8',
  'openai-gpt-5.5',
  'openai-gpt-5.4-pro',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'claude-sonnet-4-6',
  'grok-4.3',
  'openai-gpt-5.4',
  'openai-gpt-5.4-mini',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'openai-gpt-4.1-mini',
  'openai-gpt-4o-mini',
  'grok-build-0.1',
  'claude-haiku-4-5',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex'
] as const

// The agent loop is NOT capped by a turn count — it runs until the model stops
// calling tools (goal reached) or the user hits stop (abort signal). Both loops
// check `signal.aborted` every turn and before every tool call, so the user
// always retains control; there is no artificial ceiling on how much work the
// model can do in one request.

export class ChatService {
  private aborts = new Map<string, AbortController>()
  private assistantMessageIds = new Map<string, string>()
  /** Codex starting cwd. Access is always unrestricted full OS-user access. */
  private codexWorkspace: CodexWorkspace = { folder: null }
  /** Lazily-created Codex driver (spawns the app-server on first use). */
  private codexClient: CodexClient | null = null
  private dynamicModels = new Map<string, ModelOption>()
  private readonly toolStarts = new Map<string, number>()
  private readonly capabilityBroker: CapabilityBroker
  private readonly repoIntelligence: RepoIntelligenceService
  private readonly researchDossier: ResearchDossierService
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
        grokKey: () => this.grokKey()
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
      } else {
        throw new Error(`complete() not supported for provider ${model.provider}`)
      }
    } catch (err) {
      throw err
    }
  }

  async optimizeAgent(input: OptimizeAgentInput): Promise<OptimizeAgentResult> {
    const roughPrompt = input.roughPrompt.trim()
    if (!roughPrompt) throw new Error('Agent goal is required.')

    const workspaceRoot = input.workspaceRoot?.trim() || this.tools.getWorkspaceRoot()
    const optimizationMode: 'quick' | 'deep' = input.optimizationMode === 'deep' ? 'deep' : 'quick'
    const model = await this.resolveOptimizerModel(input.modelId, optimizationMode)
    const contextSummary = workspaceRoot
      ? await this.agentOptimizerWorkspaceSummary(workspaceRoot, roughPrompt, optimizationMode)
      : 'No workspace folder is selected. Build a portable task expert from the user goal only.'
    const schemaCompliance = [
      '- Validate that `prompt`, `testTask`, and `optimizationSummary` are present and non-empty.',
      '- If a field is unsupported by your confidence level, omit it rather than inventing placeholders.',
      '- Keep each array field short and specific; trim redundant variants.',
      '- Return valid JSON only.'
    ].join('\n')
    const deepNote =
      optimizationMode === 'deep'
        ? 'Run a distillation pass with deep workspace discovery before drafting the final JSON.'
        : 'Run a lightweight optimization pass focused on stable prompt and command guidance.'

    const system = [
      'You are Gladdis Agent Builder, an expert designer of compact, high-leverage AI agents.',
      'Convert a rough user goal into a saved agent definition that makes the model excellent at directly completing that task.',
      '',
      'Design priorities:',
      '- Optimize for direct task completion at the highest practical quality.',
      '- Minimize token use by front-loading only durable context, constraints, exact targets, and decision rules.',
      '- Do not make the agent rediscover information already supplied by workspace evidence or the user goal.',
      '- Treat exact paths, component names, commands, schemas, domains, APIs, and acceptance checks as valuable context when they are known.',
      '- Keep the agent general enough for the intended task family; do not hard-code a single file workflow unless the goal truly requires it.',
      '- Prefer precise action policy over motivational prose.',
      '- Preserve user intent. Do not invent repository files, APIs, product facts, or requirements.',
      `- Optimize mode: ${optimizationMode}. ${deepNote}`,
      'Schema checks:',
      schemaCompliance,
      '',
      'Return only valid JSON with this shape:',
      '{"name":"short agent name","goal":"user goal","prompt":"system prompt for the saved agent","testTask":"one concise test task","contextSummary":"one sentence on what context was used","notes":["optional short note"],"validationNotes":["optional note"],"preferredTools":["filesystem","shell"],"disallowedTools":[],"knownPaths":["src/"],"knownCommands":["pnpm test"],"workflowSteps":["1) ..."],"verificationSteps":["check ..."],"stopConditions":["..."],"fallbackRules":["..."],"assumptions":["..."],"testTasks":["additional test task"],"optimizationSummary":"what was learned","evidenceNotes":["..."]}'
    ].join('\n')

    const user = JSON.stringify(
      {
        roughGoal: roughPrompt,
        requestedName: input.name?.trim() || null,
        editingExistingAgent: input.existingAgent
          ? {
              id: input.existingAgent.id,
              name: input.existingAgent.name,
              goal: input.existingAgent.goal ?? null,
              roughPrompt: input.existingAgent.roughPrompt ?? null,
              testTask: input.existingAgent.testTask ?? null,
              taskFamily: input.existingAgent.taskFamily ?? null,
              preferredTools: input.existingAgent.preferredTools ?? null,
              disallowedTools: input.existingAgent.disallowedTools ?? null,
              knownPaths: input.existingAgent.knownPaths ?? null,
              knownCommands: input.existingAgent.knownCommands ?? null,
              workflowSteps: input.existingAgent.workflowSteps ?? null,
              verificationSteps: input.existingAgent.verificationSteps ?? null,
              stopConditions: input.existingAgent.stopConditions ?? null,
              fallbackRules: input.existingAgent.fallbackRules ?? null,
              assumptions: input.existingAgent.assumptions ?? null,
              testTasks: input.existingAgent.testTasks ?? null,
              optimizerModelId: input.existingAgent.optimizerModelId ?? null,
              runtimeModelId: input.existingAgent.runtimeModelId ?? null,
              optimizationSummary: input.existingAgent.optimizationSummary ?? null,
              evidenceNotes: input.existingAgent.evidenceNotes ?? null,
              validationNotes: input.existingAgent.validationNotes ?? null
            }
          : null,
        selectedModel: {
          id: model.id,
          label: model.label,
          provider: model.provider
        },
        optimizationMode,
        workspaceEvidence: contextSummary
      },
      null,
      2
    )

    const raw = await this.complete(model.id, system, user, {
      stage: 'agent_optimizer',
      maxOutputTokens: AGENT_OPTIMIZER_MAX_OUTPUT_TOKENS
    })
    const parsed = parseAgentOptimizerJson(raw)
    if (!parsed.prompt.trim()) throw new Error('Agent optimizer returned an empty prompt.')
    return {
      name: parsed.name?.trim() || input.name?.trim() || undefined,
      modelId: model.id,
      prompt: parsed.prompt.trim(),
      testTask: parsed.testTask?.trim() || `Use this agent to complete: ${roughPrompt}`,
      goal: parsed.goal?.trim() || roughPrompt,
      optimizerModelId: parsed.optimizerModelId?.trim() || model.id,
      runtimeModelId: parsed.runtimeModelId?.trim() || model.id,
      taskFamily: parsed.taskFamily?.trim(),
      workspaceBound: parsed.workspaceBound,
      preferredTools: parsed.preferredTools?.filter(Boolean),
      disallowedTools: parsed.disallowedTools?.filter(Boolean),
      knownPaths: parsed.knownPaths?.filter(Boolean),
      knownCommands: parsed.knownCommands?.filter(Boolean),
      workflowSteps: parsed.workflowSteps?.filter(Boolean),
      verificationSteps: parsed.verificationSteps?.filter(Boolean),
      stopConditions: parsed.stopConditions?.filter(Boolean),
      fallbackRules: parsed.fallbackRules?.filter(Boolean),
      assumptions: parsed.assumptions?.filter(Boolean),
      testTasks: parsed.testTasks?.filter(Boolean),
      optimizationSummary: parsed.optimizationSummary?.trim(),
      evidenceNotes: parsed.evidenceNotes?.filter(Boolean),
      validationNotes: parsed.validationNotes?.filter(Boolean),
      contextSummary: parsed.contextSummary?.trim() || contextSummary.split('\n')[0],
      notes: parsed.notes?.filter((note) => note.trim()).map((note) => note.trim()).slice(0, 4),
      source: 'llm'
    }
  }

  private async resolveOptimizerModel(
    preferredModelId: string,
    optimizationMode: 'quick' | 'deep'
  ): Promise<ModelOption> {
    const keyStatus = this.keys.status()
    const codexAvailable = await this.codexOptimizerAvailable()

    const ranking = optimizationMode === 'quick' ? QUICK_OPTIMIZER_MODEL_ORDER : DEEP_OPTIMIZER_MODEL_ORDER
    const candidateModelIds = [
      preferredModelId,
      ...ranking.filter((id) => id !== preferredModelId)
    ]

    for (const modelId of candidateModelIds) {
      const candidate = this.model(modelId)
      if (!candidate) continue
      if (candidate.provider === 'codex') {
        if (codexAvailable) return candidate
      } else if (keyStatus[candidate.provider]) {
        return candidate
      }
    }

    throw new Error(
      `No usable optimizer model available for ${optimizationMode} mode. Configure an API key for Anthropic, Google, OpenAI, or xAI, or install and authenticate Codex.`
    )
  }

  private async codexOptimizerAvailable(): Promise<boolean> {
    try {
      const status = await this.codexStatus()
      return !!status.installed && !!status.authenticated
    } catch {
      return false
    }
  }

  private async agentOptimizerWorkspaceSummary(
    workspaceRoot: string,
    roughPrompt: string,
    optimizationMode: 'quick' | 'deep'
  ): Promise<string> {
    if (optimizationMode === 'quick') {
      return this.agentOptimizerWorkspaceSummaryQuick(workspaceRoot, roughPrompt)
    }
    try {
      return await this.agentOptimizerWorkspaceSummaryDeep(workspaceRoot, roughPrompt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [
        await this.agentOptimizerWorkspaceSummaryQuick(workspaceRoot, roughPrompt),
        'Deep optimize failed; using quick summary as fallback.',
        `Reason: ${message}`
      ].join('\n')
    }
  }

  private async agentOptimizerWorkspaceSummaryQuick(workspaceRoot: string, roughPrompt: string): Promise<string> {
    try {
      const overview = await this.repoIntelligence.repoOverview({
        workspaceRoot,
        focus: roughPrompt
      })
      return [
        `Mode: quick`,
        '--- Workspace summary ---',
        overview.summary
      ].join('\n')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [
        'Mode: quick',
        `Workspace overview unavailable: ${message}`,
        `Focus: ${roughPrompt}`
      ].join('\n')
    }
  }

  private async agentOptimizerWorkspaceSummaryDeep(workspaceRoot: string, roughPrompt: string): Promise<string> {
    const chunks: string[] = ['Mode: deep', '--- Discovery evidence ---']
    const overview = await this.repoIntelligence.repoOverview({
      workspaceRoot,
      focus: roughPrompt
    })
    chunks.push(`Workspace: ${overview.structuredPayload.workspaceRoot}`)
    if (overview.structuredPayload.packageName) {
      chunks.push(`Package: ${overview.structuredPayload.packageName}`)
    }
    if (overview.structuredPayload.packageManager) {
      chunks.push(`Package manager: ${overview.structuredPayload.packageManager}`)
    }
    if (overview.structuredPayload.scripts.length) {
      chunks.push(`Scripts: ${overview.structuredPayload.scripts.slice(0, 12).join(', ')}`)
    }
    chunks.push('--- Repo overview ---')
    chunks.push(overview.summary)

    const searchQueries = [
      roughPrompt,
      `${roughPrompt} tests`,
      `${roughPrompt} package.json scripts`
    ]
    const searchSummaries: string[] = []
    const readSpansInputs: Array<{ path: string; startLine: number; endLine: number }> = []
    for (const query of searchQueries) {
      try {
        const result = await this.repoIntelligence.searchRepo({
          workspaceRoot,
          query,
          maxResults: 6
        })
        searchSummaries.push(`Query: ${query}\n${result.summary}`)
        for (const suggestion of result.structuredPayload.suggestedSpans.slice(0, 2)) {
          readSpansInputs.push({
            path: suggestion.path,
            startLine: suggestion.startLine,
            endLine: suggestion.endLine
          })
        }
      } catch (err) {
        searchSummaries.push(`Query: ${query} (failed: ${err instanceof Error ? err.message : String(err)})`)
      }
    }
    chunks.push('--- Search evidence ---')
    chunks.push(searchSummaries.join('\n\n'))

    try {
      const capped = readSpansInputs.slice(0, 4)
      if (capped.length > 0) {
        const spans = await this.repoIntelligence.readSpans({
          workspaceRoot,
          items: capped
        })
        chunks.push('--- Read spans ---')
        chunks.push(spans.summary)
      }
    } catch (err) {
      chunks.push(`Read spans unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      const dossier = await this.researchDossier.researchDossier({
        workspaceRoot,
        query: roughPrompt,
        maxResults: 12
      })
      chunks.push('--- Research dossier ---')
      chunks.push(dossier.summary)
    } catch (err) {
      chunks.push(`Research dossier unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }

    return chunks.join('\n')
  }

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
    try {
      const policy = resolveTurnContextPolicy(req)
      stripStaleActivePageContext(req, policy)
      this.emitContractTrace(req, policy, model.provider)
      const { actionableText, profile: initialProfile } = policy
      // Run the agentic loop (which carries request_tools) for any real task. The
      // conversation profile normally skips the loop to keep pure chat cheap — but
      // when a workspace folder is selected the user is working on a project, so a
      // "conversation"-classified turn like "what should we install" must be able to
      // escalate into tools instead of dead-ending. Pure chat with no folder open
      // stays plain.
      const hasSelectedFolder = !!this.tools.getWorkspaceRoot()
      const agentic =
        req.mode === 'agent' && (!!req.agent || initialProfile.name !== 'conversation' || hasSelectedFolder)

      if (model.provider === 'codex') {
        // Codex is self-agentic: it owns its shell/file tools via the app-server
        // and streams them as tool chips. Browser/search work flows through the
        // SAME Gladdis browser tools as every other provider, exposed to Codex as
        // gladdis.* dynamic tools that drive the visible tab. The model decides
        // when to use them — no keyword pre-router. The workspace sets cwd only.
        const supervisor = createTurnSupervisor((event) => this.emitLoopState(req, event))
        supervisor.start('Starting Codex task loop.', 'Handing the task to Codex with harness support.')
        const call = this.audit.begin({
          requestId: req.requestId,
          conversationId: req.conversationId,
          provider: 'codex',
          modelId: model.id,
          stage: 'chat:codex',
          input: req.messages
        })
        try {
          const wsBlock = this.workspaceSystemBlock(initialProfile)
          const repoBlock = await this.codexRepoOverviewBlock(req, actionableText)
          const codexSystem = [CODEX_SYSTEM, this.customAgentSystemBlock(req), wsBlock, repoBlock].filter(Boolean).join('\n\n')
          this.logSystemPrompt('codex', 'codex', codexSystem)
          const output = await this.codex().send(
            req,
            controller.signal,
            codexSystem,
            true
          )
          await openCodexLocalPreviewIfRequested({
            req,
            userText: actionableText,
            output,
            tools: this.tools,
            emit: this.emit
          })
          supervisor.complete('Codex task loop completed.')
          call.finish({ output })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          supervisor.blocked(message, controller.signal.aborted)
          call.finish({ status: 'error', error: err })
          throw err
        }
      } else if (model.provider === 'anthropic') {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentAnthropic(req, model.id, controller.signal, browserLlm)
        else await this.streamPlain('anthropic', req, model.id, controller.signal)
      } else if (model.provider === 'openai') {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentOpenAi(req, model.id, controller.signal, browserLlm)
        else await this.streamPlain('openai', req, model.id, controller.signal)
      } else if (model.provider === 'grok') {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentGrok(req, model.id, controller.signal, browserLlm)
        else await this.streamPlain('grok', req, model.id, controller.signal)
      } else {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentGoogle(req, model.id, controller.signal, browserLlm)
        else await this.streamPlain('google', req, model.id, controller.signal)
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

  /* ============================ ASK MODE ============================ */

  /**
   * Dispatch a non-agentic ASK-mode turn to the right provider stream. All
   * four providers accept the same shape modulo client-vs-apiKey + token-cap
   * naming, so we inline the dispatch here instead of carrying four near-
   * identical wrappers.
   */
  private async streamPlain(
    provider: 'anthropic' | 'google' | 'openai' | 'grok',
    req: ChatRequest,
    modelId: string,
    signal: AbortSignal
  ): Promise<void> {
    this.logSystemPrompt(provider, 'plain', ASK_SYSTEM)
    const common = { audit: this.audit, emit: this.emit, req, modelId, signal, system: ASK_SYSTEM }
    switch (provider) {
      case 'anthropic':
        return streamAnthropicPlain({ ...common, client: this.anthropic(), maxTokens: ANTHROPIC_MAX_TOKENS })
      case 'google':
        return streamGooglePlain({ ...common, ai: this.google(), maxOutputTokens: MAX_OUTPUT_TOKENS })
      case 'openai':
        return streamOpenAiPlain({ ...common, apiKey: this.openAiKey(), maxTokens: MAX_OUTPUT_TOKENS })
      case 'grok':
        return streamGrokPlain({ ...common, apiKey: this.grokKey(), maxTokens: MAX_OUTPUT_TOKENS })
    }
  }

  /* ============================ AGENT MODE (Anthropic) ============================ */

  private async agentAnthropic(
    req: ChatRequest,
    modelId: string,
    signal: AbortSignal,
    browserLlm?: LlmComplete
  ): Promise<void> {
    const profile = this.agentToolProfile(req)
    const agentSystem = await this.buildTurnAgentSystem(req, profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    await runProviderAgenticTurn({
      provider: 'anthropic',
      agentSystem,
      workspaceBlock,
      signal,
      supervisor: createTurnSupervisor((event) => this.emitLoopState(req, event)),
      logSystemPrompt: (provider, mode, system) => this.logSystemPrompt(provider, mode, system),
      loop: (supervisor) =>
        runAnthropicToolLoop({
          client: this.anthropic(),
          audit: this.audit,
          emit: this.emit,
          req,
          modelId,
          signal,
          browserLlm,
          tools: this.tools,
          ctx: this.toolContext(req, browserLlm),
          toolDefs: profile.tools,
          agentSystem,
          workspaceBlock,
          maxTokens: ANTHROPIC_MAX_TOKENS,
          keepResults: VERBATIM_TOOL_RESULTS,
          supervisor
        })
    })
  }

  /**
   * Debug: print the EXACT system prompt going to a provider, at the real send
   * point, to the terminal (stderr). Always on.
   */
  private logSystemPrompt(provider: string, mode: string, system: string): void {
    const bar = '='.repeat(78)
    process.stderr.write(
      `\n${bar}\n[SYSTEM PROMPT] provider=${provider} mode=${mode} chars=${system.length}\n${bar}\n` +
        `${system}\n${bar}\n\n`
    )
  }

  /**
   * A short system block naming the user's workspace focus.
   * Relative paths use the selected folder; absolute paths can still reach elsewhere.
   */
  private workspaceSystemBlock(profile?: ReturnType<typeof selectAgentToolProfile>): string | null {
    const folder = this.tools.getWorkspaceRoot()
    if (!folder) return null
    // Lean profiles don't carry filesystem tools yet, but a folder IS selected —
    // tell the model so it escalates (request_tools "filesystem") to act on the
    // project instead of answering generically about it.
    if (profile && profile.name !== 'filesystem' && profile.name !== 'full') {
      return `Workspace: ${folder}\nUse request_tools("filesystem") for repo and shell work.`
    }
    return `Workspace: ${folder}`
  }

  private customAgentSystemBlock(req: ChatRequest): string | null {
    const agent = req.agent
    if (!agent?.prompt.trim()) return null
    const metadata: string[] = []
    const addList = (label: string, values?: string[]) => {
      if (!values?.length) return
      metadata.push(`${label}:`)
      metadata.push(...values.filter(Boolean).map((value) => `- ${value}`))
    }
    const addSection = (label: string, value?: string) => {
      const clean = value?.trim()
      if (clean) metadata.push(`${label}: ${clean}`)
    }
    const addBoolean = (label: string, value?: boolean) => {
      if (typeof value === 'boolean') metadata.push(`${label}: ${value ? 'yes' : 'no'}`)
    }

    addSection('Goal', agent.goal)
    addSection('Optimizer model', agent.optimizerModelId)
    addSection('Runtime model', agent.runtimeModelId)
    addSection('Task family', agent.taskFamily)
    addBoolean('Workspace-bound', agent.workspaceBound)
    addList('Preferred tools', agent.preferredTools)
    addList('Disallowed tools', agent.disallowedTools)
    addList('Known paths', agent.knownPaths)
    addList('Known commands', agent.knownCommands)
    addList('Workflow steps', agent.workflowSteps)
    addList('Verification steps', agent.verificationSteps)
    addList('Stop conditions', agent.stopConditions)
    addList('Fallback rules', agent.fallbackRules)
    addList('Assumptions', agent.assumptions)
    addList('Test tasks', agent.testTasks)
    addSection('Optimization summary', agent.optimizationSummary)
    addList('Evidence notes', agent.evidenceNotes)
    addList('Validation notes', agent.validationNotes)

    const sections = metadata.length ? ['## Agent blueprint', ...metadata, '', ''] : []

    return [
      ...sections,
      '## Selected Custom Agent',
      `Name: ${agent.name}`,
      '',
      agent.prompt.trim()
    ].join('\n')
  }

  private async buildTurnAgentSystem(
    req: ChatRequest,
    tools: Parameters<typeof buildAgentSystem>[0]
  ): Promise<string> {
    const base = await buildAgentSystem(tools)
    return [base, this.customAgentSystemBlock(req)].filter(Boolean).join('\n\n')
  }

  private async codexRepoOverviewBlock(req: ChatRequest, userText: string): Promise<string | null> {
    const workspaceRoot = this.tools.getWorkspaceRoot()
    if (!workspaceRoot) return null
    const result = await this.capabilityBroker.repoOverview(
      {
        requestId: req.requestId,
        assistantMessageId: req.assistantMessageId,
        taskId: taskIdForRequest(req),
        iteration: 1
      },
      {
        workspaceRoot,
        focus: userText.trim() || undefined
      }
    )
    if (!result.ok) return null
    return `Workspace intelligence:\n${result.summary}`
  }

  /** Build the per-request tool context (conversation id + full-result cache). */
  private toolContext(req: ChatRequest, llm?: LlmComplete): ToolContext {
    return {
      tabId: this.tools.tabs.liveTabId(req.tabId),
      requestId: req.requestId,
      assistantMessageId: req.assistantMessageId,
      conversationId: req.conversationId ?? null,
      latestUserText: this.latestSubstantiveUserText(req),
      taskId: taskIdForRequest(req),
      iteration: 1,
      fullResults: new Map<string, string>(),
      // Carried per-request so concurrent chats can run browser turns under
      // different models without racing a shared field (was BrowserTools.setLlm).
      llm,
      // Single centralized fallback: prefer the user-selected folder, drop back
      // to the process cwd only when none is set. This is the only place that
      // should ever default workspaceRoot — memoryStore and any future dreamer
      // require it strictly.
      workspaceRoot: this.tools.getWorkspaceRoot() ?? process.cwd(),
      onProgress: (event) => {
        this.emit({
          requestId: req.requestId,
          type: 'progress_step',
          ...event
        })
      }
    }
  }

  private latestSubstantiveUserText(req: ChatRequest): string {
    const users = [...req.messages].filter((m) => m.role === 'user')
    const current = users.at(-1)
    const currentText = current ? stripActivePagePreamble(current.content).trim() : ''
    if (currentText && !isBareContinuation(currentText)) return currentText
    const previous = users.slice(0, -1).reverse().find((m) => stripActivePagePreamble(m.content).trim())
    return previous ? stripActivePagePreamble(previous.content).trim() : currentText
  }

  private agentToolProfile(req: ChatRequest): ReturnType<typeof selectAgentToolProfile> {
    const last = req.messages[req.messages.length - 1]
    const userText = last?.role === 'user' ? stripActivePagePreamble(last.content) : ''
    // A bare "yes"/"do it"/"wire it up" carries no routing signal, so on its own it
    // collapses to the conversation profile (1 tool) and the model can only TALK about
    // the work it just promised. When the turn is a bare continuation, inherit the
    // previous user turn's profile so the approved action keeps its tools.
    const baseText = isBareContinuation(userText)
      ? [...req.messages].slice(0, -1).reverse().find((m) => m.role === 'user')
        ? stripActivePagePreamble([...req.messages].slice(0, -1).reverse().find((m) => m.role === 'user')!.content)
        : userText
      : userText
    const profile = selectAgentToolProfile(baseText)
    return this.applyAgentToolPolicy(req, profile)
  }

  private applyAgentToolPolicy(
    req: ChatRequest,
    baseProfile: ReturnType<typeof selectAgentToolProfile>
  ): ReturnType<typeof selectAgentToolProfile> {
    const agent = req.agent
    if (!agent) return baseProfile

    const requested = this.agentBlueprintToolConstraints(agent)
    if (!requested) return baseProfile

    const withPolicy = [...baseProfile.tools]
    const used = new Set(withPolicy.map((tool) => tool.name))
    const keepRequestTools = withPolicy.some((tool) => tool.name === 'request_tools')

    for (const name of requested.toAdd) {
      if (used.has(name)) continue
      const tool = knownToolByName(name)
      if (tool && !used.has(tool.name)) {
        withPolicy.push(tool)
        used.add(tool.name)
      }
    }
    if (requested.toRemove.length) {
      for (let i = withPolicy.length - 1; i >= 0; i--) {
        const tool = withPolicy[i]
        if (tool && requested.toRemove.includes(tool.name) && tool.name !== 'request_tools') {
          withPolicy.splice(i, 1)
        }
      }
    }
    if (!withPolicy.some((tool) => tool.name === 'request_tools') && keepRequestTools) {
      const requestTools = knownToolByName('request_tools')
      if (requestTools) withPolicy.push(requestTools)
    }

    return {
      ...baseProfile,
      tools: withPolicy
    }
  }

  private agentBlueprintToolConstraints(agent: { preferredTools?: string[]; disallowedTools?: string[] }): {
    toAdd: string[]
    toRemove: string[]
  } | null {
    const toAdd: string[] = []
    const toRemove: string[] = []

    const normalize = (values?: string[]): string[] => {
      const normalized = (values ?? [])
        .map((value) => normalizeToolName(value))
        .filter((name): name is string => Boolean(name))
      return [...new Set(normalized)]
    }
    for (const value of normalize(agent.preferredTools)) {
      if (knownToolByName(value)) {
        toAdd.push(value)
      }
    }
    for (const value of normalize(agent.disallowedTools)) {
      if (knownToolByName(value)) {
        toRemove.push(value)
      }
    }
    if (!toAdd.length && !toRemove.length) return null
    return { toAdd, toRemove }
  }

  private emitContractTrace(
    req: ChatRequest,
    policy: TurnContextPolicy,
    provider: ModelOption['provider']
  ): void {
    const selectedFolder = this.tools.getWorkspaceRoot()
    this.emit({
      requestId: req.requestId,
      type: 'contract_trace',
      ...buildContractTrace({
        provider,
        profile: policy.profile,
        actionableText: policy.actionableText,
        selectedFolder,
        attachedActivePageContext: policy.hadActivePagePreamble && policy.activePageIntent,
        activePageContextLabel: policy.activePageContextLabel,
        activePageFollowup: policy.activePageFollowup
      })
    })
  }

  /* ============================ AGENT MODE (Google) ============================ */

  private async agentGoogle(
    req: ChatRequest,
    modelId: string,
    signal: AbortSignal,
    browserLlm?: LlmComplete
  ): Promise<void> {
    const profile = this.agentToolProfile(req)
    const agentSystem = await this.buildTurnAgentSystem(req, profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    await runProviderAgenticTurn({
      provider: 'google',
      agentSystem,
      workspaceBlock,
      signal,
      supervisor: createTurnSupervisor((event) => this.emitLoopState(req, event)),
      logSystemPrompt: (provider, mode, system) => this.logSystemPrompt(provider, mode, system),
      loop: (supervisor) =>
        runGoogleToolLoop({
          ai: this.google(),
          audit: this.audit,
          emit: this.emit,
          req,
          modelId,
          signal,
          browserLlm,
          tools: this.tools,
          ctx: this.toolContext(req, browserLlm),
          toolDefs: profile.tools,
          agentSystem,
          workspaceBlock,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          keepResults: VERBATIM_TOOL_RESULTS,
          supervisor
        })
    })
  }

  /* ============================ AGENT MODE (OpenAI) ============================ */

  private async agentOpenAi(
    req: ChatRequest,
    modelId: string,
    signal: AbortSignal,
    browserLlm?: LlmComplete
  ): Promise<void> {
    const profile = this.agentToolProfile(req)
    const agentSystem = await this.buildTurnAgentSystem(req, profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    await runProviderAgenticTurn({
      provider: 'openai',
      agentSystem,
      workspaceBlock,
      signal,
      supervisor: createTurnSupervisor((event) => this.emitLoopState(req, event)),
      logSystemPrompt: (provider, mode, system) => this.logSystemPrompt(provider, mode, system),
      loop: (supervisor) =>
        runOpenAiToolLoop({
          apiKey: this.openAiKey(),
          audit: this.audit,
          emit: this.emit,
          req,
          modelId,
          signal,
          browserLlm,
          tools: this.tools,
          ctx: this.toolContext(req, browserLlm),
          toolDefs: profile.tools,
          agentSystem,
          workspaceBlock,
          maxTokens: MAX_OUTPUT_TOKENS,
          keepResults: VERBATIM_TOOL_RESULTS,
          supervisor
        })
    })
  }

  /* ============================ AGENT MODE (Grok) ============================ */

  private async agentGrok(
    req: ChatRequest,
    modelId: string,
    signal: AbortSignal,
    browserLlm?: LlmComplete
  ): Promise<void> {
    const profile = this.agentToolProfile(req)
    const agentSystem = await this.buildTurnAgentSystem(req, profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    await runProviderAgenticTurn({
      provider: 'grok',
      agentSystem,
      workspaceBlock,
      signal,
      supervisor: createTurnSupervisor((event) => this.emitLoopState(req, event)),
      logSystemPrompt: (provider, mode, system) => this.logSystemPrompt(provider, mode, system),
      loop: (supervisor) =>
        runGrokToolLoop({
          apiKey: this.grokKey(),
          audit: this.audit,
          emit: this.emit,
          req,
          modelId,
          signal,
          browserLlm,
          tools: this.tools,
          ctx: this.toolContext(req, browserLlm),
          toolDefs: profile.tools,
          agentSystem,
          workspaceBlock,
          maxTokens: MAX_OUTPUT_TOKENS,
          keepResults: VERBATIM_TOOL_RESULTS,
          supervisor
        })
    })
  }

  /* ---------------- clients ---------------- */
  private anthropic(): Anthropic {
    const apiKey = this.keys.get('anthropic')
    if (!apiKey) throw new Error('No Anthropic API key configured')
    // SDK retries 429/5xx with backoff (honoring Retry-After) internally; this
    // is the Anthropic/Google equivalent of fetchWithRetry on the raw providers.
    return new Anthropic({ apiKey, maxRetries: 4 })
  }
  private google(): GoogleGenAI {
    const apiKey = this.keys.get('google')
    if (!apiKey) throw new Error('No Google API key configured')
    // SDK already retries 429/5xx with backoff; set attempts explicitly so the
    // safeguard is visible alongside Anthropic's maxRetries and fetchWithRetry.
    return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 5 } } })
  }
  /** OpenAI API key retrieval helper. */
  private openAiKey(): string {
    const apiKey = this.keys.get('openai')
    if (!apiKey) throw new Error('No OpenAI API key configured')
    return apiKey
  }
  /** Grok uses xAI's OpenAI-compatible REST API directly, so we pass the raw key. */
  private grokKey(): string {
    const apiKey = this.keys.get('grok')
    if (!apiKey) throw new Error('No xAI (Grok) API key configured')
    return apiKey
  }
}

function normalizeMaxOutputTokens(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPLETE_MAX_OUTPUT_TOKENS
  return Math.max(1, Math.min(MAX_OUTPUT_TOKENS, Math.floor(value)))
}

interface ParsedAgentOptimizerResult {
  name?: string
  goal?: string
  optimizerModelId?: string
  runtimeModelId?: string
  taskFamily?: string
  workspaceBound?: boolean
  preferredTools?: string[]
  disallowedTools?: string[]
  knownPaths?: string[]
  knownCommands?: string[]
  workflowSteps?: string[]
  verificationSteps?: string[]
  stopConditions?: string[]
  fallbackRules?: string[]
  assumptions?: string[]
  testTasks?: string[]
  optimizationSummary?: string
  evidenceNotes?: string[]
  prompt: string
  testTask?: string
  contextSummary?: string
  notes?: string[]
  validationNotes?: string[]
}

function asStringArray(value: unknown, maxLength = 16): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maxLength)
  return parsed.length ? parsed : undefined
}

function parseAgentOptimizerJson(raw: string): ParsedAgentOptimizerResult {
  const trimmed = raw.trim()
  const jsonText = extractJsonObject(trimmed)
  const parsedJson = JSON.parse(jsonText) as unknown
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('Agent optimizer returned non-object JSON.')
  }
  const parsed: Partial<ParsedAgentOptimizerResult> = parsedJson
  const validationNotes: string[] = []
  if (!Array.isArray(parsed.notes)) {
    validationNotes.push('notes omitted')
  }
  if (typeof parsed.prompt !== 'string') {
    throw new Error('Agent optimizer returned JSON without a prompt.')
  }
  if (!parsed.prompt.trim()) {
    validationNotes.push('prompt was empty')
  }
  const testTask = typeof parsed.testTask === 'string' ? parsed.testTask.trim() : ''
  if (!testTask) {
    validationNotes.push('testTask was missing')
  }
  const normalizedPrompt = parsed.prompt.trim()
  const optimizationSummary = typeof parsed.optimizationSummary === 'string' ? parsed.optimizationSummary.trim() : ''
  if (!optimizationSummary) {
    validationNotes.push('optimizationSummary was missing')
  }
  if (typeof parsed.workspaceBound !== 'undefined' && typeof parsed.workspaceBound !== 'boolean') {
    validationNotes.push('workspaceBound was not boolean and was ignored')
  }

  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    prompt: normalizedPrompt,
    ...(typeof parsed.goal === 'string' ? { goal: parsed.goal } : {}),
    ...(typeof parsed.optimizerModelId === 'string' ? { optimizerModelId: parsed.optimizerModelId } : {}),
    ...(typeof parsed.runtimeModelId === 'string' ? { runtimeModelId: parsed.runtimeModelId } : {}),
    ...(typeof parsed.taskFamily === 'string' ? { taskFamily: parsed.taskFamily } : {}),
    ...(typeof parsed.workspaceBound === 'boolean' ? { workspaceBound: parsed.workspaceBound } : {}),
    ...(asStringArray(parsed.preferredTools) ? { preferredTools: asStringArray(parsed.preferredTools) } : {}),
    ...(asStringArray(parsed.disallowedTools) ? { disallowedTools: asStringArray(parsed.disallowedTools) } : {}),
    ...(asStringArray(parsed.knownPaths, 20) ? { knownPaths: asStringArray(parsed.knownPaths, 20) } : {}),
    ...(asStringArray(parsed.knownCommands, 16) ? { knownCommands: asStringArray(parsed.knownCommands, 16) } : {}),
    ...(asStringArray(parsed.workflowSteps, 12) ? { workflowSteps: asStringArray(parsed.workflowSteps, 12) } : {}),
    ...(asStringArray(parsed.verificationSteps, 12)
      ? { verificationSteps: asStringArray(parsed.verificationSteps, 12) }
      : {}),
    ...(asStringArray(parsed.stopConditions, 12) ? { stopConditions: asStringArray(parsed.stopConditions, 12) } : {}),
    ...(asStringArray(parsed.fallbackRules, 12) ? { fallbackRules: asStringArray(parsed.fallbackRules, 12) } : {}),
    ...(asStringArray(parsed.assumptions, 16) ? { assumptions: asStringArray(parsed.assumptions, 16) } : {}),
    ...(asStringArray(parsed.testTasks, 12) ? { testTasks: asStringArray(parsed.testTasks, 12) } : {}),
    ...(optimizationSummary ? { optimizationSummary } : {}),
    ...(asStringArray(parsed.evidenceNotes, 24) ? { evidenceNotes: asStringArray(parsed.evidenceNotes, 24) } : {}),
    ...(testTask ? { testTask } : {}),
    ...(typeof parsed.contextSummary === 'string'
      ? { contextSummary: parsed.contextSummary.trim() }
      : {}),
    ...(asStringArray(parsed.notes, 8) ? { notes: asStringArray(parsed.notes, 8) } : {}),
    ...(validationNotes.length ? { validationNotes } : {})
  }
}

function extractJsonObject(text: string): string {
  if (text.startsWith('{') && text.endsWith('}')) return text
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return extractJsonObject(fenced[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text
}

function estimateTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / 4)
}
