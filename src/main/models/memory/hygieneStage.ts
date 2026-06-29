/**
 * Stage 4 — memory hygiene / curation.
 *
 * The extract → reconcile → review pipeline only grows the memory store.
 * Without a counter-pressure, entries accumulate forever; stale claims,
 * over-confident facts, and abandoned playbooks pile up and pollute every
 * subsequent retrieval. This stage applies that counter-pressure.
 *
 * Each dream picks the N stalest entries (deterministic scoring on freshness
 * + confidence + evidence depth + reference recency), and a single batched
 * model call triages them:
 *
 *   • archive    — entry kept on disk (audit trail) but hidden from
 *                  memory_read by default. A live memory_write to the same
 *                  key resurrects it. This is how the dream forgets.
 *   • demote     — entry is still relevant but confidence was over-stated;
 *                  drop confidence (and optionally tighten text).
 *   • reinforce  — entry is more relevant than its metadata suggests; bump
 *                  confidence and refresh lastReinforcedAt.
 *   • keep       — no change.
 *
 * The stage degrades gracefully on every failure path: model error,
 * unparseable JSON, schema mismatch, or empty decisions all leave the input
 * entries untouched and set `skipped: true`. There is no way for hygiene to
 * delete data; archive is reversible and demote/reinforce only nudge
 * confidence within bounded ranges.
 */

import { extractJsonObject } from './jsonExtract'
import type { MemoryEntry } from './types'

const DAY_MS = 86_400_000

/** Don't propose anything on tiny stores — the cost isn't worth the noise. */
const MIN_ENTRIES_TO_TRIAGE = 3

/** Cap the prompt size; the staleness ranking ensures we pick the right ones. */
const MAX_TRIAGE_BATCH = 12

/**
 * Don't show entries younger than this to the curator. Fresh entries haven't
 * had a chance to be reinforced; archiving them would be premature.
 */
const MIN_AGE_DAYS_TO_TRIAGE = 14

/** Demote can never floor below this; otherwise reinforcing back up is hard. */
const DEMOTE_FLOOR = 0.3

const VALID_ACTIONS = new Set<HygieneAction>(['archive', 'demote', 'reinforce', 'keep'])

export type HygieneAction = 'archive' | 'demote' | 'reinforce' | 'keep'

export interface HygieneDecision {
  entryId: string
  action: HygieneAction
  reason?: string
  /** Captured BEFORE the action is applied so the diff can show "was: X". */
  previousConfidence: number
  /** Set by demote/reinforce; absent on archive/keep. */
  newConfidence?: number
  /** Tighter wording the model proposed; absent if unchanged. */
  newText?: string
  previousText?: string
}

export interface HygieneStageDeps {
  complete: (modelId: string, system: string, user: string) => Promise<string>
}

export interface HygieneStageInput {
  modelId: string
  workspaceRoot: string
  /** Working set produced by the reconcile / review stages. */
  entries: MemoryEntry[]
  /** Inject for deterministic tests. */
  now?: string
}

export interface HygieneStageOutput {
  decisions: HygieneDecision[]
  resultEntries: MemoryEntry[]
  /** True when the stage decided to do nothing (or fell back on a failure). */
  skipped: boolean
  /** How many entries were even considered (after scoring + age filter). */
  triagedCount: number
  rawResponse?: string
}

