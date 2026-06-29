/**
 * Stage 3 — LLM reconcile review.
 *
 * The deterministic reconciler in `reconcileStage.ts` is fast, free, and
 * predictable, but it has known blind spots:
 *   • It can't catch semantic duplicates that don't share token overlap
 *     ("auth uses JWT" vs "we picked token-based auth over sessions").
 *   • It always trusts the extractor's choice of scope (task vs workspace),
 *     so a workspace-level caveat that the model happened to tag as
 *     task-scoped slips through.
 *   • It can't smell hallucinated evidence — only the model that saw the
 *     candidate text can spot when an evidence snippet doesn't actually
 *     support the claim.
 *
 * This stage runs a SINGLE batched model call over the deterministic
 * decisions. For each candidate, the model either confirms the deterministic
 * verdict or overrides it. We then rebuild `resultEntries` from scratch
 * using the refined decisions, sharing the merge/add/replace machinery that
 * the deterministic pass uses (via the helpers exported from
 * `reconcileStage.ts`).
 *
 * On any failure — model error, unparseable JSON, schema mismatch — we
 * silently fall back to the deterministic result and mark the output as
 * `skipped: true`. The dream never fails because of this stage.
 */

import type { ExtractCandidate } from './extractStage'
import { extractJsonObject } from './jsonExtract'
import {
  candidateToEntry,
  cloneEntry,
  findBestPeer,
  mergeInto,
  textSimilarity,
  type ReconcileAction,
  type ReconcileDecision
} from './reconcileStage'
import type { MemoryEntry, MemoryEntryKind } from './types'

const VALID_ACTIONS = new Set<ReconcileAction>(['add', 'merge', 'replace', 'reject'])

const VALID_KINDS = new Set<MemoryEntryKind>([
  'preference',
  'project-fact',
  'decision',
  'playbook',
  'caveat',
  'pattern',
  'legacy'
])

const REVIEW_SYSTEM = [
  "You are reviewing a deterministic memory reconciler's decisions. The",
  'reconciler decided what to do with each candidate (ADD / MERGE / REPLACE /',
  'REJECT) using token-overlap heuristics. You only see the candidate, the',
  'baseline decision, and the candidate\'s nearest existing memory entries.',
  '',
  'OVERRIDE the baseline decision ONLY when you have a clear reason:',
  '',
  '  • ADD → MERGE       The candidate restates an existing entry in different',
  '                      words. Provide mergeIntoEntryId.',
  '  • ADD → REJECT      The evidence does not actually support the claim, or',
  '                      the claim is ephemeral / noise.',
  '  • MERGE → ADD       The peer entry the heuristic merged into is actually',
  '                      a different claim; they should stay separate.',
  '  • REJECT → ADD      The heuristic was too strict; the candidate is a',
  '                      valid durable claim.',
  '',
  'You may also adjust:',
  '  • newScope          "workspace" if the claim applies project-wide, even',
  '                      when the extractor tagged it "task".',
  '  • newKind           Switch kind if the extractor mislabeled it.',
  '  • newText           Tighter wording (must not change the meaning).',
  '',
  'Confirm decisions you agree with by omitting them from the output.',
  '',
  'OUTPUT STRICT JSON ONLY (no commentary, no markdown fences):',
  '{',
  '  "overrides": [',
  '    {',
  '      "candidateIndex": 0,',
  '      "action": "add" | "merge" | "replace" | "reject",',
  '      "mergeIntoEntryId": "mem_...",      // required when action is merge/replace',
  '      "newScope": "workspace" | "task",   // optional',
  '      "newKind": "preference" | ...,      // optional',
  '      "newText": "...",                   // optional, tighter wording',
  '      "reason": "short"',
  '    }',
  '  ]',
  '}',
  '',
  'If every decision is correct, return {"overrides": []}.'
].join('\n')

const PEER_LIMIT = 3

export interface LlmReconcileDeps {
  complete: (modelId: string, system: string, user: string) => Promise<string>
}

