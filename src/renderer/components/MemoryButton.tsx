import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  DreamDiff,
  DreamPreferenceOrder,
  DreamProgressEvent,
  DreamScope,
  DreamStage,
  Workspace
} from '../../../shared/types'
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

const STAGE_LABEL: Record<DreamStage, string> = {
  sampling: 'Sampling…',
  extracting: 'Extracting…',
  reconciling: 'Reconciling…',
  reviewing: 'Reviewing…',
  curating: 'Curating…',
  verifying: 'Verifying…',
  persisting: 'Saving…'
}

const PREFERENCE_LABEL: Record<DreamPreferenceOrder, string> = {
  cheapest: 'Cheapest',
  best: 'Best'
}

const DEFAULT_SCOPE: DreamScope = '7d'
const DEFAULT_PREFERENCE: DreamPreferenceOrder = 'cheapest'

const SCOPE_STORAGE_KEY = 'gladdis:dream:scope'
const PREFERENCE_STORAGE_KEY = 'gladdis:dream:preferenceOrder'

function readScopePref(): DreamScope {
  try {
    const raw = localStorage.getItem(SCOPE_STORAGE_KEY)
    if (raw && (DREAM_SCOPES as readonly string[]).includes(raw)) return raw as DreamScope
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_SCOPE
}

function readPreferencePref(): DreamPreferenceOrder {
  try {
    const raw = localStorage.getItem(PREFERENCE_STORAGE_KEY)
    if (raw === 'cheapest' || raw === 'best') return raw
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_PREFERENCE
}

/**
 * Memory ▾ button. Opens a small menu with scope choices, a Cheapest/Best
 * model preference toggle, and "Review last dream". A dream never auto-
 * applies — the user reviews the diff and chooses to adopt or discard. Memory
 * is per-workspace, so the button only enables when a folder is selected.
 *
 * While a dream is running, the button live-updates with the current stage
 * (sampling → extracting → reconciling → verifying → saving) using the
 * dream:progress event stream from main.
 */
export function MemoryButton({ workspace }: Props) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState<DreamStage | null>(null)
  const [stageDetail, setStageDetail] = useState<string | null>(null)
  const [diff, setDiff] = useState<DreamDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modalBusy, setModalBusy] = useState<'adopting' | 'discarding' | null>(null)
  const [scope, setScope] = useState<DreamScope>(() => readScopePref())
  const [preference, setPreference] = useState<DreamPreferenceOrder>(() => readPreferencePref())
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeRunIdRef = useRef<string | null>(null)

  const folder = workspace.folder

  useEffect(() => {
    if (!open) return
    const onAway = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onAway)
    return () => window.removeEventListener('mousedown', onAway)
  }, [open])

  // Subscribe to dream progress for the lifetime of the component.
  useEffect(() => {
    const off = window.gladdis.dream.onProgress((event: DreamProgressEvent) => {
      // Ignore events for other workspaces or stale runs entirely. The run we
      // care about is whichever one this component kicked off.
      if (event.workspaceRoot !== folder) return
      if (activeRunIdRef.current && event.runId !== activeRunIdRef.current && event.type !== 'started') {
        return
      }
      if (event.type === 'started') {
        activeRunIdRef.current = event.runId
        setStage('sampling')
        setStageDetail(null)
      } else if (event.type === 'stage') {
        setStage(event.stage)
        setStageDetail(event.detail ?? null)
      } else if (event.type === 'done') {
        activeRunIdRef.current = null
        setStage(null)
        setStageDetail(null)
      }
    })
    return off
  }, [folder])

  const persistScope = (next: DreamScope) => {
    setScope(next)
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const persistPreference = (next: DreamPreferenceOrder) => {
    setPreference(next)
    try {
      localStorage.setItem(PREFERENCE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const runDream = async (chosenScope: DreamScope) => {
    if (!folder || running) return
    persistScope(chosenScope)
    setOpen(false)
    setRunning(true)
    setError(null)
    setStage('sampling')
    setStageDetail(null)
    try {
      const result = await window.gladdis.dream.run({
        workspaceRoot: folder,
        scope: chosenScope,
        preferenceOrder: preference
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
      setStage(null)
      setStageDetail(null)
      activeRunIdRef.current = null
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
  const buttonLabel = running
    ? stage
      ? STAGE_LABEL[stage]
      : 'Dreaming…'
    : 'Memory'
  const title = disabled
    ? 'Open a workspace folder to dream over its memory'
    : running
      ? `${buttonLabel}${stageDetail ? ` — ${stageDetail}` : ''}`
      : 'Curate memory from recent conversations'

  return (
    <div className="memory-btn-root" ref={rootRef}>
      <button
        className={`memory-btn${running ? ' is-running' : ''}${disabled ? ' is-disabled' : ''}`}
        onClick={() => !disabled && !running && setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="memory-btn-icon" aria-hidden="true">
          {running ? <span className="memory-btn-spinner" /> : '✦'}
        </span>
        <span className="memory-btn-label">{buttonLabel}</span>
        {!running && <span className="memory-btn-caret" aria-hidden="true">▾</span>}
      </button>

      {running && stageDetail && (
        <div className="memory-stage-detail" role="status" aria-live="polite">
          {stageDetail}
        </div>
      )}

      {open && !running && (
        <div className="memory-menu" role="menu">
          <div className="memory-menu-section">Curate memory from…</div>
          {DREAM_SCOPES.map((s) => (
            <button
              key={s}
              className={`memory-menu-item${s === scope ? ' is-selected' : ''}`}
              role="menuitem"
              onClick={() => runDream(s)}
            >
              {SCOPE_LABEL[s]}
              {s === DEFAULT_SCOPE && <span className="memory-menu-default">recommended</span>}
            </button>
          ))}
          <div className="memory-menu-divider" />
          <div className="memory-menu-section">Model preference</div>
          <div className="memory-pref-row" role="radiogroup" aria-label="Model preference order">
            {(['cheapest', 'best'] as DreamPreferenceOrder[]).map((p) => (
              <button
                key={p}
                role="radio"
                aria-checked={preference === p}
                className={`memory-pref-pill${preference === p ? ' is-active' : ''}`}
                onClick={() => persistPreference(p)}
              >
                {PREFERENCE_LABEL[p]}
              </button>
            ))}
          </div>
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

      {diff &&
        renderModalInChat(
          rootRef.current,
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

/**
 * Portal the DreamDiff modal up to the nearest `.chat` ancestor so its
 * full-bleed overlay covers the chat panel rather than the tiny
 * `.memory-btn-root` (which is the closest positioned ancestor of the
 * button itself). We deliberately stop at `.chat` and not at document.body
 * because Electron lays the native browser WebContentsView on top of the
 * renderer, so anything rendered into document.body disappears behind the
 * browser pane on the right side of the window.
 */
function renderModalInChat(buttonRoot: HTMLDivElement | null, modal: React.ReactNode): React.ReactNode {
  const target = buttonRoot?.closest('.chat') as HTMLElement | null
  if (!target) return modal
  return createPortal(modal, target)
}