const HYGIENE_SYSTEM = [
  'You are the curator of a long-lived memory store. Each turn the user has',
  'with the assistant adds new memories; without periodic curation, stale',
  'and over-confident claims accumulate and pollute future retrieval. Your',
  'job is to triage entries the deterministic ranker has flagged as the',
  'STALEST candidates.',
  '',
  'For each entry, decide:',
  '',
  '  • archive    — the claim is no longer relevant, has never been',
  '                 reinforced, is contradicted by newer entries, or is',
  '                 ephemeral noise. Archive is REVERSIBLE: the entry stays',
  '                 in the file for audit, just hidden from default reads.',
  '  • demote     — the claim is still relevant but its confidence is',
  '                 over-stated relative to how often it has been reinforced',
  '                 or how thin the evidence is.',
  '  • reinforce  — the claim is foundational enough that its confidence',
  '                 should rise even though it has not been recently restated.',
  '  • keep       — no change. Use this freely; you do not have to act on',
  '                 every entry.',
  '',
  'Be conservative. Archive only when you have a clear reason. Never demote',
  'a high-confidence project fact just because it is old — facts can be',
  'stable for years. Never reinforce a thin-evidence claim.',
  '',
  'You may include `newText` on demote/keep to tighten wording without',
  'changing meaning. Do NOT change meaning.',
  '',
  'OUTPUT STRICT JSON ONLY (no commentary, no markdown fences):',
  '{',
  '  "decisions": [',
  '    {',
  '      "entryId": "mem_...",',
  '      "action": "archive" | "demote" | "reinforce" | "keep",',
  '      "newConfidence": 0.5,    // optional, used by demote/reinforce',
  '      "newText": "...",        // optional, tighter wording',
  '      "reason": "short"',
  '    }',
  '  ]',
  '}',
  '',
  'If every entry should remain unchanged, return {"decisions": []}.'
].join('\n')

export async function runHygieneStage(
  deps: HygieneStageDeps,
  input: HygieneStageInput
): Promise<HygieneStageOutput> {
  const now = input.now ?? new Date().toISOString()
  const nowMs = Date.parse(now)

  const candidates = pickTriageCandidates(input.entries, nowMs)
  if (candidates.length < MIN_ENTRIES_TO_TRIAGE) {
    return {
      decisions: [],
      resultEntries: input.entries,
      skipped: true,
      triagedCount: candidates.length
    }
  }

  let raw: string
  try {
    raw = await deps.complete(
      input.modelId,
      HYGIENE_SYSTEM,
      buildHygieneUserPrompt(candidates, nowMs, input.workspaceRoot)
    )
  } catch (err) {
    console.warn('[dream] hygiene model call failed:', err)
    return {
      decisions: [],
      resultEntries: input.entries,
      skipped: true,
      triagedCount: candidates.length
    }
  }

  const parsed = extractJsonObject<{ decisions?: unknown }>(raw)
  if (!parsed) {
    return {
      decisions: [],
      resultEntries: input.entries,
      skipped: true,
      triagedCount: candidates.length,
      rawResponse: raw
    }
  }

  const decisions = sanitizeHygieneDecisions(
    parsed.decisions,
    candidates.map((c) => c.entry)
  )
  if (decisions.length === 0) {
    return {
      decisions: [],
      resultEntries: input.entries,
      skipped: false,
      triagedCount: candidates.length,
      rawResponse: raw
    }
  }

  const result = applyHygieneDecisions(input.entries, decisions, now)
  return {
    decisions: result.decisions,
    resultEntries: result.entries,
    skipped: false,
    triagedCount: candidates.length,
    rawResponse: raw
  }
}

// ── candidate selection ──────────────────────────────────────────────────

export interface TriageCandidate {
  entry: MemoryEntry
  staleness: number
  ageDays: number
  daysSinceReinforced: number
  daysSinceReferenced: number
}

/**
 * Returns the top-N stalest, non-archived, non-young entries in descending
 * staleness order. Exported for tests.
 */
