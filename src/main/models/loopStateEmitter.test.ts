import { describe, expect, it, vi } from 'vitest'
import { createLoopStateEmitter, taskIdForRequest, toLoopStateEvent } from './loopStateEmitter'

describe('loopStateEmitter', () => {
  it('derives a stable task id from conversation or request id', () => {
    expect(taskIdForRequest({ requestId: 'req-1', conversationId: 'conv-1' })).toBe('conv-1')
    expect(taskIdForRequest({ requestId: 'req-2', conversationId: '   ' })).toBe('task-req-2')
    expect(taskIdForRequest({ requestId: 'req-3', conversationId: null })).toBe('task-req-3')
  })

  it('wraps supervisor loop events into stream loop_state events', () => {
    expect(
      toLoopStateEvent(
        { requestId: 'req-4', conversationId: 'conv-4' },
        {
          event: 'phase_changed',
          phase: 'act',
          summary: 'Entering execution loop.'
        }
      )
    ).toEqual({
      requestId: 'req-4',
      type: 'loop_state',
      taskId: 'conv-4',
      event: 'phase_changed',
      phase: 'act',
      iteration: 1,
      reason: undefined,
      summary: 'Entering execution loop.'
    })
  })

  it('creates an emitter callback that forwards loop_state events', () => {
    const emit = vi.fn()
    const forward = createLoopStateEmitter({ requestId: 'req-5', conversationId: null }, emit)

    forward({
      event: 'task_completed',
      phase: 'done',
      summary: 'Completed.'
    })

    expect(emit).toHaveBeenCalledWith({
      requestId: 'req-5',
      type: 'loop_state',
      taskId: 'task-req-5',
      event: 'task_completed',
      phase: 'done',
      iteration: 1,
      reason: undefined,
      summary: 'Completed.'
    })
  })
})
