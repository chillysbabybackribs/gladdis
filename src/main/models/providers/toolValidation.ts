import type { ToolOutcome } from '../browserTools'

export interface ToolValidationState {
  pendingSinceEdit: boolean
  reminderSent: boolean
  autoValidationAttempted: boolean
  lastValidationFailure: string | null
}

export function createToolValidationState(): ToolValidationState {
  return {
    pendingSinceEdit: false,
    reminderSent: false,
    autoValidationAttempted: false,
    lastValidationFailure: null
  }
}

function hasValidationTool(toolDefs: { name: string }[]): boolean {
  return toolDefs.some((tool) => tool.name === 'verify_change' || tool.name === 'run_validation')
}

function preferredValidationTool(toolDefs: { name: string }[]): 'verify_change' | 'run_validation' | null {
  if (toolDefs.some((tool) => tool.name === 'verify_change')) return 'verify_change'
  if (toolDefs.some((tool) => tool.name === 'run_validation')) return 'run_validation'
  return null
}

function validationToolArgs(
  name: 'verify_change' | 'run_validation'
): Record<string, unknown> {
  return name === 'verify_change' ? { check: 'typecheck' } : { check: 'typecheck' }
}

async function runAutomaticValidation(args: {
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
}): Promise<{ attempted: boolean; outcome?: ToolOutcome }> {
  if (!needsValidationBeforeFinal(args.state, args.toolDefs) || args.state.autoValidationAttempted) {
    return { attempted: false }
  }
  args.state.autoValidationAttempted = true
  const validationTool = preferredValidationTool(args.toolDefs)
  if (!validationTool) return { attempted: false }
  const callId = `auto_validation_${args.turn}`
  const toolArgs = validationToolArgs(validationTool)
  args.emitToolCall({
    requestId: args.requestId,
    type: 'tool_call',
    tool: validationTool,
    args: toolArgs,
    callId
  })
  const outcome = await args.runTool(validationTool, toolArgs)
  args.rememberFullResult?.(callId, outcome.text)
  noteToolOutcome(args.state, validationTool, outcome)
  args.emitToolResult({
    requestId: args.requestId,
    type: 'tool_result',
    callId,
    ok: outcome.ok,
    preview: outcome.text,
    imageDataUrl: outcome.imageBase64 ? `data:image/png;base64,${outcome.imageBase64}` : undefined
  })
  return { attempted: true, outcome }
}

export type SupervisorTransition = {
  iterationSummary: string
  decision?: SupervisorDecisionEvent
}

export type ValidationDecision =
  | { action: 'retry'; prompt: string; summary: string; transition: SupervisorTransition }
  | { action: 'finish'; summary: string; transition: SupervisorTransition }
  | { action: 'finish_with_warning'; warningDelta: string; summary: string; transition: SupervisorTransition }

export type ValidationDecisionEvent =
  | { kind: 'validation_required'; signal: 'retry'; summary: string }
  | { kind: 'validation_passed'; signal: 'finish'; summary: string }
  | { kind: 'validation_failed'; signal: 'retry'; summary: string }
  | { kind: 'stopped_without_validation'; signal: 'finish_with_warning'; summary: string }

export type SupervisorDecisionEvent =
  | ValidationDecisionEvent
  | { kind: 'tool_results_ready'; signal: 'retry'; summary: string }

export function continueAfterToolCalls(toolCallCount: number): SupervisorTransition {
  return {
    iterationSummary: `Executed ${toolCallCount} tool call(s).`,
    decision: {
      kind: 'tool_results_ready',
      signal: 'retry',
      summary: 'Tool results are ready; continuing the agent loop.'
    }
  }
}

function transition(args: {
  iterationSummary: string
  decision?: SupervisorDecisionEvent
}): SupervisorTransition {
  return {
    iterationSummary: args.iterationSummary,
    ...(args.decision ? { decision: args.decision } : {})
  }
}

