import { useMemo } from 'react'
import type {
  DreamDiff,
  DreamDiffAction,
  DreamDiffEntry,
  DreamVerificationVerdict,
  MemoryEntryKindLite
} from '../../../shared/types'

interface Props {
  diff: DreamDiff
  busy: 'adopting' | 'discarding' | null
  onAdopt: () => void
  onDiscard: () => void
  onClose: () => void
}

const ACTION_LABEL: Record<DreamDiffAction, string> = {
  add: 'New',
  merge: 'Merged',
  replace: 'Replaced',
  reject: 'Rejected',
  unchanged: 'Unchanged'
}

const ACTION_CLASS: Record<DreamDiffAction, string> = {
  add: 'dream-row-add',
  merge: 'dream-row-merge',
  replace: 'dream-row-replace',
  reject: 'dream-row-reject',
  unchanged: 'dream-row-unchanged'
}

const KIND_LABEL: Record<MemoryEntryKindLite, string> = {
  preference: 'preference',
  'project-fact': 'project fact',
  decision: 'decision',
  playbook: 'playbook',
  caveat: 'caveat',
  pattern: 'pattern',
  legacy: 'legacy'
}

export function DreamDiffModal({ diff, busy, onAdopt, onDiscard, onClose }: Props) {
  const sectioned = useMemo(() => groupByAction(diff.entries), [diff.entries])
  const verdictById = useMemo(() => {
    const map = new Map<string, { verdict: DreamVerificationVerdict; reason?: string }>()
    for (const v of diff.verifications) map.set(v.entryId, v)
    return map
  }, [diff.verifications])

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal dream-diff-modal" role="dialog" aria-label="Memory dream diff">
        <div className="modal-head">
          <div>
            <div style={{ fontWeight: 600 }}>Memory dream</div>
            <div className="dream-subtle">
              {diff.modelProvider} · {diff.modelId} · {diff.sampledSessionCount} session{diff.sampledSessionCount === 1 ? '' : 's'} ({diff.scope})
            </div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body" style={{ overflow: 'auto', maxHeight: '70vh' }}>
          <div className="dream-summary">
            <SummaryPill label="New" count={diff.summary.added} cls="dream-pill-add" />
            <SummaryPill label="Merged" count={diff.summary.merged} cls="dream-pill-merge" />
            <SummaryPill label="Replaced" count={diff.summary.replaced} cls="dream-pill-replace" />
            <SummaryPill label="Rejected" count={diff.summary.rejected} cls="dream-pill-reject" />
            <SummaryPill label="Unchanged" count={diff.summary.unchanged} cls="dream-pill-unchanged" />
          </div>

          {diff.entries.length === 0 ? (
            <div className="dream-empty">The dreamer didn't propose any changes. Try a wider scope or a different model.</div>
          ) : (
            (['add', 'replace', 'merge', 'reject'] as DreamDiffAction[]).map((action) => {
              const rows = sectioned[action]
              if (!rows || rows.length === 0) return null
              return (
                <section key={action} className="dream-section">
                  <h4 className="dream-section-title">{ACTION_LABEL[action]} ({rows.length})</h4>
                  <div className="dream-rows">
                    {rows.map((row) => (
                      <DreamRow
                        key={row.entryId}
                        row={row}
                        verification={verdictById.get(row.entryId)}
                      />
                    ))}
                  </div>
                </section>
              )
            })
          )}
        </div>

        <div className="modal-foot">
          <button
            className="dream-btn dream-btn-discard"
            onClick={onDiscard}
            disabled={busy !== null || !diff.awaitingAdopt}
          >
            {busy === 'discarding' ? 'Discarding…' : 'Discard'}
          </button>
          <button
            className="dream-btn dream-btn-adopt"
            onClick={onAdopt}
            disabled={busy !== null || !diff.awaitingAdopt}
          >
            {busy === 'adopting' ? 'Adopting…' : diff.awaitingAdopt ? 'Adopt' : 'Already adopted'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DreamRow({
  row,
  verification
}: {
  row: DreamDiffEntry
  verification?: { verdict: DreamVerificationVerdict; reason?: string }
}) {
  return (
    <div className={`dream-row ${ACTION_CLASS[row.action]}`}>
      <div className="dream-row-head">
        <span className="dream-kind">{KIND_LABEL[row.kind]}</span>
        <span className="dream-scope">{row.scope}{row.taskId ? `:${row.taskId.slice(0, 8)}` : ''}</span>
        <span className="dream-confidence" title="confidence">c={row.confidence.toFixed(2)}</span>
        <span className="dream-evidence" title="evidence sources">ev×{row.evidenceCount}</span>
        {verification && (
          <span className={`dream-verdict dream-verdict-${verification.verdict}`} title={verification.reason}>
            {verification.verdict}
          </span>
        )}
      </div>
      <div className="dream-text">{row.text}</div>
      {row.previousText && (
        <div className="dream-prev">was: <span>{row.previousText}</span></div>
      )}
      {row.reason && <div className="dream-reason">{row.reason}</div>}
    </div>
  )
}

function SummaryPill({ label, count, cls }: { label: string; count: number; cls: string }) {
  return (
    <span className={`dream-pill ${cls}`}>
      <span className="dream-pill-n">{count}</span> {label}
    </span>
  )
}

function groupByAction(entries: DreamDiffEntry[]): Partial<Record<DreamDiffAction, DreamDiffEntry[]>> {
  const out: Partial<Record<DreamDiffAction, DreamDiffEntry[]>> = {}
  for (const e of entries) {
    const list = out[e.action] ?? (out[e.action] = [])
    list.push(e)
  }
  return out
}
