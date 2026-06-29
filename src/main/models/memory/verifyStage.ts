/**
 * Stage 4 — Verify. Picks up to N random entries from the post-reconciliation
 * result (preferring `add` / `replace` rows — those have no history yet) and
 * asks the dream model to fact-check each claim against its cited evidence.
 *
 * Returns one verdict per sample, plus the raw response for audit. The
 * Dreamer attaches verdicts to the DreamDiff so the user can see which
 * entries the dreamer self-checked. Verdicts never auto-demote — they're
 * only surfaced; the user decides.
 */

import type { MemoryEntry } from './types'
import type { ReconcileDecision } from './reconcileStage'
import type { DreamVerificationVerdict } from '../../../../shared/dream'
import { extractJsonObject } from './jsonExtract'

export interface VerifyStageDeps {
  complete: (modelId: string, system: string, user: string) => Promise<string>
}

export interface VerifyStageInput {
  modelId: string
  decisions: ReconcileDecision[]
  /** Entries to draw the sample from (after reconciliation). */
  resultEntries: MemoryEntry[]
  /** Defaults to 5; smaller scopes can pass less. */
  sampleSize?: number
  /** Inject a stable random source for tests. */
  random?: () => number
}

export interface VerifyStageOutput {
  verifications: Array<{
    entryId: string
    verdict: DreamVerificationVerdict
    reason?: string
  }>
  rawResponse?: string
  skipped: boolean
}

const VERIFY_SYSTEM = [
  'You are a fact-checker for a memory curator. For each claim below, decide',
  'whether the cited evidence supports it. Be strict: if the evidence is thin,',
  'ambiguous, or unrelated, return "unsupported".',
  '',
  'OUTPUT STRICT JSON ONLY. Shape:',
  '{',
  '  "verifications": [',
  '    { "entryId": "mem_...", "verdict": "supported" | "unsupported" | "partial", "reason": "short" }',
  '  ]',
  '}'
].join('\n')

export async function runVerifyStage(
  deps: VerifyStageDeps,
  input: VerifyStageInput
): Promise<VerifyStageOutput> {
  const sample = sampleForVerification(input.decisions, input.resultEntries, input.sampleSize ?? 5, input.random)
  if (sample.length === 0) {
    return { verifications: [], skipped: true }
  }

  const user = buildVerifyUserPrompt(sample)
  let raw: string
  try {
    raw = await deps.complete(input.modelId, VERIFY_SYSTEM, user)
  } catch (err) {
    console.warn('[dream] verify stage failed:', err)
    return { verifications: [], skipped: true }
  }
  const parsed = extractJsonObject<{ verifications?: unknown }>(raw)
  if (!parsed) return { verifications: [], rawResponse: raw, skipped: false }

  const verifications = sanitizeVerifications(parsed.verifications)
  return { verifications, rawResponse: raw, skipped: false }
}

export function sampleForVerification(
  decisions: ReconcileDecision[],
  entries: MemoryEntry[],
  size: number,
  random: () => number = Math.random
): MemoryEntry[] {
  const idsByDecision = new Map(decisions.map((d) => [d.resultEntryId, d.action]))
  const priority: MemoryEntry[] = []
  const fallback: MemoryEntry[] = []
  for (const entry of entries) {
    const action = idsByDecision.get(entry.id)
    if (action === 'add' || action === 'replace') priority.push(entry)
    else if (action === 'merge') fallback.push(entry)
  }
  const pool = priority.length >= size ? priority : [...priority, ...fallback]
  return pickRandom(pool, Math.min(size, pool.length), random)
}

function pickRandom<T>(items: T[], n: number, random: () => number): T[] {
  if (n >= items.length) return items.slice()
  const indices = new Set<number>()
  while (indices.size < n) {
    indices.add(Math.floor(random() * items.length))
  }
  return [...indices].map((i) => items[i])
}

function buildVerifyUserPrompt(entries: MemoryEntry[]): string {
  const rows = entries.map((e) => {
    const evidence = e.evidence
      .slice(0, 3)
      .map((ev) => `    · conv ${ev.conversationId} #${ev.messageIndex ?? '?'}: ${ev.turnExcerpt ?? '(no excerpt)'}`)
      .join('\n')
    return `entryId: ${e.id}\nclaim: ${e.text}\nkind: ${e.kind}\nconfidence: ${e.confidence.toFixed(2)}\nevidence:\n${evidence || '    (none)'}`
  })
  return `Verify these claims:\n\n${rows.join('\n\n')}\n\nEmit JSON now.`
}

function sanitizeVerifications(raw: unknown): VerifyStageOutput['verifications'] {
  if (!Array.isArray(raw)) return []
  const out: VerifyStageOutput['verifications'] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const entryId = typeof obj.entryId === 'string' ? obj.entryId : ''
    const verdict = obj.verdict
    if (!entryId) continue
    if (verdict !== 'supported' && verdict !== 'unsupported' && verdict !== 'partial') continue
    out.push({
      entryId,
      verdict,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 240) : undefined
    })
  }
  return out
}
