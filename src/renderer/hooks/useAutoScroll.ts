import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Pixels of slack we treat as "at the bottom". A real scroll position is almost
 * never exactly equal to scrollHeight - clientHeight because of fractional
 * pixels from devicePixelRatio rounding, sub-pixel layout, and rubber-banding
 * on macOS. 32px is large enough to swallow all of that yet small enough that a
 * deliberate scroll-up of a single line unsticks immediately.
 */
const DEFAULT_THRESHOLD_PX = 32

/**
 * How long after we issue a programmatic scroll to ignore the resulting
 * `scroll` events. We must ignore them or the synthetic scroll would look like
 * the user reaching the bottom (true) and we'd re-stick or thrash. 120ms is
 * comfortably longer than one frame at 60Hz so a single `scrollTop = ...`
 * assignment is fully drained before user-driven `scroll` events count again.
 *
 * Smooth scrolls take ~300-500ms to settle, so the smooth path extends this
 * window separately.
 */
const PROGRAMMATIC_SETTLE_INSTANT_MS = 120
const PROGRAMMATIC_SETTLE_SMOOTH_MS = 600

/** Pure helper: is this element scrolled to within `threshold` of the bottom? */
export function isScrolledToBottom(
  el: { scrollHeight: number; clientHeight: number; scrollTop: number },
  threshold = DEFAULT_THRESHOLD_PX
): boolean {
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop
  return distance <= threshold
}

/**
 * Pure helper: decide what the follow flag should become after a `scroll`
 * event. Used by the hook and exported for tests so the policy is verifiable
 * without a DOM. Returns the unchanged value while a programmatic scroll is
 * still settling — those synthetic scroll events must not flip user intent.
 */
export function decideFollowOnScroll(
  state: { following: boolean; programmaticUntilMs: number },
  input: { nowMs: number; atBottom: boolean }
): boolean {
  if (input.nowMs < state.programmaticUntilMs) return state.following
  return input.atBottom
}

/**
 * Pure helper: which keyboard keys should immediately unstick (scroll-up
 * intent) versus simply clear the programmatic-settle window (scroll-down).
 * Returns 'yield' to unstick, 'open' to clear the settle window so subsequent
 * scroll events count as user-driven, or 'ignore' for keys that don't move
 * the scroller.
 */
export function classifyScrollKey(key: string): 'yield' | 'open' | 'ignore' {
  switch (key) {
    case 'ArrowUp':
    case 'PageUp':
    case 'Home':
      return 'yield'
    case 'ArrowDown':
    case 'PageDown':
    case 'End':
    case ' ':
      return 'open'
    default:
      return 'ignore'
  }
}

export interface AutoScrollHandle {
  /**
   * Schedule a pin to the bottom on the next animation frame. Only acts if the
   * user is currently in "follow" mode; otherwise it is a no-op. Coalesces
   * across the same frame so a burst of stream events only causes one layout
   * read.
   */
  scheduleScroll(): void
  /**
   * Forcibly scroll to the bottom and re-enable follow mode. Used for explicit
   * user actions (sending a new message, clicking the jump-to-latest button)
   * where the user has unambiguously asked to see the latest content.
   */
  scrollToBottom(behavior?: ScrollBehavior): void
  /** True while the scroller is anchored at the bottom. Drives the jump button. */
  isAtBottom: boolean
  /**
   * True while we are actively following new content. May differ from
   * `isAtBottom` during the brief window after the user scrolls down to the
   * bottom but before the next scroll event commits.
   */
  isFollowing: boolean
}

interface Options {
  threshold?: number
  /**
   * Optional inner content node whose height changes should also keep the view
   * pinned while following. This catches post-render growth such as expanding
   * tool cards, screenshots, and markdown reflow that increase scrollHeight
   * without resizing the scroll container itself.
   */
  contentRef?: RefObject<HTMLElement | null>
  /**
   * Called when follow-mode flips. Useful for analytics or for callers that
   * want to clear other UI (e.g. dismiss a "new messages" toast).
   */
  onFollowChange?: (following: boolean) => void
}

/**
 * Professional auto-scroll for chat-style transcripts.
 *
 * Three guarantees:
 *
 * 1. **The user always wins.** Wheel, touch, and keyboard scroll-up gestures
 *    flip out of follow mode immediately — even mid-frame, and even while a
 *    programmatic pin is queued. The queued pin is cancelled before it can
 *    fight the user.
 *
 * 2. **Programmatic scrolls don't lie about the user's intent.** The `scroll`
 *    event fires for both real user scrolls and our `scrollTop = ...`
 *    assignments. We mark a short settle window after each programmatic scroll
 *    during which `scroll` events update `isAtBottom` for the UI but do NOT
 *    alter follow mode. Only true user gestures change follow mode.
 *
 * 3. **Coming back to the bottom re-enables follow.** When the user scrolls
 *    (or flings) all the way down within the threshold, follow mode resumes —
 *    no need to click anything.
 *
 * Usage:
 *
 *     const scrollRef = useRef<HTMLDivElement>(null)
 *     const auto = useAutoScroll(scrollRef)
 *     // ... pass auto.scheduleScroll to your stream consumer
 *     // ... call auto.scrollToBottom() on submit / on load
 *     // ... render {!auto.isAtBottom && <JumpButton onClick={auto.scrollToBottom}/>}
 */
