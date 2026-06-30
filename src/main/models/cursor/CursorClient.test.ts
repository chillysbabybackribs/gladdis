import { describe, expect, it } from 'vitest'
import { classifyAssistantEvent } from './CursorClient'

describe('CursorClient assistant stream parsing', () => {
  it('keeps only true streaming deltas and classifies duplicate flushes', () => {
    expect(
      classifyAssistantEvent({
        type: 'assistant',
        timestamp_ms: 1,
        message: { content: [{ type: 'text', text: 'alpha' }] }
      })
    ).toBe('stream_delta')

    expect(
      classifyAssistantEvent({
        type: 'assistant',
        timestamp_ms: 2,
        model_call_id: 'call-1',
        message: { content: [{ type: 'text', text: 'alpha' }] }
      })
    ).toBe('tool_boundary_flush')

    expect(
      classifyAssistantEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'alpha beta' }] }
      })
    ).toBe('final_flush')
  })

  it('treats empty or non-text assistant payloads as ignorable', () => {
    expect(classifyAssistantEvent({ type: 'assistant', timestamp_ms: 1, message: { content: [] } })).toBe('unknown')
    expect(
      classifyAssistantEvent({
        type: 'assistant',
        timestamp_ms: 1,
        message: { content: [{ type: 'tool_use', name: 'read_page' }] }
      })
    ).toBe('unknown')
  })
})
