/**
 * Compose the user-visible DreamDiff from the post-reconciliation state. The
 * renderer treats this as a black box and just renders rows + summary; the
 * adopt path uses `resultEntries` (which the Dreamer persists separately to
 * memory.next.json) to atomically promote on adopt.
 */

import type {
  DreamDiff,
  DreamDiffAction,
  DreamDiffEntry,
  DreamDiffSummary,
  DreamScope,
  DreamVerification,
  MemoryEntryKindLite
} from '../../../../shared/dream'
import type { Provider } from '../../../../shared/models'
import type { MemoryEntry, MemoryEntryKind } from './types'
import type { ReconcileDecision } from './reconcileStage'

export interface ComposeDiffInput {
  id: string
  createdAt: number
  modelId: string
  modelProvider: Provider
  scope: DreamScope
  workspaceRoot: string
  existingEntries: MemoryEntry[]
  resultEntries: MemoryEntry[]
  decisions: ReconcileDecision[]
  verifications: DreamVerification[]
  candidateFilePath?: string
  sampledSessionCount: number
}

export function composeDreamDiff(input: ComposeDiffInput): DreamDiff {
  const resultById = new Map(input.resultEntries.map((e) => [e.id, e] as const))
  const affectedExistingIds = new Set<string>()
  const summary: DreamDiffSummary = { added: 0, merged: 0, replaced: 0, rejected: 0, unchanged: 0 }
  const entries: DreamDiffEntry[] = []

  for (const decision of input.decisions) {
    const candidate = decision.candidate
    const action: DreamDiffAction = decision.action
    if (decision.affectedEntryId) affectedExistingIds.add(decision.affectedEntryId)

    if (action === 'reject') {
      entries.push({
        action,
        entryId: 'rejected:' + (decision.affectedEntryId ?? '') + ':' + entries.length,
        kind: liftKind(candidate.kind),
        scope: candidate.scope,
        taskId: candidate.taskId,
        text: candidate.text,
        previousText: undefined,
        confidence: candidate.confidence,
        evidenceCount: candidate.evidence.length,
        reason: decision.reason
      })
      summary.rejected += 1
      continue
    }

    const resultId = decision.resultEntryId ?? decision.affectedEntryId
    if (!resultId) continue
    const resultEntry = resultById.get(resultId)
    if (!resultEntry) continue

    entries.push({
      action,
      entryId: resultEntry.id,
      kind: liftKind(resultEntry.kind),
      scope: resultEntry.scope,
      taskId: resultEntry.taskId,
      text: resultEntry.text,
      previousText: decision.previousText,
      confidence: resultEntry.confidence,
      evidenceCount: resultEntry.evidence.length,
      reason: decision.reason
    })

    if (action === 'add') summary.added += 1
    else if (action === 'merge') summary.merged += 1
    else if (action === 'replace') summary.replaced += 1
  }

  summary.unchanged = input.existingEntries.filter((e) => !affectedExistingIds.has(e.id)).length

  return {
    id: input.id,
    createdAt: input.createdAt,
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    scope: input.scope,
    workspaceRoot: input.workspaceRoot,
    summary,
    verifications: input.verifications,
    entries,
    awaitingAdopt: true,
    candidateFilePath: input.candidateFilePath,
    sampledSessionCount: input.sampledSessionCount
  }
}

function liftKind(kind: MemoryEntryKind): MemoryEntryKindLite {
  // Both schemas use the same string literals; a function instead of a cast
  // makes future divergence safe and explicit.
  return kind
}
