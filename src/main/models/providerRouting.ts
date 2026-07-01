import type { ChatMessage, ChatRequest, ModelOption } from '../../../shared/types'
import { runProviderAgenticTurn } from './agentLoopRunner'
import { streamAnthropicPlain, runAnthropicToolLoop } from './providers/anthropic'
import { streamGooglePlain, runGoogleToolLoop } from './providers/google'
import { streamGrokPlain, runGrokToolLoop } from './providers/grok'
import { streamOpenAiPlain, runOpenAiToolLoop } from './providers/openai'
import { createTurnSupervisor } from './turnSupervisor'
import type { BrowserTools, ToolContext } from './browserTools'
import type { AgentConfigurationService } from './AgentConfigurationService'
import type { ModelCallLedger } from './ModelCallLedger'
import type { ChatStreamEvent } from '../../../shared/types'
import type { LlmComplete } from './llm'
import type { AgentToolSurface } from './AgentConfigurationService'

export const VERBATIM_TOOL_RESULTS = 4

function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role === 'user') return msg.content ?? ''
  }
  return ''
}

/**
 * Wiring the dispatchers need from ChatService. These mirror the per-`this`
 * helpers the old inline send() used; passing them in keeps these routers free
 * of a back-reference to ChatService while reproducing the exact same behavior.
 */
export interface DispatchDeps {
  tools: BrowserTools
  agentConfig: AgentConfigurationService
  audit: ModelCallLedger
  emit: (e: ChatStreamEvent) => void
  emitLoopState: (req: Pick<ChatRequest, 'requestId' | 'conversationId'>, e: any) => void
  logSystemPrompt: (provider: string, mode: string, system: string) => void
  /** Per-turn tool context, built with the browser-pipeline LLM bound in. */
  buildToolContext: (req: ChatRequest, browserLlm?: LlmComplete) => ToolContext
  /**
   * Block the caller while the user has the turn paused. Resolves immediately
   * when not paused or once resume() is called. Aborts also wake it; callers
   * must re-check `signal.aborted` after the await. Defaults to a no-op when
   * pause isn't wired (kept optional so unit tests don't have to pass it).
   */
  waitWhilePaused?: (signal: AbortSignal) => Promise<void>
  /** Consume user context queued while the current task was running. */
  getQueuedContext?: () => string | null
}

/**
 * Dispatch a non-agentic plain-text turn to the correct provider stream handler.
 * `client` is the provider client/key from ChatService.getModelClient(): an
 * Anthropic/GoogleGenAI instance for those providers, an API-key string for
 * OpenAI/Grok — matching each streamXxxPlain's first field.
 */
export async function dispatchStreamPlain(args: {
  req: ChatRequest
  model: ModelOption
  signal: AbortSignal
  client: any
  system: string
  maxOutputTokens: number
  deps: Pick<DispatchDeps, 'audit' | 'emit'>
}): Promise<void> {
  const { req, model, signal, client, system, maxOutputTokens, deps } = args
  const base = { audit: deps.audit, emit: deps.emit, req, modelId: model.id, signal, system }
  if (model.provider === 'anthropic') {
    await streamAnthropicPlain({ client, ...base, maxTokens: maxOutputTokens })
  } else if (model.provider === 'google') {
    await streamGooglePlain({ ai: client, ...base, maxOutputTokens })
  } else if (model.provider === 'openai') {
    await streamOpenAiPlain({ apiKey: client, ...base, maxTokens: maxOutputTokens })
  } else if (model.provider === 'grok') {
    await streamGrokPlain({ apiKey: client, ...base, maxTokens: maxOutputTokens })
  } else {
    throw new Error(`Unsupported provider for plain turn: ${model.provider}`)
  }
}

/**
 * Dispatch an agentic turn. Reproduces the old per-provider agentXxx methods:
 * build the tool profile, agent system prompt, workspace block, and tool context,
 * then run the shared supervisor ceremony around the provider-specific tool loop.
 * `browserLlm` is the browser-pipeline LLM (threaded into ctx + each loop) — the
 * piece the earlier extraction sketch dropped.
 */
export async function dispatchAgenticTurn(args: {
  req: ChatRequest
  model: ModelOption
  signal: AbortSignal
  client: any
  browserLlm?: LlmComplete
  maxOutputTokens: number
  profile?: AgentToolSurface
  deps: DispatchDeps
}): Promise<void> {
  const { req, model, signal, client, browserLlm, maxOutputTokens, deps } = args
  const provider = model.provider
  const profile = args.profile ?? await deps.agentConfig.agentToolProfile(req, provider)
  const ctx = deps.buildToolContext(req, browserLlm)
  const agentSystem = await deps.agentConfig.buildTurnAgentSystem(req, profile.tools, provider, ctx)
  const workspaceBlock = deps.agentConfig.workspaceSystemBlock(profile)

  // Shared across every provider loop; only the client field + token field name differ.
  deps.emit({
    requestId: req.requestId,
    type: 'contract_trace',
    provider,
    profile: 'full',
    tools: profile.tools.map((tool) => tool.name),
    toolCount: profile.tools.length
  })

  const common = {
    audit: deps.audit,
    emit: deps.emit,
    req,
    modelId: model.id,
    signal,
    browserLlm,
    tools: deps.tools,
    ctx,
    toolDefs: profile.tools,
    agentSystem,
    workspaceBlock,
    keepResults: VERBATIM_TOOL_RESULTS,
    waitWhilePaused: deps.waitWhilePaused,
    getQueuedContext: deps.getQueuedContext
  }

  await runProviderAgenticTurn({
    provider,
    modelLabel: model.label,
    resume: /^\s*(continue|resume|pick up where we left off|pick up where we were)\b/i.test(latestUserText(req.messages)),
    agentSystem,
    workspaceBlock,
    signal,
    supervisor: createTurnSupervisor((event) => deps.emitLoopState(req, event)),
    logSystemPrompt: deps.logSystemPrompt,
    loop: (supervisor) => {
      switch (provider) {
        case 'anthropic':
          return runAnthropicToolLoop({ client, ...common, maxTokens: maxOutputTokens, supervisor })
        case 'google':
          return runGoogleToolLoop({ ai: client, ...common, maxOutputTokens, supervisor })
        case 'openai':
          return runOpenAiToolLoop({ apiKey: client, ...common, maxTokens: maxOutputTokens, supervisor })
        case 'grok':
          return runGrokToolLoop({ apiKey: client, ...common, maxTokens: maxOutputTokens, supervisor })
        default:
          throw new Error(`Unsupported provider for agent turn: ${provider}`)
      }
    }
  })
}
