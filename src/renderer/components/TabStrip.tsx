import { useRef, useState } from 'react'
import type { TabInfo } from '../../../shared/types'

interface Props {
  tabs: TabInfo[]
  activeId: string | null
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onReorder: (id: string, toIndex: number) => void
}

/** Strip a URL down to its hostname for the favicon-less fallback glyph. */
function hostInitial(t: TabInfo): string {
  try {
    return new URL(t.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase() || '•'
  } catch {
    return '•'
  }
}

export function TabStrip({ tabs, activeId, onSwitch, onClose, onNew, onReorder }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [brokenFav, setBrokenFav] = useState<Set<string>>(new Set())
  const stripRef = useRef<HTMLDivElement>(null)

  const markBroken = (url: string) =>
    setBrokenFav((s) => (s.has(url) ? s : new Set(s).add(url)))

  const onDrop = (toIndex: number) => {
    if (dragId) onReorder(dragId, toIndex)
    setDragId(null)
    setOverIndex(null)
  }

  return (
    <div className="tabstrip" ref={stripRef}>
      <div className="tabstrip-tabs">
        {tabs.map((t, i) => {
          const active = t.id === activeId
          const showFav = t.favicon && !brokenFav.has(t.favicon)
          return (
            <div
              key={t.id}
              className={[
                'tab',
                active ? 'active' : '',
                dragId === t.id ? 'dragging' : '',
                overIndex === i && dragId && dragId !== t.id ? 'drop-target' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={t.title || t.url}
              draggable
              onDragStart={(e) => {
                setDragId(t.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (overIndex !== i) setOverIndex(i)
              }}
              onDrop={() => onDrop(i)}
              onDragEnd={() => {
                setDragId(null)
                setOverIndex(null)
              }}
              onMouseDown={(e) => {
                // Left = activate; middle = close (real-browser muscle memory).
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(t.id)
                } else if (e.button === 0) {
                  onSwitch(t.id)
                }
              }}
            >
              <span className="tab-fav">
                {t.loading ? (
                  <span className="tab-spinner" />
                ) : showFav ? (
                  <img
                    className="tab-fav-img"
                    src={t.favicon as string}
                    alt=""
                    onError={() => t.favicon && markBroken(t.favicon)}
                  />
                ) : (
                  <span className="tab-fav-glyph">{hostInitial(t)}</span>
                )}
              </span>
              <span className="tab-title">{t.title || 'New Tab'}</span>
              <button
                className="tab-close"
                title="Close tab"
                onMouseDown={(e) => {
                  e.stopPropagation()
                  if (e.button === 0) onClose(t.id)
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path
                    d="M1 1l8 8M9 1l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          )
        })}
        <button className="tab-new" onClick={onNew} title="New tab (Ctrl+T)">
          <svg width="13" height="13" viewBox="0 0 14 14">
            <path
              d="M7 2v10M2 7h10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
