import { describe, expect, it } from 'vitest'
import {
  supervisorBlocked,
  supervisorDecisionEvent,
  supervisorIterationCompleted,
  supervisorStart,
  supervisorTransitionEvents,
} from './turnSupervisorPolicy'

describe('turnSupervisorPolicy', () => {
  it('maps tool-result retries back into the act phase', () => {
    expect(
      supervisorDecisionEvent({
        kind: 'tool_results_ready',
        signal: 'retry',
        summary: 'Tool results are ready; continuing the agent loop.'
      })
    ).toEqual({
      event: 'phase_changed',
      phase: 'act',
      summary: 'Tool results are ready; continuing the agent loop.'
    })
  })

  it('builds transition events by pairing iteration completion with decision mapping', () => {
    expect(
      supervisorTransitionEvents(3, {
        iterationSummary: 'Executed 2 tool call(s).',
        decision: {
          kind: 'validation_failed',
          signal: 'retry',
          summary: 'Automatic validation failed; another repair pass is required.'
        }
      })
    ).toEqual([
      supervisorIterationCompleted(3, 'Executed 2 tool call(s).'),
      {
        event: 'task_paused',
        phase: 'decide',
        summary: 'Automatic validation failed; another repair pass is required.'
      }
    ])
  })

  it('returns the expected startup and blocked policy events', () => {
    expect(supervisorStart('Starting shared supervisor.')).toEqual([
      {
        event: 'task_started',
        phase: 'inspect',
        iteration: 1,
        summary: 'Starting shared supervisor.'
      },
      {
        event: 'phase_changed',
        phase: 'act',
        iteration: 1,
        summary: 'Entering execution loop.'
      }
    ])

    expect(supervisorBlocked('boom', true)).toEqual({
      event: 'task_aborted',
      phase: 'handoff',
      reason: 'boom',
      summary: 'Task aborted.'
    })
  })
})
