import type { ToolOutcome } from '../browserTools'
import {
  handleNoToolCallsAfterEdits,
  noteToolOutcome,
  type SupervisorTransition,
  type ToolValidationState,
} from './toolValidation'

export async function handleProviderTurnWithoutToolCalls(args: {
  state: ToolValidationState
  toolDefs: { name: string }[]
  turn: number
  requestId: string
  runTool: (name: string, toolArgs: Record<string, unknown>) => Promise<ToolOutcome>
  emitToolCall: (event: {
    requestId: string
    type: 'tool_call'
    tool: string
    args: Record<string, unknown>
    callId: string
  }) => void
  emitToolResult: (event: {
    requestId: string
    type: 'tool_result'
    callId: string
    ok: boolean
    preview: string
    imageDataUrl?: string
  }) => void
  rememberFullResult?: (callId: string, text: string) => void
  transition?: (iteration: number, transition: SupervisorTransition) => void
  appendRetryPrompt: (prompt: string) => void
  emitWarningDelta: (warningDelta: string) => void
}): Promise<'continue' | 'stop'> {
  const decision = await handleNoToolCallsAfterEdits({
    state: args.state,
    toolDefs: args.toolDefs,
    turn: args.turn,
    requestId: args.requestId,
    runTool: args.runTool,
    emitToolCall: args.emitToolCall,
    emitToolResult: args.emitToolResult,
    rememberFullResult: args.rememberFullResult
  })
  if (decision.action === 'retry') {
    args.transition?.(args.turn + 1, decision.transition)
    args.appendRetryPrompt(decision.prompt)
    return 'continue'
  }
  if (decision.action === 'finish_with_warning') {
    args.emitWarningDelta(decision.warningDelta)
  }
  args.transition?.(args.turn + 1, decision.transition)
  return 'stop'
}

export async function executeProviderToolCall(args: {
  requestId: string
  name: string
  toolArgs: Record<string, any>
  callId: string
  runTool: (name: string, toolArgs: Record<string, unknown>) => Promise<ToolOutcome>
  emitToolCall: (event: {
    requestId: string
    type: 'tool_call'
    tool: string
    args: Record<string, unknown>
    callId: string
  }) => void
  emitToolResult: (event: {
    requestId: string
    type: 'tool_result'
    callId: string
    ok: boolean
    preview: string
    imageDataUrl?: string
  }) => void
  rememberFullResult?: (callId: string, text: string) => void
  validationState?: ToolValidationState
  noteValidationOutcome?: boolean
}): Promise<{ name: string; callId: string; outcome: ToolOutcome }> {
  args.emitToolCall({
    requestId: args.requestId,
    type: 'tool_call',
    tool: args.name,
    args: args.toolArgs,
    callId: args.callId
  })
  let outcome: ToolOutcome
  try {
    outcome = await args.runTool(args.name, args.toolArgs)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    outcome = {
      ok: false,
      text: `[tool error] ${detail}`
    }
  }

  args.rememberFullResult?.(args.callId, outcome.text)
  if (args.validationState && args.noteValidationOutcome !== false) {
    noteToolOutcome(args.validationState, args.name, outcome)
  }
  args.emitToolResult({
    requestId: args.requestId,
    type: 'tool_result',
    callId: args.callId,
    ok: outcome.ok,
    preview: outcome.text,
    imageDataUrl: outcome.imageBase64 ? `data:image/png;base64,${outcome.imageBase64}` : undefined
  })
  return {
    name: args.name,
    callId: args.callId,
    outcome
  }
}
