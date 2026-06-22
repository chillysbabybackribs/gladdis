import { describe, expect, it, vi } from 'vitest'
import {
  continueAfterToolCalls,
  createToolValidationState,
  handleNoToolCallsAfterEdits,
  noteToolOutcome,
} from './toolValidation'

describe('handleNoToolCallsAfterEdits', () => {
  it('returns a reminder prompt before automatic validation', async () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)

    const result = await handleNoToolCallsAfterEdits({
      state,
      toolDefs: [{ name: 'verify_change' }],
      turn: 1,
      requestId: 'req-1',
      runTool: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn()
    })

    expect(result.action).toBe('retry')
    expect(result.action === 'retry' ? result.prompt : '').toContain('You edited files in this turn')
  })

  it('auto-runs validation after reminder and returns repair prompt on failure', async () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)
    state.reminderSent = true
    const runTool = vi.fn(async () => ({ ok: false, text: 'typecheck: fail\nType error' }))
    const result = await handleNoToolCallsAfterEdits({
      state,
      toolDefs: [{ name: 'verify_change' }],
      turn: 2,
      requestId: 'req-2',
      runTool,
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn()
    })

    expect(runTool).toHaveBeenCalledWith('verify_change', { check: 'typecheck' })
    expect(result.action).toBe('retry')
    expect(result.action === 'retry' ? result.prompt : '').toContain('Automatic validation result')
    expect(result.transition).toEqual({
      iterationSummary: 'Validation required another pass.',
      decision: {
        kind: 'validation_failed',
        signal: 'retry',
        summary: 'Automatic validation failed; another repair pass is required.'
      }
    })
  })

  it('returns a finish signal when automatic validation passes', async () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)
    state.reminderSent = true
    const result = await handleNoToolCallsAfterEdits({
      state,
      toolDefs: [{ name: 'verify_change' }],
      turn: 3,
      requestId: 'req-3',
      runTool: vi.fn(async () => ({ ok: true, text: 'typecheck: pass' })),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn()
    })

    expect(result).toEqual({
      action: 'finish',
      summary: 'Automatic validation passed.',
      transition: {
        iterationSummary: 'Model stopped without further tool calls.',
        decision: {
          kind: 'validation_passed',
          signal: 'finish',
          summary: 'Automatic validation passed.'
        }
      }
    })
  })

  it('returns a finish_with_warning signal when validation is still pending after retry', async () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)
    state.reminderSent = true
    state.autoValidationAttempted = true
    const result = await handleNoToolCallsAfterEdits({
      state,
      toolDefs: [{ name: 'verify_change' }],
      turn: 4,
      requestId: 'req-4',
      runTool: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn()
    })

    expect(result.action).toBe('finish_with_warning')
    expect(result.action === 'finish_with_warning' ? result.warningDelta : '').toContain(
      'validation has not passed'
    )
    expect(result.transition).toEqual({
      iterationSummary: 'Model stopped without further tool calls.',
      decision: {
        kind: 'stopped_without_validation',
        signal: 'finish_with_warning',
        summary: 'I edited files, but validation has not passed, so I cannot honestly mark this complete yet.'
      }
    })
  })
})

describe('noteToolOutcome', () => {
  it('ignores failed edit_file outcomes so a no-op edit does not force validation', () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', {
      ok: false,
      text: 'edit_file: old_string equals new_string — nothing to change.'
    } as any)
    expect(state.pendingSinceEdit).toBe(false)
  })

  it('still tracks successful edit_file outcomes', () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)
    expect(state.pendingSinceEdit).toBe(true)
  })

  it('ignores failed write_file outcomes', () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'write_file', { ok: false, text: 'write_file: path is required.' } as any)
    expect(state.pendingSinceEdit).toBe(false)
  })
})

describe('continueAfterToolCalls', () => {
  it('returns an explicit continue decision for tool-result iterations', () => {
    expect(continueAfterToolCalls(2)).toEqual({
      iterationSummary: 'Executed 2 tool call(s).',
      decision: {
        kind: 'tool_results_ready',
        signal: 'retry',
        summary: 'Tool results are ready; continuing the agent loop.'
      }
    })
  })
})
