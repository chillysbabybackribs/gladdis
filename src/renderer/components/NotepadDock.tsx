import { useCallback, useEffect, useRef, useState } from 'react'
import type { Block } from '@blocknote/core'
import { NotepadEditor } from './NotepadEditor'
import { NotepadTabBar } from './NotepadTabBar'
import {
  emptyTab,
  loadNotepadState,
  saveNotepadState,
  type NotepadState,
  type NotepadTab
} from '../lib/notepadStorage'

export type NotepadDockPos = 'left' | 'right' | 'bottom'

interface Props {
  dock: NotepadDockPos
  onClose: () => void
  onDockChange: (next: NotepadDockPos) => void
  height?: number
  onHeightChange?: (next: number) => void
}

const MIN_BOTTOM_HEIGHT = 120
const MAX_BOTTOM_HEIGHT_FRAC = 0.8
const SAVE_DEBOUNCE_MS = 400

export function NotepadDock({
  dock,
  onClose,
  onDockChange,
  height = 280,
  onHeightChange
}: Props) {
  const isBottom = dock === 'bottom'

  // Single source of truth for the notepad workspace. The editor below pumps
  // block changes back up through `onEditorChange`; we debounce-persist here.
  const [state, setState] = useState<NotepadState>(loadNotepadState)
  const saveTimerRef = useRef<number | null>(null)
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const scheduleSave = useCallback((next: NotepadState) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveNotepadState(next)
      saveTimerRef.current = null
    }, SAVE_DEBOUNCE_MS)
  }, [])

  // Persistence happens on every state mutation; the unmount flush below
  // covers the case where the dock is closed before the debounce fires.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveNotepadState(stateRef.current)
      }
    }
  }, [])

  const updateState = useCallback(
    (mutator: (prev: NotepadState) => NotepadState) => {
      setState((prev) => {
        const next = mutator(prev)
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave]
  )

  const activeTab = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]

  const onEditorChange = useCallback(
    (blocks: Block[]) => {
      updateState((prev) => {
        const tabs = prev.tabs.map((t) =>
          t.id === prev.activeId ? { ...t, blocks, updatedAt: Date.now() } : t
        )
        return { ...prev, tabs }
      })
    },
    [updateState]
  )

  const onSwitch = useCallback(
    (id: string) => updateState((prev) => ({ ...prev, activeId: id })),
    [updateState]
  )

  const onNew = useCallback(() => {
    updateState((prev) => {
      const nextIndex = prev.tabs.length + 1
      const t = emptyTab(`Note ${nextIndex}`)
      return { tabs: [...prev.tabs, t], activeId: t.id }
    })
  }, [updateState])

  const onCloseTab = useCallback(
    (id: string) => {
      updateState((prev) => {
        // Never let the notepad get to zero tabs — closing the last tab
        // wipes it and leaves a fresh empty "Note 1" behind.
        if (prev.tabs.length <= 1) {
          const fresh = emptyTab('Note 1')
          return { tabs: [fresh], activeId: fresh.id }
        }
        const idx = prev.tabs.findIndex((t) => t.id === id)
        if (idx === -1) return prev
        const tabs = prev.tabs.filter((t) => t.id !== id)
        const activeId =
          prev.activeId === id ? tabs[Math.max(0, idx - 1)].id : prev.activeId
        return { tabs, activeId }
      })
    },
    [updateState]
  )

  const onRename = useCallback(
    (id: string, title: string) => {
      updateState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === id ? { ...t, title, updatedAt: Date.now() } : t
        )
      }))
    },
    [updateState]
  )

  const onReorder = useCallback(
    (id: string, toIndex: number) => {
      updateState((prev) => {
        const from = prev.tabs.findIndex((t) => t.id === id)
        if (from === -1 || from === toIndex) return prev
        const tabs = prev.tabs.slice()
        const [moved] = tabs.splice(from, 1)
        tabs.splice(toIndex, 0, moved)
        return { ...prev, tabs }
      })
    },
    [updateState]
  )

  // Ctrl+T inside the notepad surface spawns a new tab. Scoped to keydown on
  // the dock root so it never collides with browser/chat shortcuts elsewhere.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !e.shiftKey) {
      e.preventDefault()
      onNew()
    }
  }

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
    <div
      className={`notepad-dock notepad-dock-${dock}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      {isBottom && onHeightChange && (
        <BottomSplitter height={height} onChange={onHeightChange} />
      )}
      <div className="notepad-dock-chrome">
        <NotepadTabBar
          tabs={state.tabs}
          activeId={activeTab.id}
          onSwitch={onSwitch}
          onClose={onCloseTab}
          onNew={onNew}
          onRename={onRename}
          onReorder={onReorder}
        />
        <div className="notepad-dock-actions" role="group" aria-label="Notepad controls">
          <div className="notepad-dock-picker" role="group" aria-label="Notepad dock position">
            <DockBtn pos="left" current={dock} onClick={() => onDockChange('left')} />
            <DockBtn pos="bottom" current={dock} onClick={() => onDockChange('bottom')} />
            <DockBtn pos="right" current={dock} onClick={() => onDockChange('right')} />
          </div>
          <button
            type="button"
            className="notepad-dock-close"
            title="Close notepad"
            aria-label="Close notepad"
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
      </div>
      <div className="notepad-dock-body">
        <NotepadEditor
          key={activeTab.id}
          tabId={activeTab.id}
          initialBlocks={activeTab.blocks}
          onChange={onEditorChange}
        />
      </div>
    </div>
  )
}

function DockBtn({
  pos,
  current,
  onClick
}: {
  pos: NotepadDockPos
  current: NotepadDockPos
  onClick: () => void
}) {
  const active = pos === current
  const label =
    pos === 'bottom' ? 'Dock to bottom' : pos === 'left' ? 'Dock to left chat' : 'Dock to right chat'
  return (
    <button
      type="button"
      className={`notepad-dock-btn ${active ? 'is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <DockIcon pos={pos} />
    </button>
  )
}

function DockIcon({ pos }: { pos: NotepadDockPos }) {
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
  onChange
}: {
  height: number
  onChange: (height: number) => void
}) {
  const dragging = useRef(false)
  const lastReportedRef = useRef(height)

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      const wh = window.innerHeight
      const max = Math.floor(wh * MAX_BOTTOM_HEIGHT_FRAC)
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
    lastReportedRef.current = height
    document.body.style.cursor = 'row-resize'
    const shield = document.createElement('div')
    shield.id = 'gladdis-drag-shield'
    shield.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize'
    document.body.appendChild(shield)
  }

  return (
    <div
      className="notepad-splitter"
      onPointerDown={start}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize notepad"
    >
      <span className="notepad-splitter-grip" />
    </div>
  )
}
