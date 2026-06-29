import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  DreamAdoptSelection,
  DreamAutoConfig,
  DreamAutoNotification,
  DreamAutoStatus,
  DreamDiff,
  DreamHistoryEntry,
  DreamPreferenceOrder,
  DreamProgressEvent,
  DreamScope,
  DreamStage,
  Workspace
} from '../../../shared/types'
import { DREAM_SCOPES } from '../../../shared/types'
import { DreamDiffModal } from './DreamDiff'
import { DreamHistoryModal } from './DreamHistory'
import { AutoDreamSettingsModal } from './AutoDreamSettings'

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
const ADOPTED_MODAL_CLOSE_MS = 2200
const TOAST_DURATION_MS = 6000

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
  const [success, setSuccess] = useState<string | null>(null)
  const [modalBusy, setModalBusy] = useState<'adopting' | 'discarding' | null>(null)
  const [scope, setScope] = useState<DreamScope>(() => readScopePref())
  const [preference, setPreference] = useState<DreamPreferenceOrder>(() => readPreferencePref())
  // Auto-dream surface: enabled flag drives the menu toggle; awaitingReview
  // drives the badge dot; lastDreamAt drives the "X hours ago" hint; toast
  // is the most-recent auto-dream completion notification (timed dismissal).
  const [autoConfig, setAutoConfig] = useState<DreamAutoConfig | null>(null)
  const [autoStatus, setAutoStatus] = useState<DreamAutoStatus | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [toast, setToast] = useState<DreamAutoNotification | null>(null)
  // Dream history modal: separate piece of UI state so it doesn't conflict
  // with the diff modal. Both are portaled into the chat panel.
  const [history, setHistory] = useState<DreamHistoryEntry[] | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const adoptedCloseTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const folder = workspace.folder

  const clearAdoptedCloseTimer = () => {
    if (adoptedCloseTimerRef.current === null) return
    window.clearTimeout(adoptedCloseTimerRef.current)
    adoptedCloseTimerRef.current = null
  }

  const clearToastTimer = () => {
    if (toastTimerRef.current === null) return
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = null
  }

  useEffect(() => () => {
    clearAdoptedCloseTimer()
    clearToastTimer()
  }, [])

  useEffect(() => {
    if (!open) return
    const onAway = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onAway)
    return () => window.removeEventListener('mousedown', onAway)
  }, [open])

  // Load (or reload) auto-dream config + status + awaiting-review state when
  // the workspace folder changes. Calling getConfig is a no-op on the main
  // side if the scheduler hasn't seen this folder yet — it lazy-starts.
  useEffect(() => {
    if (!folder) {
      setAutoConfig(null)
      setAutoStatus(null)
      setAwaitingReview(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [cfg, st, last] = await Promise.all([
          window.gladdis.dream.auto.getConfig(folder),
          window.gladdis.dream.auto.status(folder),
          window.gladdis.dream.loadLast(folder)
        ])
        if (cancelled) return
        setAutoConfig(cfg)
        setAutoStatus(st)
        setAwaitingReview(!!last && last.awaitingAdopt !== false)
      } catch {
        /* renderer-side; silent failure keeps the rest of the chat usable */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folder])

  // Subscribe to auto-dream completion notifications. We show a brief toast
  // and update the badge / status when the scheduler fires. Subscriptions
  // live for the component's lifetime; toasts auto-dismiss after a few seconds.
  useEffect(() => {
    const off = window.gladdis.dream.auto.onNotification((event) => {
      if (folder && event.workspaceRoot !== folder) return
      setToast(event)
      clearToastTimer()
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null)
        toastTimerRef.current = null
      }, TOAST_DURATION_MS)
      // Refresh status + awaitingReview so the menu and badge reflect reality
      // without the user having to reopen the workspace.
      if (folder) {
        void window.gladdis.dream.auto.status(folder).then((st) => setAutoStatus(st)).catch(() => {})
        if (event.awaitingReview) setAwaitingReview(true)
        if (event.autoAdopted) setAwaitingReview(false)
      }
    })
    return off
  }, [folder])

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
    clearAdoptedCloseTimer()
    persistScope(chosenScope)
    setOpen(false)
    setRunning(true)
    setError(null)
    setSuccess(null)
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
    clearAdoptedCloseTimer()
    setOpen(false)
    setSuccess(null)
    const last = await window.gladdis.dream.loadLast(folder)
    if (last) {
      setDiff(last)
      // Opening the diff counts as "seen"; the badge stays only until the
      // user makes a real decision (adopt/discard) so partial reviews don't
      // accidentally clear it forever.
    } else {
      setError('No previous dream to review.')
      setAwaitingReview(false)
    }
  }

  const openSettings = () => {
    if (!folder) return
    setOpen(false)
    setSettingsOpen(true)
  }

  const openHistory = async () => {
    if (!folder) return
    setOpen(false)
    try {
      const file = await window.gladdis.dream.history.list(folder)
      setHistory(file.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openLatestDiffFromHistory = async () => {
    if (!folder) return
    setHistory(null)
    await reviewLast()
  }

  const toggleAutoEnabled = async (next: boolean) => {
    if (!folder) return
    try {
      const updated = await window.gladdis.dream.auto.setConfig(folder, { enabled: next })
      setAutoConfig(updated)
      const st = await window.gladdis.dream.auto.status(folder)
      setAutoStatus(st)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const adopt = async (selection?: DreamAdoptSelection) => {
    if (!folder || !diff) return
    setModalBusy('adopting')
    setError(null)
    setSuccess(null)
    try {
      const result = await window.gladdis.dream.adopt(folder, selection)
      if (!result.ok) {
        setError(result.error ?? 'Adopt failed.')
        return
      }
      setDiff({ ...diff, awaitingAdopt: false })
      setOpen(false)
      setSuccess(selection ? 'Memory partially adopted.' : 'Memory adopted.')
      setAwaitingReview(false)
      clearAdoptedCloseTimer()
      adoptedCloseTimerRef.current = window.setTimeout(() => {
        setDiff(null)
        adoptedCloseTimerRef.current = null
      }, ADOPTED_MODAL_CLOSE_MS)
    } finally {
      setModalBusy(null)
    }
  }

  const discard = async () => {
    if (!folder || !diff) return
    clearAdoptedCloseTimer()
    setModalBusy('discarding')
    setError(null)
    try {
      await window.gladdis.dream.discard(folder)
      setDiff(null)
      setAwaitingReview(false)
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

  const autoEnabled = autoConfig?.enabled === true
  const showBadge = awaitingReview && !running
  const lastAutoLabel = autoStatus?.lastDreamAt
    ? `Last dream: ${formatRelativeTime(autoStatus.lastDreamAt)}`
    : 'No dreams yet'

  return (
    <div className="memory-btn-root" ref={rootRef}>
      <button
        className={`memory-btn${running ? ' is-running' : ''}${disabled ? ' is-disabled' : ''}${showBadge ? ' has-badge' : ''}`}
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
        {showBadge && (
          <span
            className="memory-btn-badge"
            aria-label="A dream is awaiting your review"
            title="A dream is awaiting your review"
          />
        )}
      </button>

      {running && stageDetail && (
        <div className="memory-stage-detail" role="status" aria-live="polite">
          {stageDetail}
        </div>
      )}

      {success && !running && (
        <div className="memory-stage-detail" role="status" aria-live="polite">
          {success}
        </div>
      )}

      {toast && (
        <div
          className={`memory-toast${toast.ok ? '' : ' is-error'}`}
          role="status"
          aria-live="polite"
          onClick={() => {
            setToast(null)
            clearToastTimer()
          }}
        >
          {toast.message}
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
          <div className="memory-menu-section">
            Auto-dream
            <button
              type="button"
              className="memory-menu-section-link"
              onClick={openSettings}
            >
              Settings…
            </button>
          </div>
          <label className="memory-auto-toggle">
            <input
              type="checkbox"
              checked={autoEnabled}
              onChange={(e) => void toggleAutoEnabled(e.target.checked)}
            />
            <span className="memory-auto-toggle-label">
              {autoEnabled ? 'On' : 'Off'}
              <span className="memory-auto-toggle-hint">
                {autoEnabled
                  ? `≥${autoConfig?.minHours ?? 24}h & ≥${autoConfig?.minSessions ?? 5} sessions`
                  : 'Curate quietly in the background'}
              </span>
            </span>
          </label>
          {autoEnabled && (
            <div className="memory-auto-status">
              <div className="memory-auto-status-row">
                <span>{lastAutoLabel}</span>
                <span className="memory-auto-status-meta">
                  {autoStatus?.sessionsSinceLastDream ?? 0} new sessions
                </span>
              </div>
              {autoStatus?.lastSkipReason && (
                <div className="memory-auto-status-reason" title={autoStatus.lastSkipReason}>
                  Last skip: {autoStatus.lastSkipReason}
                </div>
              )}
            </div>
          )}
          <div className="memory-menu-divider" />
          <button className="memory-menu-item" role="menuitem" onClick={reviewLast}>
            Review last dream{awaitingReview && <span className="memory-menu-default">new</span>}
          </button>
          <button className="memory-menu-item" role="menuitem" onClick={openHistory}>
            View dream history
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
            onClose={() => {
              clearAdoptedCloseTimer()
              setDiff(null)
            }}
          />
        )}

      {history !== null &&
        renderModalInChat(
          rootRef.current,
          <DreamHistoryModal
            entries={history}
            latestAwaitingReview={awaitingReview}
            onOpenLatest={openLatestDiffFromHistory}
            onClose={() => setHistory(null)}
          />
        )}

      {settingsOpen && folder && autoConfig &&
        renderModalInChat(
          rootRef.current,
          <AutoDreamSettingsModal
            workspaceRoot={folder}
            initialConfig={autoConfig}
            status={autoStatus}
            onClose={() => setSettingsOpen(false)}
            onConfigChange={(next) => setAutoConfig(next)}
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

/**
 * Compact "5m ago" / "3h ago" / "2d ago" formatter for the auto-dream
 * status line. Uses ms-level precision so a fresh dream from a second ago
 * reads "just now" instead of "0m ago".
 */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'in the future'
  if (diff < 30_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}
