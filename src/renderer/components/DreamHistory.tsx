import { useEffect } from 'react'
import type { DreamHistoryEntry } from '../../../shared/types'

interface Props {
  entries: DreamHistoryEntry[]
  /** Optional callback for jumping back into the diff modal for the latest entry. */
  onOpenLatest?: () => void
  /** True iff the latest entry is still awaiting review (drives the action button). */
  latestAwaitingReview?: boolean
  onClose: () => void
}

/**
 * Read-only timeline of past dream runs (manual + auto, success + failure).
 *
 * Sourced from `.gladdis/dream-history.json` — the rolling N-entry log the
 * Dreamer appends to on every completion. Historical diffs themselves aren't
 * persisted (only the most-recent `memory.next.diff.json` is kept), so this
 * modal is intentionally summary-only; the user can re-open the latest
 * pending diff via the action row but can't time-travel back to old ones.
 */
export function DreamHistoryModal({
  entries,
  onOpenLatest,
  latestAwaitingReview,
  onClose
}: Props) {
  // Close on Escape to match the diff modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const empty = entries.length === 0

  return (
    <div
      className="modal-overlay dream-diff-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal dream-diff-modal" role="dialog" aria-label="Dream history">
        <div className="modal-head">
          <div>
            <div style={{ fontWeight: 600 }}>Dream history</div>
            <div className="dream-subtle">
              {empty
                ? 'No dreams yet — manual or auto.'
                : `${entries.length} run${entries.length === 1 ? '' : 's'} · newest first`}
            </div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body dream-diff-body">
          {empty ? (
            <div className="dream-empty">
              When you run a dream — or when auto-dream triggers — each run is logged here
              with its summary and adoption status.
            </div>
          ) : (
            <ul className="dream-history-list">
              {entries.map((row) => (
                <HistoryRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </div>

        <div className="modal-foot">
          {latestAwaitingReview && onOpenLatest && (
            <button className="dream-btn dream-btn-adopt" onClick={onOpenLatest}>
              Open latest diff
            </button>
          )}
          <button className="dream-btn dream-btn-discard" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function HistoryRow({ row }: { row: DreamHistoryEntry }) {
  const status = statusForRow(row)
  const summaryLine = row.ok ? summarize(row) : row.error ?? 'Dream failed.'
  return (
    <li className={`dream-history-row dream-history-${row.ok ? 'ok' : 'err'}`}>
      <div className="dream-history-row-head">
        <span
          className={`dream-history-source dream-history-source-${row.source}`}
          title={row.source === 'auto' ? 'Triggered by the scheduler' : 'Triggered manually'}
        >
          {row.source === 'auto' ? 'AUTO' : 'MANUAL'}
        </span>
        <span className="dream-history-time" title={new Date(row.completedAt).toISOString()}>
          {formatRelativeTime(row.completedAt)}
        </span>
        <span className="dream-history-scope">{row.scope}</span>
        <span className="dream-history-model">
          {row.modelProvider}:{row.modelId}
        </span>
        <span className={`dream-history-status dream-history-status-${status.tone}`}>
          {status.label}
        </span>
      </div>
      <div className="dream-history-summary">{summaryLine}</div>
    </li>
  )
}

function statusForRow(row: DreamHistoryEntry): { label: string; tone: string } {
  if (!row.ok) return { label: 'failed', tone: 'err' }
  if (row.autoAdopted) return { label: 'auto-adopted', tone: 'auto' }
  if (row.awaitingReview) return { label: 'awaiting review', tone: 'warn' }
  return { label: 'adopted', tone: 'ok' }
}

function summarize(row: DreamHistoryEntry): string {
  const s = row.summary
  if (!s) return 'No detail recorded.'
  const parts: string[] = []
  if (s.added) parts.push(`${s.added} added`)
  if (s.merged) parts.push(`${s.merged} merged`)
  if (s.replaced) parts.push(`${s.replaced} replaced`)
  if (s.rejected) parts.push(`${s.rejected} rejected`)
  if (s.archived) parts.push(`${s.archived} archived`)
  if (s.demoted) parts.push(`${s.demoted} demoted`)
  if (s.reinforced) parts.push(`${s.reinforced} reinforced`)
  return parts.length === 0 ? 'No changes' : parts.join(' · ')
}

/**
 * Same shape as MemoryButton.formatRelativeTime — duplicated rather than
 * extracted because (a) one helper, (b) two callers, (c) extracting it now
 * would force a shared util module just for this. Re-evaluate if a third
 * caller appears.
 */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'in the future'
  if (diff < 30_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}
