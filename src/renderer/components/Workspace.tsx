import { useRef, useState } from 'react'
import { ChatPanel } from './ChatPanel'
import { BrowserPanel } from './BrowserPanel'
import { Splitter, DRAWER_MIN } from './Splitter'

const LEFT_KEY = 'gladdis:drawer:left'
const RIGHT_KEY = 'gladdis:drawer:right'
const LEFT_FRAC_KEY = 'gladdis:drawer:left:frac'
const RIGHT_FRAC_KEY = 'gladdis:drawer:right:frac'
const LEFT_ZOOM_KEY = 'gladdis:chat:left:zoom'
const RIGHT_ZOOM_KEY = 'gladdis:chat:right:zoom'

const DEFAULT_LEFT_FRAC = 0.16
const DEFAULT_RIGHT_FRAC = 0.16
const ZOOM_MIN = 0.85
const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.1
const ZOOM_DEFAULT = 1

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.warn(`Failed to set localStorage key "${key}":`, e)
  }
}

function loadBool(key: string, fallback: boolean): boolean {
  const v = safeGetItem(key)
  return v === null ? fallback : v === '1'
}
function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return ZOOM_DEFAULT
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100))
}
function loadFrac(key: string, fallback: number): number {
  const v = parseFloat(safeGetItem(key) ?? '')
  return Number.isFinite(v) ? v : fallback
}
function loadZoom(key: string): number {
  return clampZoom(parseFloat(safeGetItem(key) ?? String(ZOOM_DEFAULT)))
}

function ChatZoomControl({
  side,
  zoom,
  onChange
}: {
  side: 'left' | 'right'
  zoom: number
  onChange: (zoom: number) => void
}) {
  const percent = Math.round(zoom * 100)
  const label = `${side === 'left' ? 'Left' : 'Right'} chat zoom: ${percent}%`
  const canDecrease = zoom > ZOOM_MIN
  const canIncrease = zoom < ZOOM_MAX
  const commit = (next: number) => onChange(clampZoom(next))

  return (
    <div className="footer-zoom" role="group" aria-label={label}>
      <button
        type="button"
        className="footer-zoom-step"
        title="Zoom out"
        aria-label={`Zoom out ${side} chat`}
        disabled={!canDecrease}
        onClick={() => commit(zoom - ZOOM_STEP)}
      >
        -
      </button>
      <button
        type="button"
        className="footer-zoom-value"
        title="Reset zoom"
        aria-label={`Reset ${side} chat zoom`}
        onClick={() => commit(ZOOM_DEFAULT)}
      >
        {percent}%
      </button>
      <button
        type="button"
        className="footer-zoom-step"
        title="Zoom in"
        aria-label={`Zoom in ${side} chat`}
        disabled={!canIncrease}
        onClick={() => commit(zoom + ZOOM_STEP)}
      >
        +
      </button>
    </div>
  )
}

