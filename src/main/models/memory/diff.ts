/**
 * Compose the user-visible DreamDiff from the post-reconciliation state. The
 * renderer treats this as a black box and just renders rows + summary; the
 * adopt path uses `resultEntries` (which the Dreamer persists separately to
 * memory.next.json) to atomically promote on adopt.
 */

import type {
  DreamAdoptionIssue,
  DreamAdoptionPolicy,
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

const PROMOTING_ACTIONS = new Set<DreamDiffAction>(['add', 'merge', 'replace'])
const MIN_ADOPT_CONFIDENCE = 0.7
const MIN_ADOPT_EVIDENCE = 1

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
  const adoption = evaluateDreamAdoption(entries, input.verifications)

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
    adoption,
    awaitingAdopt: true,
    candidateFilePath: input.candidateFilePath,
    sampledSessionCount: input.sampledSessionCount
  }
}

export function evaluateDreamAdoption(
  entries: ReadonlyArray<DreamDiffEntry>,
  verifications: ReadonlyArray<DreamVerification>
): DreamAdoptionPolicy {
  const verificationById = new Map(verifications.map((v) => [v.entryId, v] as const))
  const issues: DreamAdoptionIssue[] = []

  for (const entry of entries) {
    if (!PROMOTING_ACTIONS.has(entry.action)) continue

    if (entry.confidence < MIN_ADOPT_CONFIDENCE) {
      issues.push({
        code: 'low-confidence',
        entryId: entry.entryId,
        message: `Confidence ${entry.confidence.toFixed(2)} is below the ${MIN_ADOPT_CONFIDENCE.toFixed(2)} adoption floor.`
      })
    }

    if (entry.evidenceCount < MIN_ADOPT_EVIDENCE) {
      issues.push({
        code: 'thin-evidence',
        entryId: entry.entryId,
        message: 'Promoted memory entries need at least one evidence source.'
      })
    }

    const verification = verificationById.get(entry.entryId)
    if (verification?.verdict === 'unsupported') {
      issues.push({
        code: 'unsupported-verification',
        entryId: entry.entryId,
        message: verification.reason
          ? `Verifier marked this unsupported: ${verification.reason}`
          : 'Verifier marked this entry unsupported.'
      })
    } else if (verification?.verdict === 'partial') {
      issues.push({
        code: 'partial-verification',
        entryId: entry.entryId,
        message: verification.reason
          ? `Verifier only partially supported this entry: ${verification.reason}`
          : 'Verifier only partially supported this entry.'
      })
    }
  }

  return { blocked: issues.length > 0, issues }
}

function liftKind(kind: MemoryEntryKind): MemoryEntryKindLite {
  // Both schemas use the same string literals; a function instead of a cast
  // makes future divergence safe and explicit.
  return kind
}
