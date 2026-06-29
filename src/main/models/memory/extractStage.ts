/**
 * Stage 1 — Extract. Reads sampled transcripts (and a brief snapshot of the
 * existing memory entries so the model doesn't propose obvious duplicates) and
 * asks the chosen dream model to emit JSON candidates.
 *
 * The reconcile stage decides what actually happens to each candidate; this
 * stage's only job is to surface candidate knowledge, with evidence.
 */

import type { MemoryEntry, MemoryEntryKind } from './types'
import { extractJsonObject } from './jsonExtract'

/** What stage 1 produces — pre-reconciliation candidates. */
export interface ExtractCandidate {
  kind: MemoryEntryKind
  scope: 'workspace' | 'task'
  taskId?: string
  text: string
  evidence: Array<{
    conversationId: string
    messageIndex?: number
    turnExcerpt?: string
  }>
  tags: string[]
  confidence: number
}

export interface ExtractStageDeps {
  /** Calls into ChatService.complete, provider-agnostic. */
  complete: (modelId: string, system: string, user: string) => Promise<string>
}

export interface ExtractStageInput {
  modelId: string
  transcripts: string
  existingEntries: MemoryEntry[]
  instructions?: string
}

export interface ExtractStageOutput {
  candidates: ExtractCandidate[]
  rawResponse: string
  parseFailed: boolean
}

const VALID_KINDS = new Set<MemoryEntryKind>([
  'preference',
  'project-fact',
  'decision',
  'playbook',
  'caveat',
  'pattern'
])

const EXTRACT_SYSTEM = [
  "You are Gladdis's memory curator. Your job is to read the user's recent",
  'conversations and surface durable knowledge worth carrying forward across',
  'future sessions. The user will review your output before it is applied.',
  '',
  'EXTRACT (each candidate is one self-contained, evidence-cited claim):',
  '  • preference   — long-lived user/team preferences (e.g. "prefers TypeScript")',
  '  • project-fact — medium-lived project state (e.g. "build = electron-vite 5")',
  '  • decision     — explicit choices made in conversation',
  '  • playbook     — procedural knowledge (how-to steps)',
  '  • caveat       — known pitfalls or anti-patterns',
  '  • pattern      — recurring observations across multiple sessions',
  '',
  'REJECT:',
  '  • Ephemera (timestamps, "just ran the test at 21:05", etc.)',
  '  • One-off debugging noise',
  '  • Any claim you cannot quote (turnExcerpt) directly from a transcript',
  '',
  'CONFIDENCE:',
  '  • 0.9+    stated multiple times or with clear intent',
  '  • 0.7-0.9 clearly stated once with good context',
  '  • 0.5-0.7 implied or inferred from a single instance',
  '',
  'OUTPUT STRICT JSON ONLY. No markdown fences, no commentary. Shape:',
  '{',
  '  "candidates": [',
  '    {',
  '      "kind": "preference" | "project-fact" | "decision" | "playbook" | "caveat" | "pattern",',
  '      "scope": "workspace" | "task",',
  '      "taskId": "...",                     // omit unless scope is "task"',
  '      "text": "one-sentence canonical statement",',
  '      "evidence": [',
  '        {',
  '          "conversationId": "conv-...",     // copy verbatim from a transcript header',
  '          "messageIndex": 4,',
  '          "turnExcerpt": "up to 140 chars quoting the source"',
  '        }',
  '      ],',
  '      "tags": ["..."],',
  '      "confidence": 0.0',
  '    }',
  '  ]',
  '}',
  '',
  'If nothing durable is worth carrying forward, return {"candidates": []}.'
].join('\n')

export async function runExtractStage(
  deps: ExtractStageDeps,
  input: ExtractStageInput
): Promise<ExtractStageOutput> {
  const user = buildExtractUserPrompt(input)
  const raw = await deps.complete(input.modelId, EXTRACT_SYSTEM, user)
  const parsed = extractJsonObject<{ candidates?: unknown }>(raw)
  if (!parsed) {
    return { candidates: [], rawResponse: raw, parseFailed: true }
  }
  const candidates = sanitizeCandidates(parsed.candidates)
  return { candidates, rawResponse: raw, parseFailed: false }
}

function buildExtractUserPrompt(input: ExtractStageInput): string {
  const existing = input.existingEntries.length > 0
    ? input.existingEntries
        .slice(0, 80)
        .map((e) => `  · [${e.kind}] ${e.text}`)
        .join('\n')
    : '  (none)'

  const sections = [
    '## Existing memory (do not re-propose; for context only)',
    existing,
    '',
    '## Recent conversations',
    input.transcripts || '(no transcripts available)'
  ]
  if (input.instructions?.trim()) {
    sections.push('', '## Steering hint', input.instructions.trim())
  }
  sections.push('', 'Emit the JSON now.')
  return sections.join('\n')
}

export function sanitizeCandidates(raw: unknown): ExtractCandidate[] {
  if (!Array.isArray(raw)) return []
  const out: ExtractCandidate[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const kind = typeof obj.kind === 'string' ? (obj.kind as MemoryEntryKind) : null
    const scope = obj.scope === 'task' ? 'task' : obj.scope === 'workspace' ? 'workspace' : null
    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    if (!kind || !VALID_KINDS.has(kind) || !scope || !text) continue

    const evidence = Array.isArray(obj.evidence)
      ? (obj.evidence as unknown[])
          .map((ev) => {
            if (!ev || typeof ev !== 'object') return null
            const e = ev as Record<string, unknown>
            const conversationId = typeof e.conversationId === 'string' ? e.conversationId : ''
            if (!conversationId) return null
            const messageIndex = typeof e.messageIndex === 'number' ? e.messageIndex : undefined
            const turnExcerpt = typeof e.turnExcerpt === 'string' ? e.turnExcerpt.slice(0, 240) : undefined
            return messageIndex === undefined && turnExcerpt === undefined
              ? null
              : { conversationId, messageIndex, turnExcerpt }
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : []
    if (evidence.length === 0) continue

    const tags = Array.isArray(obj.tags)
      ? (obj.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 8)
      : []
    let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.6
    if (!Number.isFinite(confidence)) confidence = 0.6
    confidence = Math.min(1, Math.max(0, confidence))

    out.push({
      kind,
      scope,
      taskId: scope === 'task' && typeof obj.taskId === 'string' ? obj.taskId : undefined,
      text,
      evidence,
      tags,
      confidence
    })
  }
  return out
}
