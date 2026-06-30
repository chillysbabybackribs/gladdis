import { describe, expect, it, vi } from 'vitest'
import { executeProviderToolCall, handleProviderTurnWithoutToolCalls } from './loopCore'
import { createToolValidationState, noteToolOutcome } from './toolValidation'

describe('handleProviderTurnWithoutToolCalls', () => {
  it('retries by appending the shared validation prompt', async () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)
    const transition = vi.fn()
    const appendRetryPrompt = vi.fn()
    const emitWarningDelta = vi.fn()

    const result = await handleProviderTurnWithoutToolCalls({
      state,
      toolDefs: [{ name: 'verify_change' }],
      turn: 1,
      requestId: 'req-1',
      runTool: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      transition,
      appendRetryPrompt,
      emitWarningDelta
    })

    expect(result).toBe('continue')
    expect(appendRetryPrompt).toHaveBeenCalledWith(expect.stringContaining('You edited files in this turn'))
    expect(transition).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'validation_required', signal: 'retry' })
      })
    )
    expect(emitWarningDelta).not.toHaveBeenCalled()
  })

  it('emits a warning delta before stopping when validation is still pending', async () => {
    const state = createToolValidationState()
    noteToolOutcome(state, 'edit_file', { ok: true, text: 'edited' } as any)
    state.reminderSent = true
    state.autoValidationAttempted = true
    const transition = vi.fn()
    const emitWarningDelta = vi.fn()

    const result = await handleProviderTurnWithoutToolCalls({
      state,
      toolDefs: [{ name: 'verify_change' }],
      turn: 2,
      requestId: 'req-2',
      runTool: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      transition,
      appendRetryPrompt: vi.fn(),
      emitWarningDelta
    })

    expect(result).toBe('stop')
    expect(emitWarningDelta).toHaveBeenCalledWith(expect.stringContaining('validation has not passed'))
    expect(transition).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'stopped_without_validation', signal: 'finish_with_warning' })
      })
    )
  })
})

describe('executeProviderToolCall', () => {
  it('runs shared tool bookkeeping and records validation state by default', async () => {
    const state = createToolValidationState()
    const emitToolCall = vi.fn()
    const emitToolResult = vi.fn()
    const rememberFullResult = vi.fn()
    const runTool = vi.fn(async () => ({ ok: true, text: 'edited' }))

    const result = await executeProviderToolCall({
      requestId: 'req-3',
      name: 'edit_file',
      toolArgs: { path: 'src/a.ts' },
      callId: 'call-1',
      runTool,
      emitToolCall,
      emitToolResult,
      rememberFullResult,
      validationState: state
    })

    expect(runTool).toHaveBeenCalledWith('edit_file', { path: 'src/a.ts' })
    expect(emitToolCall).toHaveBeenCalledWith({
      requestId: 'req-3',
      type: 'tool_call',
      tool: 'edit_file',
      args: { path: 'src/a.ts' },
      callId: 'call-1'
    })
    expect(rememberFullResult).toHaveBeenCalledWith('call-1', 'edited')
    expect(emitToolResult).toHaveBeenCalledWith({
      requestId: 'req-3',
      type: 'tool_result',
      callId: 'call-1',
      ok: true,
      preview: 'edited'
    })
    expect(state.pendingSinceEdit).toBe(true)
    expect(result).toEqual({
      name: 'edit_file',
      callId: 'call-1',
      outcome: { ok: true, text: 'edited' }
    })
  })

  it('can skip validation-state mutation for providers that apply outcomes later', async () => {
    const state = createToolValidationState()

    await executeProviderToolCall({
      requestId: 'req-4',
      name: 'verify_change',
      toolArgs: { check: 'typecheck' },
      callId: 'call-2',
      runTool: vi.fn(async () => ({ ok: true, text: 'typecheck: pass' })),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      validationState: state,
      noteValidationOutcome: false
    })

    expect(state.pendingSinceEdit).toBe(false)
    expect(state.lastValidationFailure).toBe(null)
  })

  it('returns a failed outcome when tool execution throws', async () => {
    const state = createToolValidationState()
    const emitToolCall = vi.fn()
    const emitToolResult = vi.fn()
    const rememberFullResult = vi.fn()
    const runTool = vi.fn(async () => {
      throw new Error('simulated failure')
    })

    const result = await executeProviderToolCall({
      requestId: 'req-5',
      name: 'edit_file',
      toolArgs: { path: 'src/a.ts' },
      callId: 'call-3',
      runTool,
      emitToolCall,
      emitToolResult,
      rememberFullResult,
      validationState: state
    })

    expect(runTool).toHaveBeenCalledWith('edit_file', { path: 'src/a.ts' })
    expect(emitToolResult).toHaveBeenCalledWith({
      requestId: 'req-5',
      type: 'tool_result',
      callId: 'call-3',
      ok: false,
      preview: '[tool error] simulated failure'
    })
    expect(state.lastValidationFailure).toBeNull()
    expect(result).toEqual({
      name: 'edit_file',
      callId: 'call-3',
      outcome: { ok: false, text: '[tool error] simulated failure' }
    })
  })
})
