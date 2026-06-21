import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ChatStreamEvent } from '../../../shared/types'
import type { Message, ToolActivity } from '../components/chatTypes'
import { appendText } from '../components/chatTypes'

function findAssistantIndex(messages: Message[], assistantMessageId?: string | null): number {
  if (assistantMessageId) {
    return messages.findIndex((message) => message.role === 'assistant' && message.id === assistantMessageId)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i
  }
  return -1
}

export function applyStreamEventToMessages(
  messages: Message[],
  event: ChatStreamEvent,
  fallbackAssistantMessageId?: string | null
): Message[] {
  const targetId = event.assistantMessageId ?? fallbackAssistantMessageId ?? null
  const index = findAssistantIndex(messages, targetId)
  if (index === -1) return messages
  const message = messages[index]
  if (message.role !== 'assistant') return messages
  const parts = message.parts ?? []
  const out = messages.slice()

  if (event.type === 'delta') {
    out[index] = {
      ...message,
      text: message.text + event.text,
      parts: appendText(parts, event.text)
    }
    return out
  }
  if (event.type === 'error') {
    const note = `\n\n> ⚠️ ${event.message}`
    out[index] = {
      ...message,
      text: message.text + note,
      parts: appendText(parts, note)
    }
    return out
  }
  if (event.type === 'contract_trace') {
    out[index] = {
      ...message,
      parts: [...parts, {
        kind: 'contract',
        trace: {
          profile: event.profile,
          tools: event.tools,
          activePage: event.activePage,
          workspace: event.workspace,
          codexCwd: event.codexCwd,
          inputs: event.inputs
        }
      }]
    }
    return out
  }
  if (event.type === 'tool_call') {
    const tool: ToolActivity = {
      callId: event.callId,
      tool: event.tool,
      args: event.args,
      status: 'running',
      startedAt: event.startedAt
    }
    out[index] = { ...message, parts: [...parts, { kind: 'tool', tool }] }
    return out
  }
  if (event.type === 'tool_result') {
    out[index] = {
      ...message,
      parts: parts.map((part) =>
        part.kind === 'tool' && part.tool.callId === event.callId
          ? {
              kind: 'tool',
              tool: {
                ...part.tool,
                status: event.ok ? ('ok' as const) : ('error' as const),
                endedAt: event.endedAt,
                durationMs: event.durationMs,
                preview: event.preview
              }
            }
          : part
      )
    }
    return out
  }
  return messages
}

/** Minimal TTS surface this hook drives, so it doesn't depend on the full hook type. */
interface TtsHandle {
  speak(text: string): void
  flush(): Promise<void> | void
}

interface StreamConsumerArgs {
  /** Id of the in-flight request; events for other ids are ignored. Set to null on done/error. */
  activeReq: RefObject<string | null>
  /** Id of the assistant message receiving the in-flight request. */
  activeAssistantMessageId: RefObject<string | null>
  /** Audible-replies handle; spoken per delta, flushed on done. */
  ttsRef: RefObject<TtsHandle>
  /** Scroll container pinned to the bottom after each committed frame. */
  scrollRef: RefObject<HTMLDivElement | null>
  setMessages: Dispatch<SetStateAction<Message[]>>
  setStreaming: Dispatch<SetStateAction<boolean>>
  /** The streaming-message array, so the scroll effect repins once per committed frame. */
  messages: Message[]
}

/**
 * Consume the model stream and fill the trailing assistant message.
 *
 * Deltas are coalesced to one React commit per animation frame. The SDK emits
 * tokens in rapid bursts, each arriving as its own IPC event (its own event-loop
 * tick, so React can't batch them); rendering each one was the stutter — every
 * token cloned the message list, re-parsed the whole bubble's markdown, and
 * forced a scroll reflow. Buffering a frame's worth of tokens and flushing once
 * caps that work at the display's refresh rate (rendering faster than ~60fps is
 * wasted work that causes the jank, not smoothness). Non-delta events
 * (tool_call/result/error/done) flush the pending buffer first, then apply
 * immediately, so ordering against the streamed text is preserved.
 */
export function useStreamConsumer({
  activeReq,
  activeAssistantMessageId,
  ttsRef,
  scrollRef,
  setMessages,
  setStreaming,
  messages
}: StreamConsumerArgs): void {
  const pendingDelta = useRef('')
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    // Drain buffered delta text into the trailing assistant message in a single
    // state update. Called on the next frame after deltas arrive. Scroll pinning
    // stays in the post-commit effect below so it reads the DOM after React
    // paints the new text — and since messages now changes once per frame, that
    // effect runs once per frame too.
    const flushDeltas = () => {
      rafRef.current = null
      const text = pendingDelta.current
      if (!text) return
      pendingDelta.current = ''
      setMessages((msgs) => {
        return applyStreamEventToMessages(
          msgs,
          {
            requestId: activeReq.current ?? '',
            assistantMessageId: activeAssistantMessageId.current ?? undefined,
            type: 'delta',
            text
          },
          activeAssistantMessageId.current
        )
      })
    }

    const off = window.gladdis.chat.onStream((e) => {
      if (e.requestId !== activeReq.current) return
      // Speak deltas here, NOT inside the setMessages updater — React invokes
      // updaters twice in StrictMode, which would double every spoken fragment.
      if (e.type === 'delta') {
        ttsRef.current.speak(e.text)
        pendingDelta.current += e.text
        if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushDeltas)
        return
      }

      // A non-delta event landed: commit any buffered text first so the tool
      // chip / error / done lands after the prose that preceded it, not before.
      if (pendingDelta.current) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
        flushDeltas()
      }

      setMessages((msgs) => {
        return applyStreamEventToMessages(msgs, e, activeAssistantMessageId.current)
      })
      if (e.type === 'done' || e.type === 'error') {
        if (e.type === 'done') void ttsRef.current.flush()
        activeReq.current = null
        activeAssistantMessageId.current = null
        setStreaming(false)
      }
    })
    return () => {
      off()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    // Refs are stable; setters are stable. Wire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the view pinned to the latest output while streaming. Runs post-commit,
  // so scrollHeight reflects the just-painted text. `messages` now changes once
  // per animation frame during streaming, so this reflows once per frame.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, scrollRef])
}
