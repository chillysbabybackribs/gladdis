import { useEffect, useMemo, useState } from 'react'
import type {
  DreamAdoptionIssue,
  DreamAdoptSelection,
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
  /**
   * When `selection` is undefined, every row is being adopted (legacy fast
   * path). When provided, only the listed rows are kept; the rest fall back
   * to live memory. Either way the modal is the single source of truth for
   * what gets promoted.
   */
  onAdopt: (selection?: DreamAdoptSelection) => void
  onDiscard: () => void
  onClose: () => void
}

interface DreamReviewSummary {
  overview: string
  proposals: string[]
  existingMemory: string[]
  verification: string[]
  recommendation: string
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
  const archived = diff.summary.archived ?? 0
  const demoted = diff.summary.demoted ?? 0
  const reinforced = diff.summary.reinforced ?? 0
  const verdictById = useMemo(() => {
    const map = new Map<string, { verdict: DreamVerificationVerdict; reason?: string }>()
    for (const v of diff.verifications) map.set(v.entryId, v)
    return map
  }, [diff.verifications])

  // Adoption issues are still detected by the dreamer (low confidence, thin
  // evidence, verifier verdicts) — we just stopped treating them as a global
  // veto. Instead, each issue gets attached to its specific row via this map,
  // and flagged rows start unchecked so the user has to opt in deliberately.
  // The strict auto-adopt path still consults `adoption.blocked`, so the
  // detection is doing real work — just not in this modal.
  const issuesByEntry = useMemo(() => {
    const map = new Map<string, DreamAdoptionIssue[]>()
    for (const issue of adoption.issues) {
      const list = map.get(issue.entryId)
      if (list) list.push(issue)
      else map.set(issue.entryId, [issue])
    }
    return map
  }, [adoption.issues])

  // Which diff rows are actually interactive: reject rows are no-ops, so they
  // don't get checkboxes. Hygiene "keep" rows that didn't reword anything
  // also have no effect; we still expose them for transparency but they
  // start checked because their selection has no impact either way.
  const promotableEntryIds = useMemo(
    () => diff.entries.filter((r) => isPromotable(r.action)).map((r) => r.entryId),
    [diff.entries]
  )
  const actionableHygieneIds = useMemo(() => hygiene.map((r) => r.entryId), [hygiene])

  // Initial selection: every promotable row that does NOT have an adoption
  // issue starts checked. Flagged rows (thin evidence, low confidence,
  // unsupported/partial verification) stay unchecked so adopting "everything"
  // never silently sneaks risky content past the user — but the user can
  // still tick them back on if they've reviewed and accepted the risk. Two
  // sets so a diff entry and a hygiene entry can share an entryId without
  // their checkboxes ghosting each other.
  const initialSelectedEntries = useMemo(
    () => new Set(promotableEntryIds.filter((id) => !issuesByEntry.has(id))),
    [promotableEntryIds, issuesByEntry]
  )
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(initialSelectedEntries)
  const [selectedHygiene, setSelectedHygiene] = useState<Set<string>>(
    () => new Set(actionableHygieneIds)
  )

  // If the underlying diff swaps (re-open, history view, etc.) reset the
  // selection so we don't carry stale checked-state across runs.
  useEffect(() => {
    setSelectedEntries(initialSelectedEntries)
    setSelectedHygiene(new Set(actionableHygieneIds))
  }, [diff.id, initialSelectedEntries, actionableHygieneIds])

  const toggleEntry = (entryId: string) => {
    setSelectedEntries((prev) => toggleInSet(prev, entryId))
  }
  const toggleHygiene = (entryId: string) => {
    setSelectedHygiene((prev) => toggleInSet(prev, entryId))
  }
  const setAllSelected = (on: boolean) => {
    setSelectedEntries(new Set(on ? promotableEntryIds : []))
    setSelectedHygiene(new Set(on ? actionableHygieneIds : []))
  }

  const totalActionable = promotableEntryIds.length + actionableHygieneIds.length
  const totalSelected = selectedEntries.size + selectedHygiene.size
  const isPartialAdopt =
    totalSelected < totalActionable && totalActionable > 0
  const nothingSelected = totalSelected === 0
  // Adopt is gated only on "is there something selected"; weak/unverified rows
  // remain selectable and the per-row badge is the user-facing signal.
  const adoptButtonLabel = busy === 'adopting'
    ? 'Adopting…'
    : !diff.awaitingAdopt
      ? 'Already adopted'
      : isPartialAdopt
        ? `Adopt ${totalSelected} of ${totalActionable}`
        : 'Adopt all'

