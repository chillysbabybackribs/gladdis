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
import type { AppCommand } from '../../../shared/appCommand'
import { DreamDiffModal } from './DreamDiff'
import { DreamHistoryModal } from './DreamHistory'
import { AutoDreamSettingsModal } from './AutoDreamSettings'

const STAGE_LABEL: Record<DreamStage, string> = {
  sampling: 'Sampling…',
  extracting: 'Extracting…',
  reconciling: 'Reconciling…',
  reviewing: 'Reviewing…',
  curating: 'Curating…',
  verifying: 'Verifying…',
  persisting: 'Saving…'
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
    if (raw === '24h' || raw === '7d' || raw === '30d' || raw === 'all') return raw
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
 * Memory lives in the application menu bar (Memory ▾), not in any panel. This
 * controller is mounted once at the workspace level — the same place the Agents
 * menu opens its builder modal — and reacts to the `memory:open` app-command
 * each Memory menu item emits. It renders no chrome of its own: a menu pick runs
 * the matching action and opens one of the existing dream modals.
 *
 *   Curate Memory…      → run a dream over the saved scope, then review the diff
 *   Review Last Dream…  → reopen the most recent dream's diff
 *   Dream History…      → list past runs
 *   Auto-dream Settings → edit the background-curation thresholds
 *
 * A dream never auto-applies — the user adopts or discards the diff. Memory is
 * per-workspace, so every action no-ops until a folder is open (the menu items
 * are themselves disabled in that state).
 */
export function MemoryController() {
  const [workspace, setWorkspace] = useState<Workspace>({ folder: null })
  const folder = workspace.folder

  // Track the active workspace folder directly — memory is per-folder, and the
  // menu items no-op until one is open.
  useEffect(() => {
    const off = window.gladdis.workspace.onUpdated(setWorkspace)
    void window.gladdis.workspace.get().then(setWorkspace)
    return off
  }, [])

  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState<DreamStage | null>(null)
  const [stageDetail, setStageDetail] = useState<string | null>(null)
  const [diff, setDiff] = useState<DreamDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [modalBusy, setModalBusy] = useState<'adopting' | 'discarding' | null>(null)
  const [autoConfig, setAutoConfig] = useState<DreamAutoConfig | null>(null)
  const [autoStatus, setAutoStatus] = useState<DreamAutoStatus | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [toast, setToast] = useState<DreamAutoNotification | null>(null)
  const [history, setHistory] = useState<DreamHistoryEntry[] | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeRunIdRef = useRef<string | null>(null)
  const adoptedCloseTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  // The handlers below are recreated each render but close over `folder`; the
  // command listener calls through this ref so it always runs the fresh ones
  // without re-subscribing on every render.
  const handlersRef = useRef<{
    runDream: (scope: DreamScope) => Promise<void>
    reviewLast: () => Promise<void>
    openHistory: () => Promise<void>
    openSettings: () => void
  } | null>(null)

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

  // Any open memory modal hides the native browser WebContentsView, which is
  // layered above the renderer and would otherwise paint over the overlay.
  useEffect(() => {
    const modalOpen = diff !== null || history !== null || settingsOpen
    window.gladdis.layout.setBrowserVisible(!modalOpen)
    return () => window.gladdis.layout.setBrowserVisible(true)
  }, [diff, history, settingsOpen])

  // Load auto-dream config + status + awaiting-review state when the folder
  // changes, so Review/Auto open with current data even before a dream runs.
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
        /* renderer-side; silent failure keeps the rest of the app usable */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folder])

  // Auto-dream completion notifications: brief toast + refreshed status/badge.
  useEffect(() => {
    const off = window.gladdis.dream.auto.onNotification((event) => {
      if (folder && event.workspaceRoot !== folder) return
      if (!event.ok) {
        console.error('[auto-dream]', event.message)
        return
      }
      setToast(event)
      clearToastTimer()
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null)
        toastTimerRef.current = null
      }, TOAST_DURATION_MS)
      if (folder) {
        void window.gladdis.dream.auto.status(folder).then((st) => setAutoStatus(st)).catch(() => {})
        if (event.awaitingReview) setAwaitingReview(true)
        if (event.autoAdopted) setAwaitingReview(false)
      }
    })
    return off
  }, [folder])

  // Dream progress stream — drives the "Sampling…/Saving…" status line.
  useEffect(() => {
    const off = window.gladdis.dream.onProgress((event: DreamProgressEvent) => {
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

  const runDream = async (chosenScope: DreamScope) => {
    if (!folder || running) return
    clearAdoptedCloseTimer()
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, chosenScope)
    } catch {
      /* ignore */
    }
    setRunning(true)
    setError(null)
    setSuccess(null)
    setStage('sampling')
    setStageDetail(null)
    try {
      const result = await window.gladdis.dream.run({
        workspaceRoot: folder,
        scope: chosenScope,
        preferenceOrder: readPreferencePref()
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
    setSuccess(null)
    const last = await window.gladdis.dream.loadLast(folder)
    if (last) {
      setDiff(last)
    } else {
      setError('No previous dream to review.')
      setAwaitingReview(false)
    }
  }

  const openHistory = async () => {
    if (!folder) return
    try {
      const file = await window.gladdis.dream.history.list(folder)
      setHistory(file.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openSettings = () => {
    if (!folder) return
    setSettingsOpen(true)
  }

  const openLatestDiffFromHistory = async () => {
    if (!folder) return
    setHistory(null)
    await reviewLast()
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

  handlersRef.current = { runDream, reviewLast, openHistory, openSettings }

  // Memory menu items emit `memory:open`. One subscription for the component's
  // lifetime, dispatching through handlersRef so it always runs fresh handlers.
  useEffect(() => {
    const off = window.gladdis.app.onCommand((command: AppCommand) => {
      if (command.type !== 'memory:open') return
      const h = handlersRef.current
      if (!h) return
      switch (command.section) {
        case 'curate':
          void h.runDream(readScopePref())
          break
        case 'review':
          void h.reviewLast()
          break
        case 'history':
          void h.openHistory()
          break
        case 'auto':
          h.openSettings()
          break
      }
    })
    return off
  }, [])

  const statusLine = running
    ? `${stage ? STAGE_LABEL[stage] : 'Dreaming…'}${stageDetail ? ` — ${stageDetail}` : ''}`
    : success

  return (
    <>
      {statusLine && (
        <div className="memory-status-toast" role="status" aria-live="polite">
          {statusLine}
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

      {error && !diff && (
        <div className="memory-error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {diff &&
        portalToWorkspace(
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
        portalToWorkspace(
          <DreamHistoryModal
            entries={history}
            latestAwaitingReview={awaitingReview}
            onOpenLatest={openLatestDiffFromHistory}
            onClose={() => setHistory(null)}
          />
        )}

      {settingsOpen && folder && autoConfig &&
        portalToWorkspace(
          <AutoDreamSettingsModal
            workspaceRoot={folder}
            initialConfig={autoConfig}
            status={autoStatus}
            onClose={() => setSettingsOpen(false)}
            onConfigChange={(next) => setAutoConfig(next)}
          />
        )}
    </>
  )
}

/**
 * Portal a memory modal into the `.workspace` root so its full-bleed overlay
 * covers the whole window. We avoid document.body because Electron lays the
 * native browser WebContentsView above the renderer; the browser view is hidden
 * while a memory modal is open (see the setBrowserVisible effect).
 */
function portalToWorkspace(modal: React.ReactNode): React.ReactNode {
  const target = document.querySelector('.workspace') as HTMLElement | null
  return target ? createPortal(modal, target) : modal
}
