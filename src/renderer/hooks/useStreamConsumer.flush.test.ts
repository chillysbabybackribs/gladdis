// @vitest-environment jsdom

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStreamConsumer } from './useStreamConsumer'
import type { ChatStreamEvent } from '../../../shared/types'
import type { Message } from '../components/chatTypes'

/**
 * These tests pin the flush hardening: the consumer must make forward progress
 * even when `requestAnimationFrame` never fires (hidden/occluded window, where
 * Chromium pauses rAF). rAF is stubbed to a no-op here on purpose so the only
 * way events can reach the message list is the timer fallback (for deltas) or
 * the synchronous terminal flush (for done/error).
 */
describe('useStreamConsumer flush liveness', () => {
  let host: HTMLDivElement
  let root: Root
  let listener: ((e: ChatStreamEvent) => void) | null = null
  let off: ReturnType<typeof vi.fn>

  let messages: Message[]
  let setMessages: (updater: Message[] | ((prev: Message[]) => Message[])) => void
  const activeReq = { current: null as string | null }
  const activeAssistantMessageId = { current: null as string | null }
  const activeAssistantIndex = { current: null as number | null }
  const tts = { speak: vi.fn(), flush: vi.fn() }
  const ttsRef = { current: tts }
  const setStreaming = vi.fn()
  const setPaused = vi.fn()
  const onCommit = vi.fn()
  const onTurnEnd = vi.fn()

  function mount() {
    function Harness() {
      useStreamConsumer({
        activeReq,
        activeAssistantMessageId,
        activeAssistantIndex,
        ttsRef,
        setMessages: setMessages as never,
        setStreaming,
        setPaused,
        onCommit,
        onTurnEnd
      })
      return null
    }
    act(() => {
      root.render(createElement(Harness))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    listener = null
    off = vi.fn()
    // rAF is intentionally inert: it returns an id but never invokes the
    // callback, simulating a panel that isn't painting.
    let rafId = 0
    vi.stubGlobal('requestAnimationFrame', () => ++rafId)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    ;(window as unknown as { gladdis: unknown }).gladdis = {
      chat: {
        onStream: (cb: (e: ChatStreamEvent) => void) => {
          listener = cb
          return off
        }
      }
    }

    messages = [
      { id: 'user-1', role: 'user', text: 'hi' },
      { id: 'asst-1', role: 'assistant', text: '', parts: [] }
    ]
    setMessages = (updater) => {
      messages = typeof updater === 'function' ? (updater as (p: Message[]) => Message[])(messages) : updater
    }
    activeReq.current = 'req-1'
    activeAssistantMessageId.current = 'asst-1'
    activeAssistantIndex.current = 1
    tts.speak.mockClear()
    tts.flush.mockClear()
    setStreaming.mockClear()
    setPaused.mockClear()
    onCommit.mockClear()
    onTurnEnd.mockClear()

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('flushes buffered deltas via the timer fallback when rAF never fires', async () => {
    mount()
    act(() => {
      listener?.({ requestId: 'req-1', assistantMessageId: 'asst-1', type: 'delta', text: 'abc' })
    })
    // No rAF callback has run, but the fallback timer must still flush the
    // buffered text as one chunk.
    expect(messages[1].text).toBe('')
    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(messages[1].text).toBe('abc')
    expect(onCommit).toHaveBeenCalled()
  })

  it('applies a terminal event synchronously and settles the turn without a frame', () => {
    mount()
    act(() => {
      listener?.({ requestId: 'req-1', assistantMessageId: 'asst-1', type: 'delta', text: 'hello' })
      listener?.({ requestId: 'req-1', type: 'done' })
    })
    // done flushed immediately: buffered delta is drained and the turn ended,
    // all without advancing rAF or the fallback timer.
    expect(messages[1].text).toBe('hello')
    expect(setStreaming).toHaveBeenCalledWith(false)
    expect(setPaused).toHaveBeenCalledWith(false)
    expect(onTurnEnd).toHaveBeenCalledTimes(1)
    expect(tts.flush).toHaveBeenCalledTimes(1)
    expect(activeReq.current).toBeNull()
    expect(activeAssistantMessageId.current).toBeNull()
  })

  it('settles the turn on a terminal error even when the request id was already cleared', () => {
    mount()
    // Simulate the user hitting stop: activeReq is cleared, but main still emits
    // a terminal event for the now-previous request id.
    act(() => {
      listener?.({ requestId: 'req-1', assistantMessageId: 'asst-1', type: 'delta', text: 'partial' })
    })
    activeReq.current = null
    act(() => {
      listener?.({ requestId: 'req-1', type: 'error', message: 'boom' })
    })
    expect(setStreaming).toHaveBeenCalledWith(false)
    expect(onTurnEnd).toHaveBeenCalled()
  })
})
