import { useCallback, useEffect, useRef } from 'react'

/** Min / max fraction a chat drawer may occupy of the workspace row width. */
export const DRAWER_MIN = 0.16
const DRAWER_MAX = 0.5

/**
 * A thin draggable divider between a chat drawer and the center browser. Reports
 * the drawer's new width fraction as the user drags. While dragging we add a
 * transparent full-window overlay so the cursor stays consistent and pointer
 * events don't get swallowed by the native WebContentsView (which sits above the
 * renderer and would otherwise eat them).
 *
 * `side="left"` measures the fraction from the row's left edge (left drawer);
 * `side="right"` measures from the right edge so the right drawer grows as the
 * divider moves left. Ported from ~/Desktop/workspace2.0/browser2.0.
 */
export function Splitter({
  containerRef,
  onFraction,
  side = 'left',
  min = DRAWER_MIN,
  max = DRAWER_MAX
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onFraction: (fraction: number) => void
  side?: 'left' | 'right'
  min?: number
  max?: number
}) {
  const dragging = useRef(false)

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const f =
        side === 'right'
          ? (rect.right - e.clientX) / rect.width
          : (e.clientX - rect.left) / rect.width
      onFraction(Math.min(max, Math.max(min, f)))
    },
    [containerRef, onFraction, min, max, side]
  )

  const stop = useCallback(() => {
    dragging.current = false
    document.body.style.cursor = ''
    document.getElementById('gladdis-drag-shield')?.remove()
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [onMove, stop])

  const start = () => {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    // Overlay shield so dragging over the native page still tracks pointer moves.
    const shield = document.createElement('div')
    shield.id = 'gladdis-drag-shield'
    shield.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize'
    document.body.appendChild(shield)
  }

  return (
    <div
      className="drawer-splitter"
      onPointerDown={start}
      role="separator"
      aria-label="Resize chat drawer"
    >
      <span className="drawer-splitter-grip" />
    </div>
  )
}
