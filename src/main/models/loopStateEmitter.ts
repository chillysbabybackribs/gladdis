import type { ChatStreamEvent } from '../../../shared/types'
import type { SupervisorLoopStateEvent } from './turnSupervisorPolicy'

export function taskIdForRequest(req: Pick<{ requestId: string; conversationId?: string | null }, 'requestId' | 'conversationId'>): string {
  return req.conversationId?.trim() || `task-${req.requestId}`
}

export function toLoopStateEvent(
  req: Pick<{ requestId: string; conversationId?: string | null }, 'requestId' | 'conversationId'>,
  event: SupervisorLoopStateEvent
): Extract<ChatStreamEvent, { type: 'loop_state' }> {
  return {
    requestId: req.requestId,
    type: 'loop_state',
    taskId: taskIdForRequest(req),
    event: event.event,
    phase: event.phase,
    iteration: event.iteration ?? 1,
    reason: event.reason,
    summary: event.summary
  }
}

export function createLoopStateEmitter(
  req: Pick<{ requestId: string; conversationId?: string | null }, 'requestId' | 'conversationId'>,
  emit: (event: Extract<ChatStreamEvent, { type: 'loop_state' }>) => void
): (event: SupervisorLoopStateEvent) => void {
  return (event) => emit(toLoopStateEvent(req, event))
}
