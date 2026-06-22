import type { LoopPhase, LoopStateEventName } from '../../../shared/chat'
import type { SupervisorDecisionEvent, SupervisorTransition } from './providers/toolValidation'

export type SupervisorLoopStateEvent = {
  event: LoopStateEventName
  phase: LoopPhase
  iteration?: number
  reason?: string
  summary?: string
}

export function supervisorStart(
  summary = 'Starting agent task loop.',
  actSummary = 'Entering execution loop.'
): SupervisorLoopStateEvent[] {
  return [
    {
      event: 'task_started',
      phase: 'inspect',
      iteration: 1,
      summary
    },
    {
      event: 'phase_changed',
      phase: 'act',
      iteration: 1,
      summary: actSummary
    }
  ]
}

export function supervisorIterationStarted(iteration: number): SupervisorLoopStateEvent {
  return {
    event: 'iteration_started',
    phase: 'act',
    iteration,
    summary: `Iteration ${iteration} started.`
  }
}

export function supervisorIterationCompleted(
  iteration: number,
  summary: string
): SupervisorLoopStateEvent {
  return {
    event: 'iteration_completed',
    phase: 'decide',
    iteration,
    summary
  }
}

export function supervisorTransitionEvents(
  iteration: number,
  transition: SupervisorTransition
): SupervisorLoopStateEvent[] {
  return [
    supervisorIterationCompleted(iteration, transition.iterationSummary),
    ...(transition.decision ? [supervisorDecisionEvent(transition.decision)] : [])
  ]
}

export function supervisorComplete(summary = 'Agent task loop completed.'): SupervisorLoopStateEvent {
  return {
    event: 'task_completed',
    phase: 'done',
    summary
  }
}

export function supervisorBlocked(reason: string, aborted = false): SupervisorLoopStateEvent {
  return {
    event: aborted ? 'task_aborted' : 'task_blocked',
    phase: aborted ? 'handoff' : 'decide',
    reason,
    summary: aborted ? 'Task aborted.' : 'Task blocked before completion.'
  }
}

export function supervisorDecisionEvent(event: SupervisorDecisionEvent): SupervisorLoopStateEvent {
  const { kind, signal, summary } = event
  const phase: LoopPhase =
    kind === 'tool_results_ready'
      ? 'act'
      : kind === 'validation_required'
      ? 'validate'
      : 'decide'
  const loopEvent: LoopStateEventName =
    kind === 'tool_results_ready'
      ? 'phase_changed'
      : signal === 'retry'
      ? 'task_paused'
      : signal === 'finish_with_warning'
      ? 'task_blocked'
      : 'phase_changed'

  return {
    event: loopEvent,
    phase,
    summary
  }
}