export function pickTriageCandidates(
  entries: MemoryEntry[],
  nowMs: number,
  limit: number = MAX_TRIAGE_BATCH
): TriageCandidate[] {
  const scored: TriageCandidate[] = []
  for (const entry of entries) {
    if (entry.freshness.archivedAt) continue
    const created = Date.parse(entry.freshness.createdAt)
    if (!Number.isFinite(created)) continue
    const ageDays = (nowMs - created) / DAY_MS
    if (ageDays < MIN_AGE_DAYS_TO_TRIAGE) continue

    const reinforced = Date.parse(entry.freshness.lastReinforcedAt)
    const daysSinceReinforced = Number.isFinite(reinforced)
      ? (nowMs - reinforced) / DAY_MS
      : ageDays

    const referenced = entry.freshness.lastReferencedAt
      ? Date.parse(entry.freshness.lastReferencedAt)
      : NaN
    const daysSinceReferenced = Number.isFinite(referenced)
      ? (nowMs - referenced) / DAY_MS
      : daysSinceReinforced

    // Composite staleness:
    //   • Longer since reinforced ⇒ staler.
    //   • Lower confidence ⇒ staler (over-confident memories are worse).
    //   • Sparse evidence ⇒ staler.
    //   • Never referenced ⇒ falls back to "since reinforced" but
    //     reference-driven recency softens the score for actively-used entries.
    const evidenceCount = entry.evidence.length
    const confidence = Number.isFinite(entry.confidence) ? entry.confidence : 0.5
    const staleness =
      daysSinceReinforced * 1 +
      (1 - confidence) * 45 +
      Math.max(0, 4 - evidenceCount) * 4 +
      daysSinceReferenced * 0.25

    scored.push({ entry, staleness, ageDays, daysSinceReinforced, daysSinceReferenced })
  }
  scored.sort((a, b) => b.staleness - a.staleness)
  return scored.slice(0, limit)
}

// ── prompt building ──────────────────────────────────────────────────────

function buildHygieneUserPrompt(
  candidates: TriageCandidate[],
  _nowMs: number,
  workspaceRoot: string
): string {
  const lines: string[] = [
    `Workspace root: ${workspaceRoot}`,
    `Stalest entries to triage (${candidates.length}):`,
    ''
  ]
  for (const c of candidates) {
    const { entry } = c
    const evidence =
      entry.evidence.length === 0
        ? '(none)'
        : entry.evidence
            .slice(0, 3)
            .map(
              (ev) =>
                `${ev.conversationId}${ev.messageIndex !== undefined ? `#${ev.messageIndex}` : ''}${ev.turnExcerpt ? ` "${clip(ev.turnExcerpt, 120)}"` : ''}`
            )
            .join('; ')

    lines.push(
      `[${entry.id}] kind=${entry.kind} scope=${entry.scope}${entry.taskId ? `:${entry.taskId}` : ''}`,
      `   text: "${clip(entry.text, 240)}"`,
      `   confidence=${entry.confidence.toFixed(2)}  evidence=${entry.evidence.length}  ageDays=${c.ageDays.toFixed(0)}  daysSinceReinforced=${c.daysSinceReinforced.toFixed(0)}  daysSinceReferenced=${Number.isFinite(c.daysSinceReferenced) ? c.daysSinceReferenced.toFixed(0) : 'never'}`,
      `   evidence: ${evidence}`,
      ''
    )
  }
  lines.push(
    'Emit the decisions JSON now (or {"decisions": []} if every entry should stay as-is).'
  )
  return lines.join('\n')
}

function clip(text: string, max: number): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

// ── parse / sanitize ─────────────────────────────────────────────────────

