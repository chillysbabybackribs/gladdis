import type { SupervisorTransition } from './providers/toolValidation'
import {
  supervisorBlocked,
  supervisorComplete,
  supervisorIterationCompleted,
  supervisorIterationStarted,
  supervisorStart,
  supervisorTransitionEvents,
  type SupervisorLoopStateEvent,
} from './turnSupervisorPolicy'

export type TurnSupervisor = {
  start: (summary?: string, actSummary?: string) => void
  iterationStarted: (iteration: number) => void
  iterationCompleted: (iteration: number, summary: string) => void
  transition: (iteration: number, transition: SupervisorTransition) => void
  complete: (summary?: string) => void
  blocked: (reason: string, aborted?: boolean) => void
}

export function createTurnSupervisor(
  emitLoopState: (event: SupervisorLoopStateEvent) => void
): TurnSupervisor {
  return {
    start: (summary = 'Starting agent task loop.', actSummary = 'Entering execution loop.') => {
      for (const event of supervisorStart(summary, actSummary)) emitLoopState(event)
    },
    iterationStarted: (iteration) => {
      emitLoopState(supervisorIterationStarted(iteration))
    },
    iterationCompleted: (iteration, summary) => {
      emitLoopState(supervisorIterationCompleted(iteration, summary))
    },
    transition: (iteration, transition) => {
      for (const event of supervisorTransitionEvents(iteration, transition)) emitLoopState(event)
    },
    complete: (summary = 'Agent task loop completed.') => {
      emitLoopState(supervisorComplete(summary))
    },
    blocked: (reason, aborted = false) => {
      emitLoopState(supervisorBlocked(reason, aborted))
    }
  }
}
