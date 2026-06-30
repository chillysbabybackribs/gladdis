import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ChatStreamEvent } from '../../../shared/types'
import type { Message, ToolActivity } from '../components/chatTypes'
import { appendText } from '../components/chatTypes'

const noop = () => {}

function findAssistantIndex(messages: Message[], assistantMessageId?: string | null): number {
  if (assistantMessageId) {
    return messages.findIndex((message) => message.role === 'assistant' && message.id === assistantMessageId)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i
  }
  return -1
}

function commitLiveText(message: Message): Message {
  if (!message.liveText) return message
  return {
    ...message,
    liveText: undefined,
    parts: appendText(message.parts ?? [], message.liveText)
  }
}

export function applyStreamEventToMessages(
  messages: Message[],
  event: ChatStreamEvent,
  fallbackAssistantMessageId?: string | null
): Message[] {
  const targetId = event.assistantMessageId ?? fallbackAssistantMessageId ?? null
  const index = findAssistantIndex(messages, targetId)
  if (index === -1) return messages
  const original = messages[index]
  const message = event.type === 'delta' ? original : commitLiveText(original)
  if (message.role !== 'assistant') return messages
  const parts = message.parts ?? []
  const out = messages.slice()

  if (event.type === 'delta') {
    out[index] = {
      ...message,
      text: message.text + event.text,
      liveText: (message.liveText ?? '') + event.text
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
  if (event.type === 'done') {
    out[index] = message
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
  if (event.type === 'loop_state') {
    out[index] = {
      ...message,
      parts: [...parts, {
        kind: 'loop_state',
        taskId: event.taskId,
        event: event.event,
        phase: event.phase,
        iteration: event.iteration,
        reason: event.reason,
        summary: event.summary
      }]
    }
    return out
  }
  if (event.type === 'capability_activity') {
    out[index] = {
      ...message,
      parts: [...parts, {
        kind: 'capability_activity',
        callId: event.callId,
        capability: event.capability,
        event: event.event,
        service: event.service,
        summary: event.summary,
        cached: event.cached,
        artifactId: event.artifactId,
        durationMs: event.durationMs,
        ...(event.cacheHitCount != null ? { cacheHitCount: event.cacheHitCount } : {}),
        ...(event.cacheMissCount != null ? { cacheMissCount: event.cacheMissCount } : {}),
        ...(event.cacheSize != null ? { cacheSize: event.cacheSize } : {}),
        ...(event.cacheLimit != null ? { cacheLimit: event.cacheLimit } : {}),
        ...(event.cacheTtlMs != null ? { cacheTtlMs: event.cacheTtlMs } : {}),
        ...(event.cacheExpired != null ? { cacheExpired: event.cacheExpired } : {}),
        ...(event.cacheEvictions != null ? { cacheEvictions: event.cacheEvictions } : {})
      }]
    }
    return out
  }
  if (event.type === 'verification_state') {
    out[index] = {
      ...message,
      parts: [...parts, {
        kind: 'verification_state',
        event: event.event,
        check: event.check,
        status: event.status,
        summary: event.summary,
        rawLogArtifactId: event.rawLogArtifactId
      }]
    }
    return out
  }
  if (event.type === 'task_memory') {
    out[index] = {
      ...message,
      parts: [...parts, {
        kind: 'task_memory',
        event: event.event,
        scope: event.scope,
        keys: event.keys,
        summary: event.summary,
        artifactId: event.artifactId
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
                preview: event.preview,
                imageDataUrl: event.imageDataUrl
              }
            }
          : part
      )
    }
    return out
  }

  if (event.type === 'progress_step') {
    const existingIndex = parts.findIndex((part) => part.kind === 'progress_step' && part.step === event.step)
    const stepPart = {
      kind: 'progress_step',
      step: event.step,
      total: event.total,
      status: event.status,
      title: event.title,
      detail: event.detail
    } as const

    const nextParts = parts.slice()
    if (existingIndex === -1) {
      nextParts.push(stepPart)
    } else {
      nextParts[existingIndex] = { ...nextParts[existingIndex], ...stepPart }
    }
    out[index] = { ...message, parts: nextParts }
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
  setMessages: Dispatch<SetStateAction<Message[]>>
  setStreaming: Dispatch<SetStateAction<boolean>>
  /**
   * Cleared on done/error so the composer's pause/resume button doesn't get
   * stuck in the "paused" state after the turn ends naturally. Optional so
   * callers that don't expose pause (e.g. tests) can skip it.
   */
  setPaused?: Dispatch<SetStateAction<boolean>>
  /**
   * Called once per committed frame after the assistant message has been
   * updated. The caller decides whether to pin the scroller, render a "new
   * content" toast, etc. Kept as a callback so this hook stays oblivious to
   * scroll policy.
   */
  onCommit?: () => void
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
 *
 * Scroll behavior is delegated to the `onCommit` callback. The hook does not
 * touch the DOM directly — that keeps streaming logic separate from the
 * auto-scroll policy in `useAutoScroll`, which owns whether the user is still
 * following along.
 */
export function useStreamConsumer({
  activeReq,
  activeAssistantMessageId,
  ttsRef,
  setMessages,
  setStreaming,
  setPaused,
  onCommit
}: StreamConsumerArgs): void {
  const pendingDelta = useRef('')
  const rafRef = useRef<number | null>(null)
  const onCommitRef = useRef<() => void>(noop)
  onCommitRef.current = onCommit ?? noop

  useEffect(() => {
    // Drain buffered delta text into the trailing assistant message in a single
    // state update. Called on the next frame after deltas arrive.
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
      onCommitRef.current()
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
      onCommitRef.current()
      if (e.type === 'done' || e.type === 'error') {
        if (e.type === 'done') void ttsRef.current.flush()
        activeReq.current = null
        activeAssistantMessageId.current = null
        setStreaming(false)
        setPaused?.(false)
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
}
