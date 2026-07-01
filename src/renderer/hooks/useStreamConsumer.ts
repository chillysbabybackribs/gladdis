import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ChatStreamEvent } from '../../../shared/types'
import type { Message, ToolActivity } from '../components/chatTypes'
import { appendText } from '../components/chatTypes'

const noop = () => {}
const STREAM_SEGMENT_SOFT_LIMIT = 1200
const STREAM_SEGMENT_MIN_BREAK = 300

/**
 * Upper bound (ms) on how long buffered stream text waits before it paints.
 * `requestAnimationFrame` is the primary trigger — it coalesces a burst of
 * tokens into one commit per display frame while the panel is painting. But
 * Chromium pauses/heavily-throttles rAF when the window is minimized, hidden,
 * or fully occluded. Without a timer fallback the stream would visibly freeze
 * in a backgrounded panel and — worse — a buffered `done`/`error` would never
 * reach `finishTurn`, leaving the spinner stuck and the request id uncleared
 * until the user refocused. The timer guarantees forward progress regardless
 * of paint state; whichever of rAF/timer fires first flushes and cancels the
 * other, so the foreground fast-path still commits at ~60fps.
 */
const FALLBACK_FLUSH_MS = 100

function liveSegments(message: Message): string[] {
  if (message.liveTextSegments?.length) return message.liveTextSegments
  if (message.liveText) return [message.liveText]
  return []
}

function liveTextValue(message: Message): string {
  if (message.liveTextSegments?.length) return message.liveTextSegments.join('')
  return message.liveText ?? ''
}

function findSafeSplit(text: string): number {
  const candidates = [
    { index: text.lastIndexOf('\n```\n'), length: '\n```\n'.length },
    { index: text.lastIndexOf('```\n\n'), length: '```\n\n'.length },
    { index: text.lastIndexOf('\n\n'), length: '\n\n'.length }
  ].filter((candidate) => candidate.index >= STREAM_SEGMENT_MIN_BREAK)

  if (!candidates.length) return -1
  const best = candidates.reduce((latest, candidate) =>
    candidate.index > latest.index ? candidate : latest
  )
  return best.index + best.length
}

function appendLiveTextSegments(segments: string[], text: string): string[] {
  if (!text) return segments
  const sealed = segments.slice(0, -1)
  let tail = (segments.at(-1) ?? '') + text

  while (tail.length >= STREAM_SEGMENT_SOFT_LIMIT) {
    const splitAt = findSafeSplit(tail)
    if (splitAt === -1) break
    sealed.push(tail.slice(0, splitAt))
    tail = tail.slice(splitAt)
  }

  return tail ? [...sealed, tail] : sealed
}

function findAssistantIndex(messages: Message[], assistantMessageId?: string | null): number {
  if (assistantMessageId) {
    return messages.findIndex((message) => message.role === 'assistant' && message.id === assistantMessageId)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i
  }
  return -1
}

function resolveAssistantIndex(
  messages: Message[],
  assistantMessageId?: string | null,
  hintedIndex?: number | null
): number {
  if (hintedIndex != null && hintedIndex >= 0 && hintedIndex < messages.length) {
    const hinted = messages[hintedIndex]
    if (hinted?.role === 'assistant' && (!assistantMessageId || hinted.id === assistantMessageId)) {
      return hintedIndex
    }
  }
  return findAssistantIndex(messages, assistantMessageId)
}

/** Best-effort label when a tool_result arrives without a matching tool_call. */
function inferToolNameFromCallId(callId: string): string {
  const hyphen = callId.indexOf('-')
  if (hyphen > 0) return callId.slice(0, hyphen)
  return callId
}

function commitLiveText(message: Message): Message {
  const text = liveTextValue(message)
  if (!text) return message
  return {
    ...message,
    liveText: undefined,
    liveTextSegments: undefined,
    parts: appendText(message.parts ?? [], text)
  }
}

