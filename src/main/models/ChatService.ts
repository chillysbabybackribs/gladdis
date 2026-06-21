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
  type ModelOption,
} from '../../../shared/types'
import { BrowserTools, type ToolContext } from './browserTools'
import { selectAgentToolProfile } from './agentTools'
import { ChatStore } from './ChatStore'
import { CodexClient } from './codex/CodexClient'
import type { LlmComplete, LlmCompleteOptions } from '../pipeline/Planner'
import type { ModelCallLedger } from './ModelCallLedger'
import { ASK_SYSTEM, CODEX_SYSTEM, buildAgentSystem } from './prompts'
import {
  extractLocalPreviewUrl,
  isUserFacingLocalPreviewRequest,
  stripActivePagePreamble
} from './routing'
import {
  buildContractTrace,
  resolveTurnContextPolicy,
  stripStaleActivePageContext,
  type TurnContextPolicy
} from './turnContextPolicy'
import {
  completeAnthropic,
  runAnthropicToolLoop,
  streamAnthropicPlain,
  stubOldResults,
  titleAnthropic
} from './providers/anthropic'
import {
  completeGoogle,
  runGoogleToolLoop,
  streamGooglePlain,
  stubOldGoogleResults,
  titleGoogle
} from './providers/google'
import {
  completeGrok,
  runGrokToolLoop,
  streamGrokPlain,
  titleGrok
} from './providers/grok'

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

  constructor(
    private readonly keys: KeyStore,
    private readonly sendStreamEvent: (e: ChatStreamEvent) => void,
    public readonly tools: BrowserTools,
    private readonly audit: ModelCallLedger,
    private readonly chats: ChatStore
  ) {}

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
   * Produce a short (≤6 word) conversation title from its messages via one
   * cheap, non-streaming call. Returns null on any failure so the caller can
   * fall back to the first-message title. Tool chips are ignored — only the
   * user/assistant text matters for a title.
   */
  async generateTitle(modelId: string, messages: { role: string; text: string }[]): Promise<string | null> {
    const model = this.model(modelId)
    if (!model) return null
    // A couple of turns is plenty of signal and keeps the call tiny/cheap.
    const transcript = messages
      .slice(0, 4)
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.text.slice(0, 500)}`)
      .join('\n')
    const instruction =
      'Write a concise title (3-6 words, Title Case, no quotes, no trailing punctuation) ' +
      'for this conversation. Reply with the title only.\n\n' +
      transcript
    try {
      // Codex titles via a cheap provider call aren't available; fall back to
      // the first-message title (return null) for codex-only sessions.
      if (model.provider === 'codex') return null
      const raw =
        model.provider === 'anthropic'
          ? await this.titleAnthropic(model.id, instruction)
          : model.provider === 'grok'
            ? await this.titleGrok(model.id, instruction)
            : await this.titleGoogle(model.id, instruction)
      const title = raw.trim().replace(/^["'\s]+|["'\s.]+$/g, '').replace(/\s+/g, ' ')
      return title || null
    } catch (e) {
      console.warn('[chats] title generation failed:', e)
      return null
    }
  }

  private async titleAnthropic(modelId: string, prompt: string): Promise<string> {
    return titleAnthropic({
      client: this.anthropic(),
      audit: this.audit,
      modelId,
      prompt
    })
  }

  private async titleGoogle(modelId: string, prompt: string): Promise<string> {
    return titleGoogle({
      ai: this.google(),
      audit: this.audit,
      modelId,
      prompt
    })
  }

  private async titleGrok(modelId: string, prompt: string): Promise<string> {
    return titleGrok({
      apiKey: this.grokKey(),
      audit: this.audit,
      modelId,
      prompt
    })
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
        req.mode === 'agent' && (initialProfile.name !== 'conversation' || hasSelectedFolder)

      if (model.provider === 'codex') {
        // Codex is self-agentic: it owns its shell/file tools via the app-server
        // and streams them as tool chips. Browser/search work flows through the
        // SAME Gladdis browser tools as every other provider, exposed to Codex as
        // gladdis.* dynamic tools that drive the visible tab. The model decides
        // when to use them — no keyword pre-router. The workspace sets cwd only.
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
          const codexSystem = wsBlock ? `${CODEX_SYSTEM}\n\n${wsBlock}` : CODEX_SYSTEM
          this.logSystemPrompt('codex', 'codex', codexSystem)
          const output = await this.codex().send(
            req,
            controller.signal,
            codexSystem,
            true
          )
          await this.openCodexLocalPreviewIfRequested(req, actionableText, output)
          call.finish({ output })
        } catch (err) {
          call.finish({ status: 'error', error: err })
          throw err
        }
      } else if (model.provider === 'anthropic') {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentAnthropic(req, model.id, controller.signal, browserLlm)
        else await this.streamAnthropic(req, model.id, controller.signal)
      } else if (model.provider === 'grok') {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentGrok(req, model.id, controller.signal, browserLlm)
        else await this.streamGrok(req, model.id, controller.signal)
      } else {
        const browserLlm = this.browserPipelineLlm(model, req.conversationId).llm
        if (agentic) await this.agentGoogle(req, model.id, controller.signal, browserLlm)
        else await this.streamGoogle(req, model.id, controller.signal)
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

  /**
   * Mixed Codex tasks often need filesystem/shell work first, then a
   * user-facing browser result. When the user's request explicitly asks to view
   * a local preview and Codex reports a localhost URL, make the final handoff
   * visible by navigating Gladdis's active tab.
   */
  private async openCodexLocalPreviewIfRequested(req: ChatRequest, userText: string, output: string): Promise<void> {
    if (!isUserFacingLocalPreviewRequest(userText)) return
    const url = extractLocalPreviewUrl(output)
    if (!url) return

    const tabId = this.tools.tabs.liveTabId(req.tabId)
    const callId = `codex-local-preview-${Date.now()}`
    this.emit({
      requestId: req.requestId,
      type: 'tool_call',
      tool: 'navigate',
      args: { url, owner: 'gladdis', reason: 'codex-local-preview' },
      callId
    })
    this.tools.tabs.navigate(tabId, url)
    this.emit({
      requestId: req.requestId,
      type: 'tool_result',
      callId,
      ok: true,
      preview: `Opened ${url} in the browser.`
    })
    this.emit({
      requestId: req.requestId,
      type: 'delta',
      text: `\nOpened the local preview in the browser: ${url}\n`
    })
    await this.captureLocalPreviewScreenshot(req.requestId, tabId, url)
  }

  private async captureLocalPreviewScreenshot(requestId: string, tabId: string, url: string): Promise<void> {
    const callId = `codex-local-preview-screenshot-${Date.now()}`
    this.emit({
      requestId,
      type: 'tool_call',
      tool: 'screenshot_confirmation',
      args: { url, fullPage: false, reason: 'local-preview-confirmation' },
      callId
    })
    try {
      // Give the WebContentsView a beat to commit the navigation and paint.
      await sleep(800)
      const imageBase64 = await this.tools.tabs.capturePagePng(tabId, false)
      const bytes = Math.round((imageBase64.length * 3) / 4)
      const kb = Math.max(1, Math.round(bytes / 1024))
      this.emit({
        requestId,
        type: 'tool_result',
        callId,
        ok: true,
        preview: `Captured visible screenshot confirmation for ${url} (${kb} KB).`
      })
      this.emit({
        requestId,
        type: 'delta',
        text: `Screenshot confirmation captured for the local preview.\n`
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit({
        requestId,
        type: 'tool_result',
        callId,
        ok: false,
        preview: `Screenshot confirmation failed: ${message}`
      })
      this.emit({
        requestId,
        type: 'delta',
        text: `Screenshot confirmation failed: ${message}\n`
      })
    }
  }

  /* ============================ ASK MODE ============================ */

  private async streamAnthropic(req: ChatRequest, modelId: string, signal: AbortSignal): Promise<void> {
    this.logSystemPrompt('anthropic', 'plain', ASK_SYSTEM)
    return streamAnthropicPlain({
      client: this.anthropic(),
      audit: this.audit,
      emit: this.emit,
      req,
      modelId,
      signal,
      system: ASK_SYSTEM,
      maxTokens: ANTHROPIC_MAX_TOKENS
    })
  }

  private async streamGoogle(req: ChatRequest, modelId: string, signal: AbortSignal): Promise<void> {
    this.logSystemPrompt('google', 'plain', ASK_SYSTEM)
    return streamGooglePlain({
      ai: this.google(),
      audit: this.audit,
      emit: this.emit,
      req,
      modelId,
      signal,
      system: ASK_SYSTEM,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    })
  }

  private async streamGrok(req: ChatRequest, modelId: string, signal: AbortSignal): Promise<void> {
    this.logSystemPrompt('grok', 'plain', ASK_SYSTEM)
    return streamGrokPlain({
      apiKey: this.grokKey(),
      audit: this.audit,
      emit: this.emit,
      req,
      modelId,
      signal,
      system: ASK_SYSTEM,
      maxTokens: MAX_OUTPUT_TOKENS
    })
  }

  /* ============================ AGENT MODE (Anthropic) ============================ */

  private async agentAnthropic(
    req: ChatRequest,
    modelId: string,
    signal: AbortSignal,
    browserLlm?: LlmComplete
  ): Promise<void> {
    const profile = this.agentToolProfile(req)
    const agentSystem = await buildAgentSystem(profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    this.logSystemPrompt('anthropic', 'agentic', workspaceBlock ? `${agentSystem}\n\n${workspaceBlock}` : agentSystem)
    return runAnthropicToolLoop({
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
      keepResults: VERBATIM_TOOL_RESULTS
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
      return (
        `A project folder is selected: ${folder}\n` +
        `If the request is about THIS project (inspect, edit, install, run, optimize), ` +
        `call request_tools("filesystem") and work in it — do not answer generically.`
      )
    }
    return (
      `Working folder: ${folder}\n` +
      `Relative paths in read_file/write_file/edit_file/list_dir/search_files resolve ` +
      `from the selected working folder. Absolute paths can work outside of it.`
    )
  }

  /** Build the per-request tool context (conversation id + full-result cache). */
  private toolContext(req: ChatRequest, llm?: LlmComplete): ToolContext {
    return {
      tabId: this.tools.tabs.liveTabId(req.tabId),
      conversationId: req.conversationId ?? null,
      fullResults: new Map<string, string>(),
      // Carried per-request so concurrent chats can run browser turns under
      // different models without racing a shared field (was BrowserTools.setLlm).
      llm,
      onProgress: (event) => {
        this.emit({
          requestId: req.requestId,
          type: 'progress_step',
          ...event
        })
      }
    }
  }

  private agentToolProfile(req: ChatRequest): ReturnType<typeof selectAgentToolProfile> {
    const last = req.messages[req.messages.length - 1]
    const userText = last?.role === 'user' ? stripActivePagePreamble(last.content) : ''
    // A bare "yes"/"do it"/"wire it up" carries no routing signal, so on its own it
    // collapses to the conversation profile (1 tool) and the model can only TALK about
    // the work it just promised. When the turn is a bare continuation, inherit the
    // previous user turn's profile so the approved action keeps its tools.
    if (isBareContinuation(userText)) {
      const prevUser = [...req.messages].slice(0, -1).reverse().find((m) => m.role === 'user')
      const prevText = prevUser ? stripActivePagePreamble(prevUser.content) : ''
      if (prevText) return selectAgentToolProfile(prevText)
    }
    return selectAgentToolProfile(userText)
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
    const agentSystem = await buildAgentSystem(profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    this.logSystemPrompt('google', 'agentic', workspaceBlock ? `${agentSystem}\n\n${workspaceBlock}` : agentSystem)
    return runGoogleToolLoop({
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
      keepResults: VERBATIM_TOOL_RESULTS
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
    const agentSystem = await buildAgentSystem(profile.tools)
    const workspaceBlock = this.workspaceSystemBlock(profile)
    this.logSystemPrompt('grok', 'agentic', workspaceBlock ? `${agentSystem}\n\n${workspaceBlock}` : agentSystem)
    return runGrokToolLoop({
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
      keepResults: VERBATIM_TOOL_RESULTS
    })
  }

  /* ---------------- clients ---------------- */
  private anthropic(): Anthropic {
    const apiKey = this.keys.get('anthropic')
    if (!apiKey) throw new Error('No Anthropic API key configured')
    return new Anthropic({ apiKey })
  }
  private google(): GoogleGenAI {
    const apiKey = this.keys.get('google')
    if (!apiKey) throw new Error('No Google API key configured')
    return new GoogleGenAI({ apiKey })
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

function estimateTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / 4)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
