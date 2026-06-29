/**
 * Stage 2 — Reconcile. Deterministic for Phase 1: for each extracted
 * candidate, decide merge / replace / add / reject against the current
 * memory entries. No model call here — it's a small rules engine over the
 * candidate + the nearest existing peers by scope, kind, and text similarity.
 *
 * Rules:
 *   • reject  — confidence < 0.5 AND evidence count < 2
 *               OR text < 8 chars (probably noise)
 *   • merge   — best peer of same scope+kind has similarity ≥ 0.65
 *               Combine evidence, bump freshness, gently raise confidence,
 *               canonicalize text to the shorter wording.
 *   • replace — best peer of same scope+kind has similarity ≥ 0.35
 *               AND candidate confidence > peer confidence + 0.10
 *               Demote the peer; the new entry records the peer's id in
 *               freshness.contradictsId for audit.
 *   • add     — fall-through: novel claim, append as a new entry.
 *
 * The thresholds are intentionally conservative so the first user-visible
 * diffs over-favor add/merge and avoid silent replaces.
 */

import type { ExtractCandidate } from './extractStage'
import type { MemoryEntry, MemoryEntryKind } from './types'

export type ReconcileAction = 'add' | 'merge' | 'replace' | 'reject'

export interface ReconcileDecision {
  action: ReconcileAction
  candidate: ExtractCandidate
  /** Entry the candidate was merged/replaced into; absent for add/reject. */
  affectedEntryId?: string
  /** Resulting entry id for add/merge/replace; absent for reject. */
  resultEntryId?: string
  /** When 'replace' or 'merge', the prior text being supplanted (for the diff). */
  previousText?: string
  reason: string
}

export interface ReconcileStageInput {
  existingEntries: MemoryEntry[]
  candidates: ExtractCandidate[]
  workspaceRoot: string
  /** ISO string injected for determinism in tests; defaults to now. */
  now?: string
}

export interface ReconcileStageOutput {
  decisions: ReconcileDecision[]
  /** The post-reconciliation entry list to write into memory.next.json. */
  resultEntries: MemoryEntry[]
}

const MERGE_THRESHOLD = 0.65
const REPLACE_THRESHOLD = 0.35
const REPLACE_CONFIDENCE_MARGIN = 0.1
const MIN_TEXT_LEN = 8
const MIN_REJECT_CONFIDENCE = 0.5
const MIN_REJECT_EVIDENCE = 2