export interface LlmReconcileStageInput {
  modelId: string
  workspaceRoot: string
  existingEntries: MemoryEntry[]
  candidates: ExtractCandidate[]
  /** Decisions produced by the deterministic reconciler, in candidate order. */
  baselineDecisions: ReconcileDecision[]
  /** Inject for deterministic tests. */
  now?: string
}

export interface LlmReconcileOverride {
  candidateIndex: number
  action: ReconcileAction
  mergeIntoEntryId?: string
  newScope?: 'workspace' | 'task'
  newKind?: MemoryEntryKind
  newText?: string
  reason?: string
}

export interface LlmReconcileStageOutput {
  decisions: ReconcileDecision[]
  resultEntries: MemoryEntry[]
  overrideCount: number
  rawResponse?: string
  skipped: boolean
}

export async function runLlmReconcileReview(
  deps: LlmReconcileDeps,
  input: LlmReconcileStageInput
): Promise<LlmReconcileStageOutput> {
  if (input.candidates.length === 0) {
    return {
      decisions: input.baselineDecisions,
      resultEntries: rebuildFromBaseline(input),
      overrideCount: 0,
      skipped: true
    }
  }

  let raw: string
  try {
    raw = await deps.complete(input.modelId, REVIEW_SYSTEM, buildReviewUserPrompt(input))
  } catch (err) {
    console.warn('[dream] llm reconcile failed, keeping deterministic result:', err)
    return {
      decisions: input.baselineDecisions,
      resultEntries: rebuildFromBaseline(input),
      overrideCount: 0,
      skipped: true
    }
  }

  const parsed = extractJsonObject<{ overrides?: unknown }>(raw)
  if (!parsed) {
    return {
      decisions: input.baselineDecisions,
      resultEntries: rebuildFromBaseline(input),
      overrideCount: 0,
      rawResponse: raw,
      skipped: true
    }
  }

  const overrides = sanitizeOverrides(parsed.overrides, input.candidates.length)
  if (overrides.length === 0) {
    return {
      decisions: input.baselineDecisions,
      resultEntries: rebuildFromBaseline(input),
      overrideCount: 0,
      rawResponse: raw,
      skipped: false
    }
  }

  const refined = applyDecisionsToWorking(input, overrides)
  return {
    decisions: refined.decisions,
    resultEntries: refined.resultEntries,
    overrideCount: overrides.length,
    rawResponse: raw,
    skipped: false
  }
}

// ── prompt building ───────────────────────────────────────────────────────

function buildReviewUserPrompt(input: LlmReconcileStageInput): string {
  const blocks = input.candidates.map((candidate, i) => {
    const baseline = input.baselineDecisions[i]
    const peers = topPeers(input.existingEntries, candidate, PEER_LIMIT)
    const peerBlock =
      peers.length === 0
        ? '    (none)'
        : peers
            .map(
              ({ entry, similarity }) =>
                `    · ${entry.id} [${entry.kind}, ${entry.scope}${entry.taskId ? `:${entry.taskId}` : ''}] sim=${similarity.toFixed(2)}\n      "${clip(entry.text, 200)}"`
            )
            .join('\n')

    const evidenceBlock = candidate.evidence
      .slice(0, 3)
      .map(
        (ev) =>
          `    · ${ev.conversationId}${ev.messageIndex !== undefined ? `#${ev.messageIndex}` : ''}${ev.turnExcerpt ? `: "${clip(ev.turnExcerpt, 160)}"` : ''}`
      )
      .join('\n')

    return [
      `[${i}] baseline=${baseline?.action ?? 'none'}${baseline?.affectedEntryId ? ` (peer=${baseline.affectedEntryId})` : ''}`,
      `    kind=${candidate.kind}  scope=${candidate.scope}${candidate.taskId ? `:${candidate.taskId}` : ''}  confidence=${candidate.confidence.toFixed(2)}`,
      `    claim: "${clip(candidate.text, 240)}"`,
      `    evidence:`,
      evidenceBlock || '    (none)',
      `    nearest existing entries:`,
      peerBlock
    ].join('\n')
  })

  return [
    `Workspace root: ${input.workspaceRoot}`,
    `Existing memory size: ${input.existingEntries.length} entries`,
    '',
    'Decisions to review:',
    '',
    blocks.join('\n\n'),
    '',
    'Emit the overrides JSON now (or {"overrides": []} if you agree with everything).'
  ].join('\n')
}

