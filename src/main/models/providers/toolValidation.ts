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

export function hasValidationTool(toolDefs: { name: string }[]): boolean {
  return toolDefs.some((tool) => tool.name === 'run_validation')
}

export function noteToolOutcome(
  state: ToolValidationState,
  name: string,
  outcome: Pick<ToolOutcome, 'ok' | 'text'>
): void {
  if (name === 'edit_file' || name === 'write_file') {
    state.pendingSinceEdit = true
    state.reminderSent = false
    state.autoValidationAttempted = false
    state.lastValidationFailure = null
    return
  }
  if (name === 'run_validation') {
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
  'You edited files in this turn. You must call run_validation with the narrowest relevant check before finalizing. ' +
  'Do not claim the code edit is complete until validation passes.'

export const VALIDATION_REPAIR_REQUIRED =
  'Validation failed after your code edit. You must inspect the failure, fix the issue, and run run_validation again. ' +
  'Do not produce a successful final answer unless validation passes. If you cannot make validation pass, say why clearly.'

export const VALIDATION_FAILED_FINAL =
  'I edited files, but validation has not passed, so I cannot honestly mark this complete yet.'

export function validationInstruction(state: ToolValidationState): string {
  if (!state.lastValidationFailure) return VALIDATION_REMINDER
  return `${VALIDATION_REPAIR_REQUIRED}\n\nLatest validation failure:\n${clipFailure(state.lastValidationFailure)}`
}

function clipFailure(text: string): string {
  const limit = 2000
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[validation output truncated]`
}
