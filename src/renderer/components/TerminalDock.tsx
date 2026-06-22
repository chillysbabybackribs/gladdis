import { useCallback, useEffect, useRef } from 'react'
import { TerminalSlot } from './TerminalSlot'
import type { TerminalHandle } from '../hooks/useTerminal'

export type TerminalDockPos = 'bottom' | 'left' | 'right'

interface Props {
  dock: TerminalDockPos
  handle: TerminalHandle
  onClose: () => void
  onDockChange: (next: TerminalDockPos) => void
  /** Bottom-mode only: current height in px. */
  height?: number
  /** Bottom-mode only: persist a new height. */
  onHeightChange?: (next: number) => void
}

const MIN_BOTTOM_HEIGHT = 120
const MAX_BOTTOM_HEIGHT_FRAC = 0.8

/**
 * Chrome around the xterm slot: a header with a dock-position picker and a
 * close button, plus (in bottom mode) a horizontal splitter at the top edge
 * for drag-to-resize. The xterm canvas itself is rendered by <TerminalSlot/>,
 * which adopts the singleton host element.
 */
export function TerminalDock({
  dock,
  handle,
  onClose,
  onDockChange,
  height = 280,
  onHeightChange
}: Props) {
  const isBottom = dock === 'bottom'

  // Bottom dock is positioned absolutely inside .workspace-center (whose
  // height/width are already drawer-aware), so it auto-fits the free space
  // without any pixel math. Side docks fill the drawer they render into.
  const style = isBottom
    ? {
        position: 'absolute' as const,
        left: 0,
        right: 0,
        bottom: 0,
        height: `${height}px`
      }
    : undefined

  return (
    <div className={`terminal-dock terminal-dock-${dock}`} style={style}>
      {isBottom && (
        <BottomSplitter
          height={height}
          onChange={(h) => onHeightChange?.(h)}
          onSettle={handle.refit}
        />
      )}
      <div className="terminal-header">
        <span className="terminal-title">
          Terminal{handle.ptyId ? '' : ' (idle)'}
        </span>
        <div className="terminal-dock-picker" role="group" aria-label="Dock position">
          <DockBtn pos="left" current={dock} onClick={() => onDockChange('left')} />
          <DockBtn pos="bottom" current={dock} onClick={() => onDockChange('bottom')} />
          <DockBtn pos="right" current={dock} onClick={() => onDockChange('right')} />
        </div>
        <button
          type="button"
          className="terminal-close"
          title="Close terminal"
          aria-label="Close terminal"
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3.5 3.5l7 7M10.5 3.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="terminal-body">
        <TerminalSlot handle={handle} />
      </div>
    </div>
  )
}

function DockBtn({
  pos,
  current,
  onClick
}: {
  pos: TerminalDockPos
  current: TerminalDockPos
  onClick: () => void
}) {
  const active = pos === current
  const label =
    pos === 'bottom' ? 'Dock to bottom' : pos === 'left' ? 'Dock to left' : 'Dock to right'
  return (
    <button
      type="button"
      className={`terminal-dock-btn ${active ? 'is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <DockIcon pos={pos} />
    </button>
  )
}

function DockIcon({ pos }: { pos: TerminalDockPos }) {
  // Minimal "filled region within a frame" glyphs (rect inside rect) so the
  // active dock reads at a glance.
  const fill =
    pos === 'bottom'
      ? { x: 2, y: 8, w: 12, h: 5 }
      : pos === 'left'
        ? { x: 2, y: 2, w: 6, h: 11 }
        : { x: 8, y: 2, w: 6, h: 11 }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect x={fill.x} y={fill.y} width={fill.w} height={fill.h} fill="currentColor" />
    </svg>
  )
}

function BottomSplitter({
  height,
  onChange,
  onSettle
}: {
  height: number
  onChange: (height: number) => void
  onSettle: () => void
}) {
  const dragging = useRef(false)
  const lastReportedRef = useRef(height)

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      const wh = window.innerHeight
      const max = Math.floor(wh * MAX_BOTTOM_HEIGHT_FRAC)
      // Bottom-anchored: as the cursor moves UP, the terminal grows.
      const next = Math.max(MIN_BOTTOM_HEIGHT, Math.min(max, wh - e.clientY))
      if (next === lastReportedRef.current) return
      lastReportedRef.current = next
      onChange(next)
    },
    [onChange]
  )

  const stop = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    document.body.style.cursor = ''
    document.getElementById('gladdis-drag-shield')?.remove()
    // After drag settles, refit the PTY to the final size in one shot.
    onSettle()
  }, [onSettle])

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
    lastReportedRef.current = height
    document.body.style.cursor = 'row-resize'
    // Overlay shield so pointermove keeps firing even when the cursor passes
    // over the native WebContentsView (which would otherwise eat events).
    const shield = document.createElement('div')
    shield.id = 'gladdis-drag-shield'
    shield.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize'
    document.body.appendChild(shield)
  }

  return (
    <div
      className="terminal-splitter"
      onPointerDown={start}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
    >
      <span className="terminal-splitter-grip" />
    </div>
  )
}