interface PeerMatch {
  entry: MemoryEntry
  similarity: number
}

function topPeers(entries: MemoryEntry[], candidate: ExtractCandidate, limit: number): PeerMatch[] {
  // Unlike findBestPeer (same scope+kind only), we surface ALL peers — the LLM
  // is the right place to make cross-kind / cross-scope merge decisions.
  const scored: PeerMatch[] = entries
    .map((entry) => ({ entry, similarity: textSimilarity(entry.text, candidate.text) }))
    .sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, limit).filter((p) => p.similarity > 0.05)
}

function clip(text: string, max: number): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

// ── parse / sanitize ──────────────────────────────────────────────────────

export function sanitizeOverrides(
  raw: unknown,
  candidateCount: number
): LlmReconcileOverride[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const out: LlmReconcileOverride[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>

    const idx = typeof obj.candidateIndex === 'number' ? obj.candidateIndex : -1
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidateCount) continue
    if (seen.has(idx)) continue
    seen.add(idx)

    const action = obj.action
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action as ReconcileAction)) continue

    const newScope =
      obj.newScope === 'workspace' || obj.newScope === 'task' ? obj.newScope : undefined
    const newKind =
      typeof obj.newKind === 'string' && VALID_KINDS.has(obj.newKind as MemoryEntryKind)
        ? (obj.newKind as MemoryEntryKind)
        : undefined
    const newText =
      typeof obj.newText === 'string' && obj.newText.trim().length > 0
        ? obj.newText.trim()
        : undefined
    const mergeIntoEntryId =
      typeof obj.mergeIntoEntryId === 'string' && obj.mergeIntoEntryId.length > 0
        ? obj.mergeIntoEntryId
        : undefined
    const reason =
      typeof obj.reason === 'string' && obj.reason.trim().length > 0
        ? obj.reason.trim().slice(0, 200)
        : undefined

    // merge/replace require a target id from the existing memory.
    if ((action === 'merge' || action === 'replace') && !mergeIntoEntryId) continue

    out.push({
      candidateIndex: idx,
      action: action as ReconcileAction,
      mergeIntoEntryId,
      newScope,
      newKind,
      newText,
      reason
    })
  }
  return out
}

// ── decision application ─────────────────────────────────────────────────

interface ApplyResult {
  decisions: ReconcileDecision[]
  resultEntries: MemoryEntry[]
}

function rebuildFromBaseline(input: LlmReconcileStageInput): MemoryEntry[] {
  // Re-applies the baseline decisions over a fresh clone of existingEntries,
  // so the caller always gets a self-consistent (decisions, resultEntries)
  // pair regardless of where it came from.
  return applyDecisionsToWorking(input, []).resultEntries
}