  const handleAdopt = () => {
    if (!diff.awaitingAdopt || nothingSelected) return
    if (isPartialAdopt) {
      onAdopt({
        acceptedEntryIds: Array.from(selectedEntries),
        acceptedHygieneIds: Array.from(selectedHygiene)
      })
    } else {
      onAdopt()
    }
  }

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
            <div className="dream-review-summary-title">Human summary</div>
            <div className="dream-review-summary-section">
              <div className="dream-review-summary-heading">Overview</div>
              <p>{reviewSummary.overview}</p>
            </div>
            {reviewSummary.proposals.length > 0 && (
              <div className="dream-review-summary-section">
                <div className="dream-review-summary-heading">What this dream wants to change</div>
                <ul>
                  {reviewSummary.proposals.map((line, index) => (
                    <li key={`proposal:${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            {reviewSummary.existingMemory.length > 0 && (
              <div className="dream-review-summary-section">
                <div className="dream-review-summary-heading">Impact on existing memory</div>
                <ul>
                  {reviewSummary.existingMemory.map((line, index) => (
                    <li key={`existing:${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            {reviewSummary.verification.length > 0 && (
              <div className="dream-review-summary-section">
                <div className="dream-review-summary-heading">Verification and risk</div>
                <ul>
                  {reviewSummary.verification.map((line, index) => (
                    <li key={`verification:${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="dream-review-summary-section">
              <div className="dream-review-summary-heading">Recommendation</div>
              <p>{reviewSummary.recommendation}</p>
            </div>
          </div>

          {adoption.issues.length > 0 && (
            <div className="dream-adoption-flag" role="note">
              <div className="dream-adoption-title">
                {plural(issuesByEntry.size, 'row')} flagged for careful review
              </div>
              <div className="dream-adoption-hint">
                Flagged rows start unchecked. Re-check any row you've reviewed and want to adopt, or leave them
                unchecked to keep the rest of the dream while skipping the weaker signal.
              </div>
            </div>
          )}

          {diff.entries.length === 0 && hygiene.length === 0 ? (
            <div className="dream-empty">The dreamer didn't propose any changes. Try a wider scope or a different model.</div>
          ) : (
            <>
              {totalActionable > 0 && diff.awaitingAdopt && (
                <div className="dream-select-bar">
                  <span className="dream-select-bar-label">
                    {totalSelected} of {totalActionable} selected
                  </span>
                  <div className="dream-select-bar-actions">
                    <button
                      type="button"
                      className="dream-select-bar-btn"
                      onClick={() => setAllSelected(true)}
                      disabled={totalSelected === totalActionable}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="dream-select-bar-btn"
                      onClick={() => setAllSelected(false)}
                      disabled={totalSelected === 0}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
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
                          issues={issuesByEntry.get(row.entryId)}
                          selectable={isPromotable(row.action) && diff.awaitingAdopt}
                          checked={selectedEntries.has(row.entryId)}
                          onToggle={() => toggleEntry(row.entryId)}
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
                        <HygieneRow
                          key={`${row.entryId}-${row.action}`}
                          row={row}
                          selectable={diff.awaitingAdopt}
                          checked={selectedHygiene.has(row.entryId)}
                          onToggle={() => toggleHygiene(row.entryId)}
                        />
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
            onClick={handleAdopt}
            disabled={busy !== null || !diff.awaitingAdopt || nothingSelected}
            title={
              nothingSelected
                ? 'Select at least one row to adopt, or click Discard'
                : undefined
            }
          >
            {adoptButtonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function deriveDreamReviewSummary(diff: DreamDiff, hygiene: DreamHygieneEntry[]): DreamReviewSummary {
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
  const commonKind = mostCommonKind([...diff.entries, ...hygiene])
  const partial = diff.verifications.filter((v) => v.verdict === 'partial').length
  const unsupported = diff.verifications.filter((v) => v.verdict === 'unsupported').length

  if (totalChanges === 0) {
    return {
      overview: `The dream sampled ${plural(diff.sampledSessionCount, 'session')} and did not propose any memory changes.`,
      proposals: [],
      existingMemory: ['There is nothing to adopt from this run.'],
      verification: diff.awaitingAdopt
        ? ['No review issues were raised because no candidate changes were proposed.']
        : ['This review is historical only; there is no pending candidate to adopt.'],
      recommendation: 'No action is needed.'
    }
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

  const proposals: string[] = []
  if (proposalParts.length > 0) {
    proposals.push(`It proposes ${joinHuman(proposalParts)} from ${plural(diff.sampledSessionCount, 'sampled session')}.`)
  }
  if (added > 0 && merged + replaced === 0) {
    proposals.push('These proposed additions do not overwrite existing memory text directly.')
  }
  if (hygieneParts.length > 0) {
    proposals.push(`It also curates existing memory with ${joinHuman(hygieneParts)}.`)
  }
  if (commonKind) {
    proposals.push(`Most of the reviewed rows are ${KIND_LABEL[commonKind]} memories.`)
  }

  const existingTouched = merged + replaced + hygieneChanged
  const existingMemory: string[] = []
  if (existingTouched > 0) {
    existingMemory.push(`${plural(existingTouched, 'existing memory')} would be updated, curated, or retired if this dream is adopted.`)
  }
  if (merged > 0 || replaced > 0) {
    existingMemory.push('Pay closest attention to merged and replaced rows because they modify or supersede memory that already exists.')
  }
  if (hygieneChanged > 0) {
    existingMemory.push('The hygiene sections below show lower-risk cleanup such as archiving, confidence changes, reinforcement, or wording updates.')
  }
  if (existingMemory.length === 0) {
    existingMemory.push('This run mostly introduces or rejects candidate memories instead of changing established memory.')
  }

  // Count distinct rows that picked up at least one adoption issue so the
  // copy matches what the user actually sees in the row list. `adoption.issues`
  // can contain multiple issues per row (e.g. low confidence AND thin evidence),
  // so counting rows is more honest than counting raw issue entries.
  const flaggedRows = new Set(adoption.issues.map((i) => i.entryId)).size

  const verification: string[] = []
  if (!diff.awaitingAdopt) {
    verification.push('There is no pending candidate to adopt; this modal is showing a historical review.')
  } else if (flaggedRows > 0) {
    verification.push(
      `${plural(flaggedRows, 'row')} were flagged by the dreamer for careful review and start unchecked. Re-check them only if you've reviewed the row-level details.`
    )
  } else {
    verification.push('Adoption is currently available, but the detailed rows remain the source of truth for final review.')
  }
  if (partial > 0 || unsupported > 0) {
    const warningParts = [
      unsupported > 0 ? plural(unsupported, 'unsupported verification') : null,
      partial > 0 ? plural(partial, 'partial verification') : null
    ].filter(Boolean) as string[]
    verification.push(`Verification surfaced ${joinHuman(warningParts)}.`)
  } else if (diff.verifications.length > 0) {
    verification.push('No partial or unsupported verification verdicts were found in this review.')
  }

  let recommendation = 'Review the detailed rows below before deciding whether to promote these changes.'
  if (!diff.awaitingAdopt) {
    recommendation = 'Use this summary for understanding only; there is nothing pending to adopt.'
  } else if (flaggedRows > 0) {
    recommendation = 'Start by deciding what to do with the flagged rows — they stay out of the adoption unless you re-check them.'
  } else if (merged + replaced > 0 || unsupported > 0) {
    recommendation = 'Review merges, replacements, and any weak verification carefully before adopting.'
  } else if (promotable > 0) {
    recommendation = 'This looks relatively straightforward, but you should still confirm the row-level evidence before adopting.'
  }

  return {
    overview: `This dream produced ${plural(totalChanges, 'proposed memory change')} across ${plural(diff.sampledSessionCount, 'sampled session')}.`,
    proposals,
    existingMemory,
    verification,
    recommendation
  }
}

const ISSUE_BADGE_LABEL: Record<DreamAdoptionIssue['code'], string> = {
  'low-confidence': 'low confidence',
  'thin-evidence': 'thin evidence',
  'unsupported-verification': 'unsupported',
  'partial-verification': 'partial verification'
}

function DreamRow({
  row,
  verification,
  issues,
  selectable,
  checked,
  onToggle
}: {
  row: DreamDiffEntry
  verification?: { verdict: DreamVerificationVerdict; reason?: string }
  issues?: DreamAdoptionIssue[]
  selectable: boolean
  checked: boolean
  onToggle: () => void
}) {
  const hasIssues = !!issues && issues.length > 0
  return (
    <label
      className={`dream-row ${ACTION_CLASS[row.action]}${selectable ? ' is-selectable' : ''}${
        selectable && !checked ? ' is-deselected' : ''
      }${hasIssues ? ' is-flagged' : ''}`}
    >
      {selectable && (
        <input
          type="checkbox"
          className="dream-row-check"
          checked={checked}
          onChange={onToggle}
          aria-label={`Adopt this ${ACTION_LABEL[row.action]} row`}
        />
      )}
      <div className="dream-row-body">
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
          {hasIssues &&
            issues!.map((issue, idx) => (
              <span
                key={`${issue.code}:${idx}`}
                className={`dream-row-issue dream-row-issue-${issue.code}`}
                title={issue.message}
              >
                {ISSUE_BADGE_LABEL[issue.code]}
              </span>
            ))}
        </div>
        <div className="dream-text">{row.text}</div>
        {row.previousText && (
          <div className="dream-prev">was: <span>{row.previousText}</span></div>
        )}
        {row.reason && <div className="dream-reason">{row.reason}</div>}
      </div>
    </label>
  )
}

function HygieneRow({
  row,
  selectable,
  checked,
  onToggle
}: {
  row: DreamHygieneEntry
  selectable: boolean
  checked: boolean
  onToggle: () => void
}) {
  const confidenceMoved =
    row.previousConfidence !== undefined &&
    Math.abs(row.previousConfidence - row.confidence) >= 0.005
  return (
    <label
      className={`dream-row ${HYGIENE_CLASS[row.action]}${selectable ? ' is-selectable' : ''}${
        selectable && !checked ? ' is-deselected' : ''
      }`}
    >
      {selectable && (
        <input
          type="checkbox"
          className="dream-row-check"
          checked={checked}
          onChange={onToggle}
          aria-label={`Apply this ${HYGIENE_LABEL[row.action]} hygiene action`}
        />
      )}
      <div className="dream-row-body">
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
    </label>
  )
}

function isPromotable(action: DreamDiffAction): boolean {
  return action === 'add' || action === 'merge' || action === 'replace'
}

function toggleInSet(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
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