export async function handleNoToolCallsAfterEdits(args: {
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
}): Promise<ValidationDecision> {
  if (needsValidationBeforeFinal(args.state, args.toolDefs) && !args.state.reminderSent) {
    args.state.reminderSent = true
    return {
      action: 'retry',
      summary: 'Validation is required before the turn can finish.',
      prompt: validationInstruction(args.state),
      transition: transition({
        iterationSummary: 'Validation required another pass.',
        decision: {
          kind: 'validation_required',
          signal: 'retry',
          summary: 'Validation is required before the turn can finish.'
        }
      })
    }
  }
  if (needsValidationBeforeFinal(args.state, args.toolDefs) && !args.state.autoValidationAttempted) {
    const auto = await runAutomaticValidation(args)
    if (!auto.attempted) {
      return {
        action: 'finish',
        summary: 'No automatic validation was attempted.',
        transition: transition({
          iterationSummary: 'Model stopped without further tool calls.'
        })
      }
    }
    if (auto.outcome?.ok) {
      return {
        action: 'finish',
        summary: 'Automatic validation passed.',
        transition: transition({
          iterationSummary: 'Model stopped without further tool calls.',
          decision: {
            kind: 'validation_passed',
            signal: 'finish',
            summary: 'Automatic validation passed.'
          }
        })
      }
    }
    return {
      action: 'retry',
      summary: 'Automatic validation failed; another repair pass is required.',
      prompt: `${VALIDATION_FAILED_FINAL}\n\nAutomatic validation result:\n${auto.outcome!.text}`,
      transition: transition({
        iterationSummary: 'Validation required another pass.',
        decision: {
          kind: 'validation_failed',
          signal: 'retry',
          summary: 'Automatic validation failed; another repair pass is required.'
        }
      })
    }
  }
  if (needsValidationBeforeFinal(args.state, args.toolDefs)) {
    return {
      action: 'finish_with_warning',
      summary: VALIDATION_FAILED_FINAL,
      warningDelta: `\n\n${VALIDATION_FAILED_FINAL}`,
      transition: transition({
        iterationSummary: 'Model stopped without further tool calls.',
        decision: {
          kind: 'stopped_without_validation',
          signal: 'finish_with_warning',
          summary: VALIDATION_FAILED_FINAL
        }
      })
    }
  }
  return {
    action: 'finish',
    summary: 'No additional validation work is required.',
    transition: transition({
      iterationSummary: 'Model stopped without further tool calls.'
    })
  }
}

export function noteToolOutcome(
  state: ToolValidationState,
  name: string,
  outcome: Pick<ToolOutcome, 'ok' | 'text'>
): void {
  if (name === 'edit_file' || name === 'write_file') {
    // A failed edit didn't change the file (no-op, missing match, identical
    // strings, etc.). Don't trip pendingSinceEdit — otherwise the supervisor
    // forces a validation pass for nothing and the loop ends in
    // task_blocked even though no real edit landed.
    if (!outcome.ok) return
    state.pendingSinceEdit = true
    state.reminderSent = false
    state.autoValidationAttempted = false
    state.lastValidationFailure = null
    return
  }
  if (name === 'run_validation' || name === 'verify_change') {
    if (outcome.ok) {
      state.pendingSinceEdit = false
      state.reminderSent = false
      state.autoValidationAttempted = false
      state.lastValidationFailure = null
      return
    }

    state.pendingSinceEdit = true
    state.reminderSent = false
    state.lastValidationFailure = outcome.text
  }
}

export function needsValidationBeforeFinal(
  state: ToolValidationState,
  toolDefs: { name: string }[]
): boolean {
  return state.pendingSinceEdit && hasValidationTool(toolDefs)
}

export const VALIDATION_REMINDER =
  'You edited files in this turn. You must call verify_change (preferred) or run_validation with the narrowest relevant check before finalizing. ' +
  'Do not claim the code edit is complete until validation passes.'

export const VALIDATION_REPAIR_REQUIRED =
  'Validation failed after your code edit. You must inspect the failure, fix the issue, and run verify_change (preferred) or run_validation again. ' +
  'Do not produce a successful final answer unless validation passes. If you cannot make validation pass, say why clearly.'

export const VALIDATION_FAILED_FINAL =
  'I edited files, but validation has not passed, so I cannot honestly mark this complete yet.'

function validationInstruction(state: ToolValidationState): string {
  if (!state.lastValidationFailure) return VALIDATION_REMINDER
  return `${VALIDATION_REPAIR_REQUIRED}\n\nLatest validation failure:\n${clipFailure(state.lastValidationFailure)}`
}

function clipFailure(text: string): string {
  const limit = 2000
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[validation output truncated]`
}