function applyDecisionsToWorking(
  input: LlmReconcileStageInput,
  overrides: LlmReconcileOverride[]
): ApplyResult {
  const now = input.now ?? new Date().toISOString()
  const working: MemoryEntry[] = input.existingEntries.map(cloneEntry)
  const overrideMap = new Map(overrides.map((o) => [o.candidateIndex, o]))
  const outDecisions: ReconcileDecision[] = []

  // Any existing entry surfaced as a top peer to the reviewer was observed
  // by the dream — bump lastReferencedAt so the hygiene stage downstream
  // sees honest recency. Done before any merges/replaces so we don't bump
  // entries that get removed by a replace decision anyway.
  const surfacedPeerIds = new Set<string>()
  for (const candidate of input.candidates) {
    for (const peer of topPeers(input.existingEntries, candidate, PEER_LIMIT)) {
      surfacedPeerIds.add(peer.entry.id)
    }
  }
  for (const entry of working) {
    if (surfacedPeerIds.has(entry.id)) {
      entry.freshness.lastReferencedAt = now
    }
  }

  input.candidates.forEach((rawCandidate, i) => {
    const override = overrideMap.get(i)
    const candidate = override
      ? applyOverrideToCandidate(rawCandidate, override)
      : rawCandidate
    const baseline = input.baselineDecisions[i]
    const finalAction: ReconcileAction = override?.action ?? baseline?.action ?? 'reject'

    if (finalAction === 'reject') {
      outDecisions.push({
        action: 'reject',
        candidate,
        reason: override?.reason ?? baseline?.reason ?? 'rejected'
      })
      return
    }

    if (finalAction === 'merge') {
      const targetId = override?.mergeIntoEntryId ?? baseline?.affectedEntryId
      const target = targetId ? working.find((e) => e.id === targetId) : null
      if (!target) {
        // Fall back to add — we can't merge into a missing entry.
        const entry = candidateToEntry(candidate, input.workspaceRoot, now)
        working.push(entry)
        outDecisions.push({
          action: 'add',
          candidate,
          resultEntryId: entry.id,
          reason: override?.reason ?? 'fallback (merge target missing)'
        })
        return
      }
      const before = target.text
      mergeInto(target, candidate, now)
      outDecisions.push({
        action: 'merge',
        candidate,
        affectedEntryId: target.id,
        resultEntryId: target.id,
        previousText: before === target.text ? undefined : before,
        reason: override?.reason ?? baseline?.reason ?? 'same claim as existing entry'
      })
      return
    }

    if (finalAction === 'replace') {
      const targetId = override?.mergeIntoEntryId ?? baseline?.affectedEntryId
      const targetIdx = targetId ? working.findIndex((e) => e.id === targetId) : -1
      if (targetIdx === -1) {
        const entry = candidateToEntry(candidate, input.workspaceRoot, now)
        working.push(entry)
        outDecisions.push({
          action: 'add',
          candidate,
          resultEntryId: entry.id,
          reason: override?.reason ?? 'fallback (replace target missing)'
        })
        return
      }
      const target = working[targetIdx]
      const previousText = target.text
      working.splice(targetIdx, 1)
      const next = candidateToEntry(candidate, input.workspaceRoot, now)
      next.freshness.contradictsId = target.id
      working.push(next)
      outDecisions.push({
        action: 'replace',
        candidate,
        affectedEntryId: target.id,
        resultEntryId: next.id,
        previousText,
        reason: override?.reason ?? baseline?.reason ?? 'replaces lower-confidence entry'
      })
      return
    }

    // add (default)
    const peer = findBestPeer(working, candidate)
    const entry = candidateToEntry(candidate, input.workspaceRoot, now)
    working.push(entry)
    outDecisions.push({
      action: 'add',
      candidate,
      resultEntryId: entry.id,
      reason: override?.reason ?? baseline?.reason ?? 'novel claim',
      // Keep a soft pointer to the nearest peer for downstream observability.
      ...(peer && peer.similarity >= 0.2 ? { affectedEntryId: peer.entry.id } : {})
    })
  })

  return { decisions: outDecisions, resultEntries: working }
}

function applyOverrideToCandidate(
  candidate: ExtractCandidate,
  override: LlmReconcileOverride
): ExtractCandidate {
  return {
    ...candidate,
    kind: override.newKind ?? candidate.kind,
    scope: override.newScope ?? candidate.scope,
    text: override.newText ?? candidate.text,
    taskId: (override.newScope ?? candidate.scope) === 'task' ? candidate.taskId : undefined,
    tags: candidate.tags,
    evidence: candidate.evidence
  }
}
