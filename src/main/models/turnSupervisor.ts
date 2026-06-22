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
  const emitPolicyEvents = (
    events:
      | ReturnType<typeof supervisorIterationStarted>
      | ReturnType<typeof supervisorIterationCompleted>
      | ReturnType<typeof supervisorComplete>
      | ReturnType<typeof supervisorBlocked>
      | ReturnType<typeof supervisorStart>
      | ReturnType<typeof supervisorTransitionEvents>
  ) => {
    for (const event of Array.isArray(events) ? events : [events]) {
      emitLoopState(event)
    }
  }

  return {
    start: (summary = 'Starting agent task loop.', actSummary = 'Entering execution loop.') => {
      emitPolicyEvents(supervisorStart(summary, actSummary))
    },
    iterationStarted: (iteration) => {
      emitPolicyEvents(supervisorIterationStarted(iteration))
    },
    iterationCompleted: (iteration, summary) => {
      emitPolicyEvents(supervisorIterationCompleted(iteration, summary))
    },
    transition: (iteration, next) => {
      emitPolicyEvents(supervisorTransitionEvents(iteration, next))
    },
    complete: (summary = 'Agent task loop completed.') => {
      emitPolicyEvents(supervisorComplete(summary))
    },
    blocked: (reason, aborted = false) => {
      emitPolicyEvents(supervisorBlocked(reason, aborted))
    }
  }
}
