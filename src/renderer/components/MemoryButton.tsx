import { useEffect, useRef, useState } from 'react'
import type { DreamDiff, DreamScope, Workspace } from '../../../shared/types'
import { DREAM_SCOPES } from '../../../shared/types'
import { DreamDiffModal } from './DreamDiff'

interface Props {
  workspace: Workspace
}

const SCOPE_LABEL: Record<DreamScope, string> = {
  '24h': 'Last 24h',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time'
}

const DEFAULT_SCOPE: DreamScope = '7d'

/**
 * Memory ▾ button. Opens a small menu with scope choices + "Review last
 * dream". A dream is one model-curated proposal of changes to the workspace's
 * memory file. It never auto-applies — the user reviews the diff and chooses
 * to adopt or discard. Memory is per-workspace, so the button only enables
 * when a folder is selected.
 */
export function MemoryButton({ workspace }: Props) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [diff, setDiff] = useState<DreamDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modalBusy, setModalBusy] = useState<'adopting' | 'discarding' | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const folder = workspace.folder

  useEffect(() => {
    if (!open) return
    const onAway = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onAway)
    return () => window.removeEventListener('mousedown', onAway)
  }, [open])

  const runDream = async (scope: DreamScope) => {
    if (!folder || running) return
    setOpen(false)
    setRunning(true)
    setError(null)
    try {
      const result = await window.gladdis.dream.run({
        workspaceRoot: folder,
        scope,
        preferenceOrder: 'cheapest'
      })
      if (result.ok) {
        setDiff(result.diff)
      } else {
        setError(result.error)
        if (result.partial) setDiff(result.partial)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const reviewLast = async () => {
    if (!folder) return
    setOpen(false)
    const last = await window.gladdis.dream.loadLast(folder)
    if (last) setDiff(last)
    else setError('No previous dream to review.')
  }

  const adopt = async () => {
    if (!folder || !diff) return
    setModalBusy('adopting')
    setError(null)
    try {
      const result = await window.gladdis.dream.adopt(folder)
      if (!result.ok) {
        setError(result.error ?? 'Adopt failed.')
        return
      }
      setDiff({ ...diff, awaitingAdopt: false })
    } finally {
      setModalBusy(null)
    }
  }

  const discard = async () => {
    if (!folder || !diff) return
    setModalBusy('discarding')
    setError(null)
    try {
      await window.gladdis.dream.discard(folder)
      setDiff(null)
    } finally {
      setModalBusy(null)
    }
  }

  const disabled = !folder
  const title = disabled
    ? 'Open a workspace folder to dream over its memory'
    : running
      ? 'Dreaming…'
      : 'Curate memory from recent conversations'

  return (
    <div className="memory-btn-root" ref={rootRef}>
      <button
        className={`memory-btn${running ? ' is-running' : ''}${disabled ? ' is-disabled' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="memory-btn-icon" aria-hidden="true">
          {running ? '◐' : '✦'}
        </span>
        <span className="memory-btn-label">{running ? 'Dreaming…' : 'Memory'}</span>
        <span className="memory-btn-caret" aria-hidden="true">▾</span>
      </button>

      {open && !running && (
        <div className="memory-menu" role="menu">
          <div className="memory-menu-section">Curate memory from…</div>
          {DREAM_SCOPES.map((scope) => (
            <button
              key={scope}
              className={`memory-menu-item${scope === DEFAULT_SCOPE ? ' is-default' : ''}`}
              role="menuitem"
              onClick={() => runDream(scope)}
            >
              {SCOPE_LABEL[scope]}
              {scope === DEFAULT_SCOPE && <span className="memory-menu-default">recommended</span>}
            </button>
          ))}
          <div className="memory-menu-divider" />
          <button className="memory-menu-item" role="menuitem" onClick={reviewLast}>
            Review last dream
          </button>
        </div>
      )}

      {error && !diff && (
        <div className="memory-error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {diff && (
        <DreamDiffModal
          diff={diff}
          busy={modalBusy}
          onAdopt={adopt}
          onDiscard={discard}
          onClose={() => setDiff(null)}
        />
      )}
    </div>
  )
}
