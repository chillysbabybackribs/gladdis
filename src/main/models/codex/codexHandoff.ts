import { isBareContinuation, type ChatRequest, type ModelOption } from '../../../../shared/types'
import { createTurnSupervisor } from '../turnSupervisor'
import { buildCodexSystem } from '../prompts'
import { openCodexLocalPreviewIfRequested } from '../localPreviewBridge'
import type { CodexClient } from './CodexClient'
import type { ModelCallLedger } from '../ModelCallLedger'
import type { BrowserTools } from '../browserTools'
import type { AgentConfigurationService, AgentToolSurface } from '../AgentConfigurationService'
import { selectCodexDynamicToolNames } from './dynamicBrowserTools'

export async function runCodexHandoff(
  req: ChatRequest,
  model: ModelOption,
  actionableText: string,
  initialProfile: AgentToolSurface,
  controller: AbortController,
  codex: CodexClient,
  audit: ModelCallLedger,
  tools: BrowserTools,
  agentConfig: AgentConfigurationService,
  emit: (event: any) => void,
  emitLoopState: (req: any, event: any) => void,
  logSystemPrompt: (provider: string, mode: string, system: string) => void
): Promise<void> {
  const resume = isBareContinuation(actionableText)
  const supervisor = createTurnSupervisor((event) => emitLoopState(req, event))
  if (resume) {
    supervisor.start('Resuming Codex task.', 'Recovering context from history.')
  } else {
    supervisor.start('Starting Codex task loop.', 'Handing the task to Codex with harness support.')
  }
  const call = audit.begin({
    requestId: req.requestId,
    conversationId: req.conversationId,
    provider: 'codex',
    modelId: model.id,
    stage: 'chat:codex',
    input: req.messages
  })
  try {
    const dynamicToolNames = selectCodexDynamicToolNames(initialProfile.tools.map((tool) => tool.name))
    const wsBlock = agentConfig.workspaceSystemBlock(initialProfile)
    const repoBlock = await agentConfig.codexRepoOverviewBlock(req, actionableText)
    const codexSystem = [
      buildCodexSystem({ gladdisToolNames: dynamicToolNames }),
      agentConfig.customAgentSystemBlock(req),
      wsBlock,
      repoBlock
    ].filter(Boolean).join('\n\n')
    logSystemPrompt('codex', 'codex', codexSystem)
    const output = await codex.send(
      req,
      controller.signal,
      codexSystem,
      true,
      dynamicToolNames
    )
    await openCodexLocalPreviewIfRequested({
      req,
      userText: actionableText,
      output,
      tools,
      emit
    })
    supervisor.complete('Codex task loop completed.')
    call.finish({ output })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    supervisor.blocked(message, controller.signal.aborted)
    call.finish({ status: 'error', error: err })
    throw err
  }
}
