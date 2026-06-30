import type { ChatRequest } from '../../../shared/types'
import type { LlmComplete } from './llm'
import type { TurnSupervisor } from './turnSupervisor'

/**
 * Provider-agnostic supervisor wiring shared across every agent loop. The
 * Anthropic / Google / OpenAI / Grok runners all expect this exact pair of
 * callbacks, so we hand it through verbatim.
 */
export interface AgentSupervisorBindings {
  iterationStarted: TurnSupervisor['iterationStarted']
  transition: TurnSupervisor['transition']
}

/**
 * Per-turn shape the four agentic dispatch sites all build before calling
 * the provider-specific tool loop. Centralising it as a type makes the
 * runProviderAgenticTurn signature readable.
 */
export interface AgentTurnContext {
  req: ChatRequest
  modelId: string
  signal: AbortSignal
  browserLlm?: LlmComplete
}

/**
 * Run one provider-agnostic agentic turn. Wraps the ceremony every provider
 * shares — supervisor lifecycle (start → complete | blocked), system-prompt
 * logging, and uniform error funnelling — around the per-provider tool-loop
 * runner injected as `loop`.
 *
 * The provider-specific call site only needs to:
 *   • build its `agentSystem` + `workspaceBlock` strings
 *   • implement `loop(supervisor)` that calls `runXxxToolLoop({...})`
 *
 * Every other knob (audit, emit, signal, supervisor, etc.) is identical
 * across providers so it stays in the caller and gets passed straight through.
 */
export async function runProviderAgenticTurn(args: {
  provider: string
  modelLabel?: string
  resume?: boolean
  agentSystem: string
  workspaceBlock: string | null
  signal: AbortSignal
  supervisor: TurnSupervisor
  logSystemPrompt: (provider: string, mode: string, system: string) => void
  loop: (bindings: AgentSupervisorBindings) => Promise<void>
}): Promise<void> {
  const { provider, modelLabel, resume, agentSystem, workspaceBlock, signal, supervisor, logSystemPrompt, loop } = args
  const displayName = modelLabel ?? provider
  const intro = provider === 'grok'
    ? {
        title: resume ? `Resuming ${displayName} API task.` : `Starting ${displayName} API task.`,
        detail: `Handing the task to the direct ${displayName} API tool loop.`
      }
    : undefined
  supervisor.start(intro?.title, intro?.detail)
  logSystemPrompt(
    provider,
    'agentic',
    workspaceBlock ? `${agentSystem}\n\n${workspaceBlock}` : agentSystem
  )
  try {
    await loop({
      iterationStarted: supervisor.iterationStarted,
      transition: supervisor.transition
    })
    supervisor.complete()
  } catch (err) {
    supervisor.blocked(err instanceof Error ? err.message : String(err), signal.aborted)
    throw err
  }
}