export function applyStreamEventToMessages(
  messages: Message[],
  event: ChatStreamEvent,
  fallbackAssistantMessageId?: string | null,
  fallbackAssistantIndex?: number | null
): Message[] {
  const targetId = event.assistantMessageId ?? fallbackAssistantMessageId ?? null
  const index = resolveAssistantIndex(messages, targetId, fallbackAssistantIndex)
  if (index === -1) return messages
  const original = messages[index]
  const message = event.type === 'delta' ? original : commitLiveText(original)
  if (message.role !== 'assistant') return messages
  const parts = message.parts ?? []
  const out = messages.slice()

  if (event.type === 'delta') {
    const nextLiveSegments = appendLiveTextSegments(liveSegments(message), event.text)
    out[index] = {
      ...message,
      text: message.text + event.text,
      liveText: (message.liveText ?? '') + event.text,
      liveTextSegments: nextLiveSegments
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
    // Guard against duplicate tool_call events for the same callId (Cursor emits
    // these at tool boundaries). Return the original list reference (not the
    // slice) so a redundant event doesn't trigger a no-op React commit.
    if (parts.some((p) => p.kind === 'tool' && p.tool.callId === event.callId)) return messages
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
    const hasMatch = parts.some((part) => part.kind === 'tool' && part.tool.callId === event.callId)
    if (hasMatch) {
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
    // Some providers emit only a completed event (or the started event was dropped).
    const tool: ToolActivity = {
      callId: event.callId,
      tool: inferToolNameFromCallId(event.callId),
      args: {},
      status: event.ok ? 'ok' : 'error',
      endedAt: event.endedAt,
      durationMs: event.durationMs,
      preview: event.preview,
      imageDataUrl: event.imageDataUrl
    }
    out[index] = { ...message, parts: [...parts, { kind: 'tool', tool }] }
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
  /** Cached index of the active assistant row so steady-state stream updates stay O(1). */
  activeAssistantIndex: RefObject<number | null>
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
  /** Called when a turn finishes (done/error), after state has been committed. */
  onTurnEnd?: () => void
}

/**
 * Consume the model stream and fill the trailing assistant message.
 *
 * Deltas are coalesced to one React commit per animation frame. The SDK emits
 * tokens in rapid bursts, each arriving as its own IPC event (its own event-loop
 * tick, so React can't batch them); rendering each one was the stutter — every
 * token cloned the message list, re-parsed the whole bubble's markdown, and
 * forced a scroll reflow. Buffering a frame's worth of text and flushing once
 * caps that work at the display's refresh rate (rendering faster than ~60fps is
 * wasted work that causes the jank, not smoothness). Non-delta events
 * (tool_call/result/error/done) flush the pending text first, then apply in the
 * same batch so a burst of tool events costs one React commit.
 *
 * Scroll behavior is delegated to the `onCommit` callback. The hook does not
 * touch the DOM directly — that keeps streaming logic separate from the
 * auto-scroll policy in `useAutoScroll`, which owns whether the user is still
 * following along.
 */
export function useStreamConsumer({
  activeReq,
  activeAssistantMessageId,
  activeAssistantIndex,
  ttsRef,
  setMessages,
  setStreaming,
  setPaused,
  onCommit,
  onTurnEnd
}: StreamConsumerArgs): void {
  const bufferedDeltaText = useRef('')
  const lastActiveRequestId = useRef<string | null>(null)
  const lastRequestId = useRef<string | null>(null)

  const flushRaf = useRef<number | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onCommitRef = useRef<() => void>(noop)
  const onTurnEndRef = useRef<() => void>(noop)
  onCommitRef.current = onCommit ?? noop
  onTurnEndRef.current = onTurnEnd ?? noop

  useEffect(() => {
    const finishTurn = (event: ChatStreamEvent) => {
      if (event.type === 'done') void ttsRef.current.flush()
      activeReq.current = null
      activeAssistantMessageId.current = null
      activeAssistantIndex.current = null
      lastActiveRequestId.current = null
      setStreaming(false)
      setPaused?.(false)
      onTurnEndRef.current()
    }

    const applyEvents = (events: ChatStreamEvent[]) => {
      if (!events.length) return
      setMessages((msgs) => {
        let next = msgs
        for (const event of events) {
          next = applyStreamEventToMessages(
            next,
            event,
            activeAssistantMessageId.current,
            activeAssistantIndex.current
          )
        }
        const assistantId = activeAssistantMessageId.current
        if (assistantId) {
          activeAssistantIndex.current = resolveAssistantIndex(
            next,
            assistantId,
            activeAssistantIndex.current
          )
        }
        return next
      })
      onCommitRef.current()
      const terminal = events.find((event) => event.type === 'done' || event.type === 'error')
      if (terminal) finishTurn(terminal)
    }

    const clearFlushTimers = () => {
      if (flushRaf.current !== null) {
        cancelAnimationFrame(flushRaf.current)
        flushRaf.current = null
      }
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
    }

    const flushBufferedDelta = (extraEvents: ChatStreamEvent[] = []) => {
      clearFlushTimers()
      const deltaText = bufferedDeltaText.current
      bufferedDeltaText.current = ''
      if (!deltaText) {
        if (extraEvents.length) applyEvents(extraEvents)
        return
      }
      applyEvents([
        {
          requestId: activeReq.current ?? lastActiveRequestId.current ?? '',
          assistantMessageId: activeAssistantMessageId.current ?? undefined,
          type: 'delta',
          text: deltaText
        },
        ...extraEvents
      ])
    }

    const flushTick = () => {
      flushRaf.current = null
      flushTimer.current = null
      flushBufferedDelta()
    }

    const scheduleFlush = () => {
      if (flushRaf.current === null) {
        flushRaf.current = requestAnimationFrame(flushTick)
      }
      if (flushTimer.current === null) {
        flushTimer.current = setTimeout(flushTick, FALLBACK_FLUSH_MS)
      }
    }

    const off = window.gladdis.chat.onStream((e) => {
      const activeId = activeReq.current
      const isTerminal = e.type === 'done' || e.type === 'error'
      if (e.requestId !== activeId && !(isTerminal && e.requestId === lastActiveRequestId.current)) {
        return
      }
      if (activeId) lastActiveRequestId.current = activeId

      // Detect a new turn starting and reset any buffered stream text.
      if (e.requestId !== lastRequestId.current) {
        lastRequestId.current = e.requestId
        clearFlushTimers()
        bufferedDeltaText.current = ''
      }

      // Speak deltas here, NOT inside the setMessages updater — React invokes
      // updaters twice in StrictMode, which would double every spoken fragment.
      if (e.type === 'delta') {
        ttsRef.current.speak(e.text)
        bufferedDeltaText.current += e.text
        scheduleFlush()
        return
      }

      if (isTerminal) {
        flushBufferedDelta([e])
      } else {
        // Any structural event (tool_call, capability_activity, etc.) must
        // preserve ordering relative to the latest prose, so flush the pending
        // text and the event together in one commit.
        flushBufferedDelta([e])
      }
    })

    return () => {
      off()
      clearFlushTimers()
      bufferedDeltaText.current = ''
    }
    // Refs are stable; setters are stable. Wire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