export function useAutoScroll(
  scrollRef: RefObject<HTMLElement | null>,
  options?: Options
): AutoScrollHandle {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD_PX
  const contentRef = options?.contentRef
  const onFollowChange = options?.onFollowChange

  // We keep mirror refs alongside React state so the event handlers and the
  // scheduled rAF can read the freshest value without rebinding the effect on
  // every state change.
  const followingRef = useRef(true)
  const atBottomRef = useRef(true)
  const programmaticUntilRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isFollowing, setIsFollowing] = useState(true)

  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return
    followingRef.current = next
    setIsFollowing(next)
    onFollowChange?.(next)
  }, [onFollowChange])

  const setAtBottom = useCallback((next: boolean) => {
    if (atBottomRef.current === next) return
    atBottomRef.current = next
    setIsAtBottom(next)
  }, [])

  const cancelPendingScroll = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const performScroll = useCallback((el: HTMLElement, behavior: ScrollBehavior) => {
    // Mark the settle window BEFORE mutating scrollTop so the synchronous
    // `scroll` event that some browsers dispatch is already inside the window.
    programmaticUntilRef.current = performance.now() + (
      behavior === 'smooth' ? PROGRAMMATIC_SETTLE_SMOOTH_MS : PROGRAMMATIC_SETTLE_INSTANT_MS
    )
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
    setAtBottom(true)
  }, [setAtBottom])

  const scheduleScroll = useCallback(() => {
    if (!followingRef.current) return
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      // Re-check after the frame: the user may have scrolled up between
      // scheduling and execution. Honor that — never override a fresh user
      // gesture with a stale scheduled pin.
      if (!followingRef.current) return
      const el = scrollRef.current
      if (!el) return
      performScroll(el, 'auto')
    })
  }, [performScroll, scrollRef])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    cancelPendingScroll()
    setFollowing(true)
    const el = scrollRef.current
    if (!el) return
    performScroll(el, behavior)
  }, [cancelPendingScroll, performScroll, scrollRef, setFollowing])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const contentEl = contentRef?.current

    const yieldToUser = () => {
      cancelPendingScroll()
      setFollowing(false)
      setAtBottom(isScrolledToBottom(el, threshold))
    }

    const refreshFromScroll = () => {
      const atBottom = isScrolledToBottom(el, threshold)
      setAtBottom(atBottom)
      // During the programmatic-settle window we mirror the scroll position to
      // the UI but never let the synthetic event toggle follow mode. The user's
      // own input — wheel/touch/keys — is the only thing that does that.
      const next = decideFollowOnScroll(
        { following: followingRef.current, programmaticUntilMs: programmaticUntilRef.current },
        { nowMs: performance.now(), atBottom }
      )
      setFollowing(next)
    }

    const onScroll = () => {
      refreshFromScroll()
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        yieldToUser()
        return
      }
      // Wheel-down toward the bottom: nothing to do here; the resulting
      // `scroll` event will re-stick if we cross the threshold.
    }

    // Touch can drag in any direction. We can't cheaply know direction from a
    // single touchmove without tracking touchstart positions, so we
    // conservatively treat any active touch as "user is interacting" and
    // cancel the pending pin. The subsequent `scroll` event(s) will recompute
    // follow mode based on final position.
    const onTouchStart = () => {
      cancelPendingScroll()
      // Open the gate — clear the programmatic-settle window so the touch
      // gesture's scroll events are treated as user-driven immediately.
      programmaticUntilRef.current = 0
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Only keys that scroll the container itself. Letter keys etc. are
      // ignored even if the scroller has focus.
      const intent = classifyScrollKey(event.key)
      if (intent === 'yield') yieldToUser()
      else if (intent === 'open') programmaticUntilRef.current = 0
    }

    // Resize is a layout change, not user input — if the user is following, we
    // need to re-pin so the bottom doesn't drift out of view when the panel
    // height shrinks. If they aren't following, leave them where they are.
    const onResize = () => {
      if (followingRef.current) scheduleScroll()
      else setAtBottom(isScrolledToBottom(el, threshold))
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('keydown', onKeyDown)

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    resizeObserver?.observe(el)
    if (contentEl && contentEl !== el) resizeObserver?.observe(contentEl)

    // Initial read in case the container starts mid-scroll (e.g. restored
    // conversation render painted before this effect bound).
    refreshFromScroll()

    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('keydown', onKeyDown)
      resizeObserver?.disconnect()
      cancelPendingScroll()
    }
  }, [scrollRef, contentRef, threshold, cancelPendingScroll, scheduleScroll, setAtBottom, setFollowing])

  return { scheduleScroll, scrollToBottom, isAtBottom, isFollowing }
}