function DrawerChevron({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const points =
    side === 'left'
      ? open
        ? '11 5 7 9 11 13'
        : '7 5 11 9 7 13'
      : open
        ? '7 5 11 9 7 13'
        : '11 5 7 9 11 13'

  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d={`M${points}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Three-column workspace: a retractable chat/agent drawer on each side of the
 * center native-Chromium browser.
 *
 *   [ ChatPanel "left" ] | splitter | [ BrowserPanel (flex-1) ] | splitter | [ ChatPanel "right" ]
 *
 * Each drawer collapses to 0 width with a CSS width transition; the center
 * browser is flex-1 so it fills whatever space is left, and its native view
 * tracks the resulting hole via useSlotBounds (inside BrowserPanel). Open/closed
 * state and width fractions persist to localStorage. The left drawer opens by
 * default (mirrors gladdis's chat-on-the-left); the right opens on demand.
 */
export function Workspace() {
  const rowRef = useRef<HTMLDivElement>(null)
  const [leftFooterSlot, setLeftFooterSlot] = useState<HTMLDivElement | null>(null)
  const [rightFooterSlot, setRightFooterSlot] = useState<HTMLDivElement | null>(null)
  const [leftOpen, setLeftOpen] = useState(() => loadBool(LEFT_KEY, true))
  const [rightOpen, setRightOpen] = useState(() => loadBool(RIGHT_KEY, false))
  const [leftFrac, setLeftFrac] = useState(() => loadFrac(LEFT_FRAC_KEY, DEFAULT_LEFT_FRAC))
  const [rightFrac, setRightFrac] = useState(() => loadFrac(RIGHT_FRAC_KEY, DEFAULT_RIGHT_FRAC))
  const [leftZoom, setLeftZoom] = useState(() => loadZoom(LEFT_ZOOM_KEY))
  const [rightZoom, setRightZoom] = useState(() => loadZoom(RIGHT_ZOOM_KEY))

  const leftWidth = leftOpen ? `${Math.max(DRAWER_MIN, leftFrac) * 100}%` : '0px'
  const rightWidth = rightOpen ? `${Math.max(DRAWER_MIN, rightFrac) * 100}%` : '0px'

  const toggleLeft = () => {
    setLeftOpen((open) => {
      const next = !open
      safeSetItem(LEFT_KEY, next ? '1' : '0')
      return next
    })
  }
  const toggleRight = () => {
    setRightOpen((open) => {
      const next = !open
      safeSetItem(RIGHT_KEY, next ? '1' : '0')
      return next
    })
  }
  const onLeftFrac = (f: number) => {
    setLeftFrac(f)
    safeSetItem(LEFT_FRAC_KEY, String(f))
  }
  const onRightFrac = (f: number) => {
    setRightFrac(f)
    safeSetItem(RIGHT_FRAC_KEY, String(f))
  }
  const onLeftZoom = (zoom: number) => {
    const next = clampZoom(zoom)
    setLeftZoom(next)
    safeSetItem(LEFT_ZOOM_KEY, String(next))
  }
  const onRightZoom = (zoom: number) => {
    const next = clampZoom(zoom)
    setRightZoom(next)
    safeSetItem(RIGHT_ZOOM_KEY, String(next))
  }

  return (
    <div className="workspace">
      <div className="workspace-main" ref={rowRef}>
        {/* Left drawer */}
        <div
          className={`drawer drawer-left ${leftOpen ? 'open' : 'closed'}`}
          style={{ width: leftWidth }}
        >
          <ChatPanel panelId="left" zoom={leftZoom} footerSlot={leftOpen ? leftFooterSlot : null} />
        </div>
        {leftOpen && <Splitter containerRef={rowRef} onFraction={onLeftFrac} side="left" />}

        {/* Center native browser — fills the remaining space. */}
        <div className="workspace-center">
          <BrowserPanel />
        </div>

        {/* Right drawer */}
        {rightOpen && <Splitter containerRef={rowRef} onFraction={onRightFrac} side="right" />}
        <div
          className={`drawer drawer-right ${rightOpen ? 'open' : 'closed'}`}
          style={{ width: rightWidth }}
        >
          <ChatPanel panelId="right" zoom={rightZoom} footerSlot={rightOpen ? rightFooterSlot : null} />
        </div>
      </div>

      <footer className="workspace-footer" aria-label="Chat controls">
        <div
          className={`footer-chat-controls left ${leftOpen ? 'is-open' : ''}`}
          style={{ width: leftOpen ? leftWidth : undefined }}
        >
          <button
            className={`footer-chat-toggle ${leftOpen ? 'is-open' : ''}`}
            title={leftOpen ? 'Hide left chat' : 'Show left chat'}
            aria-label={leftOpen ? 'Hide left chat' : 'Show left chat'}
            aria-expanded={leftOpen}
            onClick={toggleLeft}
          >
            <DrawerChevron side="left" open={leftOpen} />
          </button>
          {leftOpen && (
            <>
              <div className="footer-action-slot" ref={setLeftFooterSlot} />
              <ChatZoomControl side="left" zoom={leftZoom} onChange={onLeftZoom} />
            </>
          )}
        </div>
        <div className="workspace-footer-spacer" />
        <div
          className={`footer-chat-controls right ${rightOpen ? 'is-open' : ''}`}
          style={{ width: rightOpen ? rightWidth : undefined }}
        >
          {rightOpen && (
            <>
              <div className="footer-action-slot right" ref={setRightFooterSlot} />
              <ChatZoomControl side="right" zoom={rightZoom} onChange={onRightZoom} />
            </>
          )}
          <button
            className={`footer-chat-toggle ${rightOpen ? 'is-open' : ''}`}
            title={rightOpen ? 'Hide right chat' : 'Show right chat'}
            aria-label={rightOpen ? 'Hide right chat' : 'Show right chat'}
            aria-expanded={rightOpen}
            onClick={toggleRight}
          >
            <DrawerChevron side="right" open={rightOpen} />
          </button>
        </div>
      </footer>
    </div>
  )
}
