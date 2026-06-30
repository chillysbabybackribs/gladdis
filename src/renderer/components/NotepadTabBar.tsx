import { useEffect, useRef, useState } from 'react'
import type { NotepadTab } from '../lib/notepadStorage'

interface Props {
  tabs: NotepadTab[]
  activeId: string
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onReorder: (id: string, toIndex: number) => void
}

const MAX_TITLE_LENGTH = 60

export function NotepadTabBar({
  tabs,
  activeId,
  onSwitch,
  onClose,
  onNew,
  onRename,
  onReorder
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const onDrop = (toIndex: number) => {
    if (dragId) onReorder(dragId, toIndex)
    setDragId(null)
    setOverIndex(null)
  }

  return (
    <div className="notepad-tabs" role="tablist" aria-label="Notepad notes">
      <div className="notepad-tabs-strip">
        {tabs.map((t, i) => {
          const active = t.id === activeId
          const editing = editingId === t.id
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              className={[
                'notepad-tab',
                active ? 'is-active' : '',
                dragId === t.id ? 'is-dragging' : '',
                overIndex === i && dragId && dragId !== t.id ? 'is-drop-target' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={t.title}
              draggable={!editing}
              onDragStart={(e) => {
                if (editing) return
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
                if (editing) return
                // Middle-click closes the tab — browser-tab muscle memory.
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(t.id)
                } else if (e.button === 0) {
                  onSwitch(t.id)
                }
              }}
              onDoubleClick={(e) => {
                e.preventDefault()
                setEditingId(t.id)
              }}
            >
              {editing ? (
                <RenameField
                  initial={t.title}
                  onCommit={(next) => {
                    setEditingId(null)
                    const trimmed = next.trim().slice(0, MAX_TITLE_LENGTH)
                    if (trimmed && trimmed !== t.title) onRename(t.id, trimmed)
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <span className="notepad-tab-title">{t.title || 'Untitled'}</span>
              )}
              {!editing && (
                <button
                  type="button"
                  className="notepad-tab-close"
                  title="Close note"
                  aria-label={`Close ${t.title || 'note'}`}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    if (e.button === 0) onClose(t.id)
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      d="M1 1l8 8M9 1l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          )
        })}
        <button
          type="button"
          className="notepad-tab-new"
          title="New note (Ctrl+T)"
          aria-label="New note"
          onClick={onNew}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
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

function RenameField({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  return (
    <input
      ref={ref}
      type="text"
      className="notepad-tab-rename"
      value={value}
      maxLength={MAX_TITLE_LENGTH}
      onChange={(e) => setValue(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}