export function sanitizeHygieneDecisions(
  raw: unknown,
  validEntries: MemoryEntry[]
): Array<{
  entryId: string
  action: HygieneAction
  newConfidence?: number
  newText?: string
  reason?: string
}> {
  if (!Array.isArray(raw)) return []
  const allowed = new Set(validEntries.map((e) => e.id))
  const seen = new Set<string>()
  const out: ReturnType<typeof sanitizeHygieneDecisions> = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>

    const entryId = typeof obj.entryId === 'string' ? obj.entryId.trim() : ''
    if (!entryId || !allowed.has(entryId) || seen.has(entryId)) continue

    const action = obj.action
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action as HygieneAction)) continue

    let newConfidence: number | undefined
    if (typeof obj.newConfidence === 'number' && Number.isFinite(obj.newConfidence)) {
      newConfidence = Math.max(0, Math.min(1, obj.newConfidence))
    }
    const newText =
      typeof obj.newText === 'string' && obj.newText.trim().length > 0
        ? obj.newText.trim()
        : undefined
    const reason =
      typeof obj.reason === 'string' && obj.reason.trim().length > 0
        ? obj.reason.trim().slice(0, 200)
        : undefined

    // `keep` decisions with no text adjustment are no-ops — skip them entirely
    // so they don't bloat the diff.
    if (action === 'keep' && !newText) continue

    seen.add(entryId)
    out.push({
      entryId,
      action: action as HygieneAction,
      newConfidence,
      newText,
      reason
    })
  }
  return out
}

// ── decision application ─────────────────────────────────────────────────

interface ApplyResult {
  decisions: HygieneDecision[]
  entries: MemoryEntry[]
}

function applyHygieneDecisions(
  entries: MemoryEntry[],
  rawDecisions: ReturnType<typeof sanitizeHygieneDecisions>,
  now: string
): ApplyResult {
  const byId = new Map<string, MemoryEntry>()
  for (const e of entries) byId.set(e.id, e)

  // Deep clone so we never mutate the caller's working set in place.
  const working: MemoryEntry[] = entries.map(cloneEntry)
  const workingById = new Map<string, MemoryEntry>()
  for (const e of working) workingById.set(e.id, e)

  const decisions: HygieneDecision[] = []
  for (const dec of rawDecisions) {
    const target = workingById.get(dec.entryId)
    if (!target) continue
    const previousConfidence = target.confidence
    const previousText = target.text

    if (dec.action === 'archive') {
      target.freshness.archivedAt = now
      if (dec.reason) target.freshness.archivedReason = dec.reason
      decisions.push({
        entryId: target.id,
        action: 'archive',
        previousConfidence,
        reason: dec.reason
      })
      continue
    }

    if (dec.action === 'demote') {
      const proposed = dec.newConfidence ?? Math.max(DEMOTE_FLOOR, previousConfidence - 0.15)
      const bounded = Math.max(DEMOTE_FLOOR, Math.min(previousConfidence, proposed))
      if (bounded < previousConfidence - 0.0001 || (dec.newText && dec.newText !== previousText)) {
        target.confidence = bounded
        if (dec.newText && dec.newText !== previousText) target.text = dec.newText
        decisions.push({
          entryId: target.id,
          action: 'demote',
          previousConfidence,
          newConfidence: target.confidence,
          ...(dec.newText && dec.newText !== previousText
            ? { newText: dec.newText, previousText }
            : {}),
          reason: dec.reason
        })
      }
      continue
    }

    if (dec.action === 'reinforce') {
      const proposed = dec.newConfidence ?? Math.min(0.95, previousConfidence + 0.05)
      const bounded = Math.min(0.95, Math.max(previousConfidence, proposed))
      if (bounded > previousConfidence + 0.0001) {
        target.confidence = bounded
        target.freshness.lastReinforcedAt = now
        decisions.push({
          entryId: target.id,
          action: 'reinforce',
          previousConfidence,
          newConfidence: target.confidence,
          reason: dec.reason
        })
      }
      continue
    }

    // keep with newText only (already filtered to require text in sanitizer)
    if (dec.action === 'keep' && dec.newText && dec.newText !== previousText) {
      target.text = dec.newText
      decisions.push({
        entryId: target.id,
        action: 'keep',
        previousConfidence,
        newText: dec.newText,
        previousText,
        reason: dec.reason
      })
    }
  }

  return { decisions, entries: working }
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    evidence: entry.evidence.map((e) => ({ ...e })),
    freshness: { ...entry.freshness },
    tags: [...entry.tags]
  }
}
