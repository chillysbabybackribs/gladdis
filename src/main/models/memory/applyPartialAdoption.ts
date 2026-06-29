/**
 * Partial-adopt engine.
 *
 * The default adopt path promotes the entire candidate file (memory.next.json)
 * to live memory. Partial adoption lets the user cherry-pick which diff rows
 * to apply — selected rows take the candidate version of the entry, unselected
 * rows fall back to whatever was in live memory before the dream. Keeps the
 * "user is always in control" property of the trust model: a single unchecked
 * checkbox can veto any individual claim without throwing the rest away.
 *
 * Selection semantics:
 *   • Diff entry rows (add / merge / replace / reject) keyed by entryId.
 *       - add unselected      → drop the candidate entry entirely
 *       - merge/replace unselected → fall back to the live entry
 *       - reject               → no-op either way (no live or candidate change)
 *   • Hygiene rows (archive / demote / reinforce / keep) keyed by entryId.
 *       - any hygiene action unselected → fall back to the live entry
 *
 * If `selection` is omitted (or both arrays are undefined), this is a no-op
 * and the candidate is returned as-is, matching the legacy full-adopt path.
 *
 * The function is pure: live + candidate + diff + selection are inputs; the
 * returned MemoryFileV2 is what `memory.json` becomes. Tests live in
 * `applyPartialAdoption.test.ts`.
 */

import type { DreamDiff } from '../../../../shared/dream'
import type { MemoryEntry, MemoryFileV2 } from './types'

export interface AdoptSelection {
  /**
   * Diff entry rows (by entryId) to apply. If omitted, every diff row is
   * treated as accepted — i.e. behavior matches a full adopt. Reject rows
   * are silently no-ops regardless of selection.
   */
  acceptedEntryIds?: readonly string[]
  /**
   * Hygiene rows (by entryId) to apply. Same default-accept-all semantics as
   * `acceptedEntryIds`.
   */
  acceptedHygieneIds?: readonly string[]
}

export function applyPartialAdoption(
  live: MemoryFileV2 | null,
  candidate: MemoryFileV2,
  diff: DreamDiff,
  selection: AdoptSelection | undefined
): MemoryFileV2 {
  // Fast path: no selection ⇒ adopt the entire candidate verbatim.
  if (
    !selection ||
    (selection.acceptedEntryIds === undefined && selection.acceptedHygieneIds === undefined)
  ) {
    return candidate
  }

  const liveEntries = live?.entries ?? []
  const liveById = new Map<string, MemoryEntry>(liveEntries.map((e) => [e.id, e]))

  const acceptedEntryIds = new Set(
    selection.acceptedEntryIds ?? diff.entries.map((r) => r.entryId)
  )
  const acceptedHygieneIds = new Set(
    selection.acceptedHygieneIds ?? (diff.hygiene ?? []).map((r) => r.entryId)
  )

  // Index the diff and hygiene rows by entryId so we can answer "did the
  // user accept what happened to THIS entry?" in O(1) per candidate entry.
  const diffByEntry = new Map<string, { action: string; accepted: boolean }>()
  for (const row of diff.entries) {
    diffByEntry.set(row.entryId, {
      action: row.action,
      accepted: acceptedEntryIds.has(row.entryId)
    })
  }
  const hygieneByEntry = new Map<string, { action: string; accepted: boolean }>()
  for (const row of diff.hygiene ?? []) {
    hygieneByEntry.set(row.entryId, {
      action: row.action,
      accepted: acceptedHygieneIds.has(row.entryId)
    })
  }

  const result: MemoryEntry[] = []
  for (const candEntry of candidate.entries) {
    const diffRow = diffByEntry.get(candEntry.id)
    const hygieneRow = hygieneByEntry.get(candEntry.id)

    // Rejected new entry → drop. A diff "add" only ever exists in candidate,
    // so dropping it returns the world to its pre-dream state for that id.
    if (diffRow?.action === 'add' && !diffRow.accepted) continue

    // Rejected merge/replace → fall back to the pre-dream live entry. The
    // candidate version isn't taken; the user keeps what they had.
    if (
      diffRow &&
      !diffRow.accepted &&
      (diffRow.action === 'merge' || diffRow.action === 'replace')
    ) {
      const liveEntry = liveById.get(candEntry.id)
      if (liveEntry) {
        result.push(liveEntry)
        continue
      }
      // Defensive fallback: a merge/replace ought to imply the live entry
      // existed; if it doesn't (corrupted state) we keep the candidate
      // version rather than silently lose data.
    }

    // Rejected hygiene → fall back to live. Hygiene actions (archive, demote,
    // reinforce, keep-with-reword) all just mutate the existing entry, so
    // "decline" means use the unmutated version we already had on disk.
    if (hygieneRow && !hygieneRow.accepted) {
      const liveEntry = liveById.get(candEntry.id)
      if (liveEntry) {
        result.push(liveEntry)
        continue
      }
    }

    result.push(candEntry)
  }

  // Defensive: include any live entries the candidate dropped without going
  // through the diff (shouldn't happen in normal pipeline flow, but
  // partial-adopt should never silently lose data the user had before).
  const candidateIds = new Set(candidate.entries.map((e) => e.id))
  for (const liveEntry of liveEntries) {
    if (!candidateIds.has(liveEntry.id)) result.push(liveEntry)
  }

  return {
    ...candidate,
    entries: result,
    workspace: { ...candidate.workspace, updatedAt: new Date().toISOString() }
  }
}
