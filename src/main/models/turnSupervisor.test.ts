import { describe, expect, it, vi } from 'vitest'
import { createLoopStateEmitter } from './loopStateEmitter'
import { createTurnSupervisor } from './turnSupervisor'

function makeHarness(req: { requestId: string; conversationId?: string | null }) {
  const emit = vi.fn()
  const supervisor = createTurnSupervisor(createLoopStateEmitter(req, emit))
  return { emit, supervisor }
}

describe('turnSupervisor', () => {
  it('emits lifecycle events in the expected order', () => {
    const req = { requestId: 'req-supervisor', conversationId: 'conv-supervisor' }
    const { emit, supervisor } = makeHarness(req)

    supervisor.start('Starting shared supervisor.')
    supervisor.iterationStarted(2)
    supervisor.iterationCompleted(2, 'Executed 1 tool call.')
    supervisor.complete('Finished shared supervisor.')

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'task_started',
        phase: 'inspect',
        summary: 'Starting shared supervisor.'
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'phase_changed',
        phase: 'act',
        summary: 'Entering execution loop.'
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'iteration_started',
        phase: 'act',
        iteration: 2
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 2,
        summary: 'Executed 1 tool call.'
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'task_completed',
        phase: 'done',
        summary: 'Finished shared supervisor.'
      })
    ])
  })

  it('supports a custom act-phase summary at startup', () => {
    const req = { requestId: 'req-codex', conversationId: 'conv-codex' }
    const { emit, supervisor } = makeHarness(req)

    supervisor.start('Starting Codex task loop.', 'Handing the task to Codex with harness support.')

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-codex',
        type: 'loop_state',
        taskId: 'conv-codex',
        event: 'task_started',
        phase: 'inspect',
        summary: 'Starting Codex task loop.'
      }),
      expect.objectContaining({
        requestId: 'req-codex',
        type: 'loop_state',
        taskId: 'conv-codex',
        event: 'phase_changed',
        phase: 'act',
        summary: 'Handing the task to Codex with harness support.'
      })
    ])
  })

  it('emits transition follow-up events after iteration completion', () => {
    const req = { requestId: 'req-transition', conversationId: 'conv-transition' }
    const { emit, supervisor } = makeHarness(req)

    supervisor.transition(1, {
      iterationSummary: 'Validation required another pass.',
      decision: {
        kind: 'validation_required',
        signal: 'retry',
        summary: 'Validation is required before the turn can finish.'
      }
    })

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-transition',
        type: 'loop_state',
        taskId: 'conv-transition',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 1,
        summary: 'Validation required another pass.'
      }),
      expect.objectContaining({
        requestId: 'req-transition',
        type: 'loop_state',
        taskId: 'conv-transition',
        event: 'task_paused',
        phase: 'validate',
        summary: 'Validation is required before the turn can finish.'
      })
    ])
  })
})
