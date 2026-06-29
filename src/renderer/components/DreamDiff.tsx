import { useEffect, useMemo } from 'react'
import type {
  DreamDiff,
  DreamDiffAction,
  DreamDiffEntry,
  DreamHygieneAction,
  DreamHygieneEntry,
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

const HYGIENE_LABEL: Record<DreamHygieneAction, string> = {
  archive: 'Archived',
  demote: 'Demoted',
  reinforce: 'Reinforced',
  keep: 'Reworded'
}

const HYGIENE_CLASS: Record<DreamHygieneAction, string> = {
  archive: 'dream-row-archive',
  demote: 'dream-row-demote',
  reinforce: 'dream-row-reinforce',
  keep: 'dream-row-reword'
}

export function DreamDiffModal({ diff, busy, onAdopt, onDiscard, onClose }: Props) {
  const sectioned = useMemo(() => groupByAction(diff.entries), [diff.entries])
  const hygiene = diff.hygiene ?? []
  const hygieneSectioned = useMemo(() => groupHygieneByAction(hygiene), [hygiene])
  const adoption = diff.adoption ?? { blocked: false, issues: [] }
  const reviewSummary = useMemo(() => deriveDreamReviewSummary(diff, hygiene), [diff, hygiene])
  const adoptButtonLabel = busy === 'adopting'
    ? 'Adopting...'
    : adoption.blocked
      ? 'Adoption blocked'
      : diff.awaitingAdopt
        ? 'Adopt'
        : 'Already adopted'
  const archived = diff.summary.archived ?? 0
  const demoted = diff.summary.demoted ?? 0
  const reinforced = diff.summary.reinforced ?? 0
  const verdictById = useMemo(() => {
    const map = new Map<string, { verdict: DreamVerificationVerdict; reason?: string }>()
    for (const v of diff.verifications) map.set(v.entryId, v)
    return map
  }, [diff.verifications])

  // Close on Escape — matches the behavior users expect from app-wide modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busy === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // Stays scoped to the chat panel that opened it. We tried portaling to
  // document.body but the native browser WebContentsView sits ABOVE the
  // renderer in Electron's compositor, so any portaled modal disappears
  // behind it. Inside the chat panel the modal is always visible because
  // the chat region is owned entirely by the React renderer.
  return (
    <div
      className="modal-overlay dream-diff-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && busy === null) onClose()
      }}
    >
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

        <div className="modal-body dream-diff-body">
          <div className="dream-summary">
            <SummaryPill label="New" count={diff.summary.added} cls="dream-pill-add" />
            <SummaryPill label="Merged" count={diff.summary.merged} cls="dream-pill-merge" />
            <SummaryPill label="Replaced" count={diff.summary.replaced} cls="dream-pill-replace" />
            <SummaryPill label="Rejected" count={diff.summary.rejected} cls="dream-pill-reject" />
            {archived > 0 && (
              <SummaryPill label="Archived" count={archived} cls="dream-pill-archive" />
            )}
            {demoted > 0 && (
              <SummaryPill label="Demoted" count={demoted} cls="dream-pill-demote" />
            )}
            {reinforced > 0 && (
              <SummaryPill label="Reinforced" count={reinforced} cls="dream-pill-reinforce" />
            )}
            <SummaryPill label="Unchanged" count={diff.summary.unchanged} cls="dream-pill-unchanged" />
          </div>

          <div className="dream-review-summary" aria-label="Dream review summary">
            <div className="dream-review-summary-title">Review summary</div>
            <ul>
              {reviewSummary.map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
          </div>

          {adoption.blocked && (
            <div className="dream-adoption-block">
              <div className="dream-adoption-title">Adoption blocked</div>
              <ul>
                {adoption.issues.slice(0, 4).map((issue, index) => (
                  <li key={`${issue.entryId}:${issue.code}:${index}`}>{issue.message}</li>
                ))}
                {adoption.issues.length > 4 && <li>{adoption.issues.length - 4} more issue{adoption.issues.length - 4 === 1 ? '' : 's'}</li>}
              </ul>
            </div>
          )}

          {diff.entries.length === 0 && hygiene.length === 0 ? (
            <div className="dream-empty">The dreamer didn't propose any changes. Try a wider scope or a different model.</div>
          ) : (
            <>
              {(['add', 'replace', 'merge', 'reject'] as DreamDiffAction[]).map((action) => {
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
              })}
              {(['archive', 'demote', 'reinforce', 'keep'] as DreamHygieneAction[]).map((action) => {
                const rows = hygieneSectioned[action]
                if (!rows || rows.length === 0) return null
                return (
                  <section key={`hygiene-${action}`} className="dream-section dream-section-hygiene">
                    <h4 className="dream-section-title">
                      {HYGIENE_LABEL[action]} ({rows.length})
                      <span className="dream-section-hint">existing entries · curated by the dream</span>
                    </h4>
                    <div className="dream-rows">
                      {rows.map((row) => (
                        <HygieneRow key={`${row.entryId}-${row.action}`} row={row} />
                      ))}
                    </div>
                  </section>
                )
              })}
            </>
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
            disabled={busy !== null || !diff.awaitingAdopt || adoption.blocked}
            title={adoption.blocked ? 'Resolve blocked dream rows before adopting' : undefined}
          >
            {adoptButtonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function deriveDreamReviewSummary(diff: DreamDiff, hygiene: DreamHygieneEntry[]): string[] {
  const added = diff.summary.added ?? 0
  const merged = diff.summary.merged ?? 0
  const replaced = diff.summary.replaced ?? 0
  const rejected = diff.summary.rejected ?? 0
  const archived = diff.summary.archived ?? 0
  const demoted = diff.summary.demoted ?? 0
  const reinforced = diff.summary.reinforced ?? 0
  const reworded = hygiene.filter((row) => row.action === 'keep').length
  const adoption = diff.adoption ?? { blocked: false, issues: [] }
  const promotable = added + merged + replaced
  const hygieneChanged = archived + demoted + reinforced + reworded
  const totalChanges = promotable + rejected + hygieneChanged
  const lines: string[] = []

  if (totalChanges === 0) {
    return [
      `The dream sampled ${plural(diff.sampledSessionCount, 'session')} and did not propose memory changes.`,
      'There is nothing to adopt from this run.'
    ]
  }

  const proposalParts = [
    added > 0 ? plural(added, 'new memory', 'new memories') : null,
    merged > 0 ? plural(merged, 'merge') : null,
    replaced > 0 ? plural(replaced, 'replacement') : null,
    rejected > 0 ? plural(rejected, 'rejection') : null
  ].filter(Boolean) as string[]
  const hygieneParts = [
    archived > 0 ? plural(archived, 'archive') : null,
    demoted > 0 ? plural(demoted, 'confidence demotion') : null,
    reinforced > 0 ? plural(reinforced, 'reinforcement') : null,
    reworded > 0 ? plural(reworded, 'wording cleanup') : null
  ].filter(Boolean) as string[]

  if (proposalParts.length > 0) {
    lines.push(`This dream proposes ${joinHuman(proposalParts)} from ${plural(diff.sampledSessionCount, 'sampled session')}.`)
  }
  if (hygieneParts.length > 0) {
    lines.push(`It also curates existing memory with ${joinHuman(hygieneParts)}.`)
  }

  if (!diff.awaitingAdopt) {
    lines.push('There is no pending candidate to adopt; this review is historical.')
  } else if (adoption.blocked) {
    lines.push(`Adoption is blocked by ${plural(adoption.issues.length, 'review issue')} that must be resolved before promotion.`)
  } else {
    lines.push('Adoption is available; the detailed rows below remain the source of truth before promoting the candidate.')
  }

  const existingTouched = merged + replaced + hygieneChanged
  if (existingTouched > 0) {
    lines.push(`${plural(existingTouched, 'existing memory')} would be updated, curated, or retired if adopted.`)
  } else if (added > 0) {
    lines.push('No existing memory text would be overwritten; this run only adds or rejects candidate memories.')
  }

  const partial = diff.verifications.filter((v) => v.verdict === 'partial').length
  const unsupported = diff.verifications.filter((v) => v.verdict === 'unsupported').length
  if (partial > 0 || unsupported > 0) {
    const warningParts = [
      unsupported > 0 ? plural(unsupported, 'unsupported verification') : null,
      partial > 0 ? plural(partial, 'partial verification') : null
    ].filter(Boolean) as string[]
    lines.push(`Verification found ${joinHuman(warningParts)}.`)
  }

  const commonKind = mostCommonKind([...diff.entries, ...hygiene])
  if (commonKind) {
    lines.push(`Most reviewed rows are ${KIND_LABEL[commonKind]} memories.`)
  }

  return lines.slice(0, 6)
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

function HygieneRow({ row }: { row: DreamHygieneEntry }) {
  const confidenceMoved =
    row.previousConfidence !== undefined &&
    Math.abs(row.previousConfidence - row.confidence) >= 0.005
  return (
    <div className={`dream-row ${HYGIENE_CLASS[row.action]}`}>
      <div className="dream-row-head">
        <span className="dream-kind">{KIND_LABEL[row.kind]}</span>
        <span className="dream-scope">
          {row.scope}
          {row.taskId ? `:${row.taskId.slice(0, 8)}` : ''}
        </span>
        {confidenceMoved ? (
          <span className="dream-confidence" title="confidence change">
            c={row.previousConfidence!.toFixed(2)} → {row.confidence.toFixed(2)}
          </span>
        ) : (
          <span className="dream-confidence" title="confidence">
            c={row.confidence.toFixed(2)}
          </span>
        )}
        <span className={`dream-hygiene-tag dream-hygiene-${row.action}`}>{HYGIENE_LABEL[row.action]}</span>
      </div>
      <div className="dream-text">{row.text}</div>
      {row.previousText && row.previousText !== row.text && (
        <div className="dream-prev">
          was: <span>{row.previousText}</span>
        </div>
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

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`
}

function joinHuman(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

function mostCommonKind(entries: Array<DreamDiffEntry | DreamHygieneEntry>): MemoryEntryKindLite | null {
  if (entries.length === 0) return null
  const counts = new Map<MemoryEntryKindLite, number>()
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
  let best: { kind: MemoryEntryKindLite; count: number } | null = null
  for (const [kind, count] of counts) {
    if (!best || count > best.count) best = { kind, count }
  }
  return best && best.count > 1 ? best.kind : null
}

function groupHygieneByAction(
  entries: DreamHygieneEntry[]
): Partial<Record<DreamHygieneAction, DreamHygieneEntry[]>> {
  const out: Partial<Record<DreamHygieneAction, DreamHygieneEntry[]>> = {}
  for (const e of entries) {
    const list = out[e.action] ?? (out[e.action] = [])
    list.push(e)
  }
  return out
}