export function runReconcileStage(input: ReconcileStageInput): ReconcileStageOutput {
  const now = input.now ?? new Date().toISOString()
  const working: MemoryEntry[] = input.existingEntries.map(cloneEntry)
  const decisions: ReconcileDecision[] = []

  for (const candidate of input.candidates) {
    if (candidate.text.length < MIN_TEXT_LEN) {
      decisions.push({ action: 'reject', candidate, reason: 'text too short' })
      continue
    }
    if (candidate.confidence < MIN_REJECT_CONFIDENCE && candidate.evidence.length < MIN_REJECT_EVIDENCE) {
      decisions.push({ action: 'reject', candidate, reason: 'low confidence and thin evidence' })
      continue
    }

    const peer = findBestPeer(working, candidate)
    // Any peer that came back from findBestPeer was "looked at" by the
    // dreamer this run — even when the candidate ends up being added as
    // novel. Bumping lastReferencedAt here is what gives the hygiene stage
    // (which runs later in the same pipeline) honest recency data: an
    // entry the dream just considered should NEVER count as "never
    // referenced" when curation triages staleness.
    if (peer && peer.similarity >= 0.1) {
      peer.entry.freshness.lastReferencedAt = now
    }
    if (peer && peer.similarity >= MERGE_THRESHOLD) {
      const before = peer.entry.text
      mergeInto(peer.entry, candidate, now)
      decisions.push({
        action: 'merge',
        candidate,
        affectedEntryId: peer.entry.id,
        resultEntryId: peer.entry.id,
        previousText: before === peer.entry.text ? undefined : before,
        reason: `same claim as existing entry (similarity ${peer.similarity.toFixed(2)})`
      })
      continue
    }

    if (
      peer &&
      peer.similarity >= REPLACE_THRESHOLD &&
      candidate.confidence > peer.entry.confidence + REPLACE_CONFIDENCE_MARGIN
    ) {
      const idx = working.indexOf(peer.entry)
      const previousText = peer.entry.text
      working.splice(idx, 1)
      const next = candidateToEntry(candidate, input.workspaceRoot, now)
      next.freshness.contradictsId = peer.entry.id
      working.push(next)
      decisions.push({
        action: 'replace',
        candidate,
        affectedEntryId: peer.entry.id,
        resultEntryId: next.id,
        previousText,
        reason: `contradicts lower-confidence existing entry (sim ${peer.similarity.toFixed(2)})`
      })
      continue
    }

    const added = candidateToEntry(candidate, input.workspaceRoot, now)
    working.push(added)
    decisions.push({
      action: 'add',
      candidate,
      resultEntryId: added.id,
      reason: 'novel claim'
    })
  }

  return { decisions, resultEntries: working }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface PeerMatch {
  entry: MemoryEntry
  similarity: number
}

export function findBestPeer(entries: MemoryEntry[], candidate: ExtractCandidate): PeerMatch | null {
  let best: PeerMatch | null = null
  for (const entry of entries) {
    if (entry.scope !== candidate.scope) continue
    if (entry.kind !== candidate.kind && !isLegacyMatch(entry.kind, candidate.kind)) continue
    if (candidate.scope === 'task' && entry.taskId !== candidate.taskId) continue
    if (candidate.scope === 'workspace' && entry.taskId) continue
    const similarity = textSimilarity(entry.text, candidate.text)
    if (!best || similarity > best.similarity) best = { entry, similarity }
  }
  return best
}

/** Treat 'legacy' entries as matchable against any kind so the dreamer can
 *  upgrade migrated entries to proper kinds without first having to delete. */
function isLegacyMatch(entryKind: MemoryEntryKind, candidateKind: MemoryEntryKind): boolean {
  return entryKind === 'legacy' && candidateKind !== 'legacy'
}

export function mergeInto(entry: MemoryEntry, candidate: ExtractCandidate, now: string): void {
  for (const ev of candidate.evidence) {
    if (!entry.evidence.some((existing) =>
      existing.conversationId === ev.conversationId &&
      existing.messageIndex === ev.messageIndex
    )) {
      entry.evidence.push(ev)
    }
  }
  // Upgrade legacy kind to a real kind whenever the candidate has one.
  if (entry.kind === 'legacy' && candidate.kind !== 'legacy') {
    entry.kind = candidate.kind
  }
  // Canonicalize text — prefer the shorter, cleaner statement.
  if (candidate.text.length > 0 && candidate.text.length < entry.text.length * 0.9) {
    entry.text = candidate.text
  }
  entry.tags = mergeTagsUnique(entry.tags, candidate.tags)
  entry.freshness.lastReinforcedAt = now
  entry.confidence = Math.min(
    0.97,
    Math.max(entry.confidence, candidate.confidence) + 0.05
  )
}

export function candidateToEntry(candidate: ExtractCandidate, workspaceRoot: string, now: string): MemoryEntry {
  return {
    id: generateEntryId(),
    kind: candidate.kind,
    scope: candidate.scope,
    workspaceRoot,
    ...(candidate.scope === 'task' && candidate.taskId ? { taskId: candidate.taskId } : {}),
    text: candidate.text,
    evidence: candidate.evidence.map((ev) => ({ ...ev })),
    confidence: candidate.confidence,
    freshness: { createdAt: now, lastReinforcedAt: now },
    tags: [...candidate.tags, 'dreamed']
  }
}

export function cloneEntry(e: MemoryEntry): MemoryEntry {
  return {
    ...e,
    evidence: e.evidence.map((ev) => ({ ...ev })),
    freshness: { ...e.freshness },
    tags: [...e.tags]
  }
}

function mergeTagsUnique(a: string[], b: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [...a, ...b]) {
    if (!t) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

const TOKEN_RE = /[A-Za-z0-9]+/g

/** Jaccard-like token overlap, length-normalized. Returns 0..1. */
export function textSimilarity(a: string, b: string): number {
  const aw = tokenize(a)
  const bw = tokenize(b)
  if (aw.size === 0 || bw.size === 0) return 0
  let inter = 0
  for (const w of aw) if (bw.has(w)) inter++
  return inter / Math.min(aw.size, bw.size)
}

function tokenize(s: string): Set<string> {
  const lower = s.toLowerCase()
  const out = new Set<string>()
  for (const match of lower.matchAll(TOKEN_RE)) {
    const tok = match[0]
    if (tok.length < 3) continue
    out.add(tok)
  }
  return out
}

function generateEntryId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
