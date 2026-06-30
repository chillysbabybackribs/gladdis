import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../shared/types'
import { ChatStreamIpcBatcher } from './chatStreamIpcBatcher'

describe('ChatStreamIpcBatcher', () => {
  it('coalesces adjacent delta events for the same request and assistant turn', () => {
    vi.useFakeTimers()
    const sent: ChatStreamEvent[] = []
    const batcher = new ChatStreamIpcBatcher((event) => sent.push(event), 16)

    batcher.push({ requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'hel' })
    batcher.push({ requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'lo' })

    expect(sent).toEqual([])

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      { requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'hello' }
    ])
    vi.useRealTimers()
  })

  it('flushes pending text before a structural event for the same request', () => {
    vi.useFakeTimers()
    const sent: ChatStreamEvent[] = []
    const batcher = new ChatStreamIpcBatcher((event) => sent.push(event), 16)

    batcher.push({ requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'alpha ' })
    batcher.push({ requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'beta' })
    batcher.push({
      requestId: 'req-1',
      assistantMessageId: 'a-1',
      type: 'tool_call',
      tool: 'gladdis.memory_read',
      args: {},
      callId: 'tool-1'
    })

    expect(sent).toEqual([
      { requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'alpha beta' },
      {
        requestId: 'req-1',
        assistantMessageId: 'a-1',
        type: 'tool_call',
        tool: 'gladdis.memory_read',
        args: {},
        callId: 'tool-1'
      }
    ])
    vi.useRealTimers()
  })

  it('keeps concurrent requests isolated when flushing one request', () => {
    vi.useFakeTimers()
    const sent: ChatStreamEvent[] = []
    const batcher = new ChatStreamIpcBatcher((event) => sent.push(event), 16)

    batcher.push({ requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'left' })
    batcher.push({ requestId: 'req-2', assistantMessageId: 'a-2', type: 'delta', text: 'right' })
    batcher.push({ requestId: 'req-1', assistantMessageId: 'a-1', type: 'done' })

    expect(sent).toEqual([
      { requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'left' },
      { requestId: 'req-1', assistantMessageId: 'a-1', type: 'done' }
    ])

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      { requestId: 'req-1', assistantMessageId: 'a-1', type: 'delta', text: 'left' },
      { requestId: 'req-1', assistantMessageId: 'a-1', type: 'done' },
      { requestId: 'req-2', assistantMessageId: 'a-2', type: 'delta', text: 'right' }
    ])
    vi.useRealTimers()
  })
})
