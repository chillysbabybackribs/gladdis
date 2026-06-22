import { useEffect, useRef, type RefObject } from 'react'

/**
 * Keeps the native center-browser WebContentsView aligned with a DOM "slot".
 *
 * The view is composited OVER the renderer, not inside it, so we continuously
 * report the slot element's on-screen rect to main, which positions the page to
 * match. getBoundingClientRect() is already in CSS-pixel/window-content space —
 * the same space main uses for setBounds — so it maps over directly.
 *
 * Re-measures on element resize, window resize, and transition settle, so the
 * page tracks the slot through drawer open/close animations and splitter drags.
 * Reports are rAF-coalesced and deduped (identical bounds are dropped), which is
 * what keeps the native view glued to the animating hole without IPC spam — the
 * anti-jank layer. Ported from ~/Desktop/workspace2.0/browser2.0 (single channel).
 */
export function useSlotBounds(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): void {
  const measureRef = useRef<() => void>(() => {})
  const setupRef = useRef<() => void>(() => {})
  const cleanupRef = useRef<() => void>(() => {})
  const observedElementRef = useRef<HTMLElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  // Persistent setup: register observers/listeners ONCE so they aren't torn down
  // and rebuilt mid-drag.
  useEffect(() => {
    const flushReport = () => {
      rafRef.current = null
      const r = pendingRectRef.current
      if (!r) return
      pendingRectRef.current = null
      const bounds = {
        x: Math.floor(r.left),
        y: Math.floor(r.top),
        width: Math.max(1, Math.ceil(r.left + r.width) - Math.floor(r.left)),
        height: Math.max(1, Math.ceil(r.top + r.height) - Math.floor(r.top))
      }
      const last = lastBoundsRef.current
      if (
        last &&
        last.x === bounds.x &&
        last.y === bounds.y &&
        last.width === bounds.width &&
        last.height === bounds.height
      ) {
        return
      }
      lastBoundsRef.current = bounds
      window.gladdis.layout.setBounds(bounds)
    }
    const report = (r: { left: number; top: number; width: number; height: number }) => {
      pendingRectRef.current = r
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushReport)
    }

    const setup = () => {
      cleanupRef.current()
      cleanupRef.current = () => {}
      observedElementRef.current = null
      measureRef.current = () => {}

      const el = ref.current
      if (!el) return

      const measure = () => report(el.getBoundingClientRect())
      observedElementRef.current = el
      measureRef.current = measure
      measure()

      const ro = new ResizeObserver(() => measureRef.current())
      ro.observe(el)

      const onResize = () => measureRef.current()
      const onTransitionEnd = () => measureRef.current()

      window.addEventListener('resize', onResize)
      document.addEventListener('transitionend', onTransitionEnd)

      cleanupRef.current = () => {
        ro.disconnect()
        window.removeEventListener('resize', onResize)
        document.removeEventListener('transitionend', onTransitionEnd)
        pendingRectRef.current = null
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
      }
    }

    setupRef.current = setup
    setup()
    return () => {
      cleanupRef.current()
      cleanupRef.current = () => {}
      observedElementRef.current = null
      measureRef.current = () => {}
      pendingRectRef.current = null
      lastBoundsRef.current = null
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [ref])

  // Volatile triggers: re-measure when layout deps change. Shallow element-by-element
  // comparison avoids JSON.stringify/string serialization overhead on every single render.
  const prevDepsRef = useRef<unknown[]>(deps)
  const changeCountRef = useRef(0)

  const depsChanged =
    deps.length !== prevDepsRef.current.length ||
    deps.some((dep, i) => dep !== prevDepsRef.current[i])

  if (depsChanged) {
    prevDepsRef.current = deps
    changeCountRef.current += 1
  }

  useEffect(() => {
    if (ref.current && ref.current !== observedElementRef.current) setupRef.current()
    if (observedElementRef.current) measureRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeCountRef.current])
}
