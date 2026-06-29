import { describe, expect, it, vi } from 'vitest'
import {
  runLlmReconcileReview,
  sanitizeOverrides,
  type LlmReconcileStageInput
} from './llmReconcileStage'
import { runReconcileStage } from './reconcileStage'
import type { ExtractCandidate } from './extractStage'
import type { MemoryEntry } from './types'

const NOW = '2026-06-29T14:00:00.000Z'
const WORKSPACE = '/tmp/ws'

function entry(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem_a',
    kind: 'preference',
    scope: 'workspace',
    workspaceRoot: WORKSPACE,
    text: 'user prefers TypeScript over JavaScript',
    evidence: [{ conversationId: 'conv-old', messageIndex: 1 }],
    confidence: 0.85,
    freshness: { createdAt: NOW, lastReinforcedAt: NOW },
    tags: ['lang'],
    ...partial
  }
}

function candidate(partial: Partial<ExtractCandidate>): ExtractCandidate {
  return {
    kind: 'preference',
    scope: 'workspace',
    text: 'TypeScript is preferred over JavaScript',
    evidence: [
      { conversationId: 'conv-new', messageIndex: 7, turnExcerpt: 'always TS' }
    ],
    tags: [],
    confidence: 0.7,
    ...partial
  }
}

function buildBaseline(input: {
  existingEntries: MemoryEntry[]
  candidates: ExtractCandidate[]
}) {
  return runReconcileStage({
    existingEntries: input.existingEntries,
    candidates: input.candidates,
    workspaceRoot: WORKSPACE,
    now: NOW
  })
}

function baseInput(extra: Partial<LlmReconcileStageInput> = {}): LlmReconcileStageInput {
  const existingEntries = extra.existingEntries ?? []
  const candidates = extra.candidates ?? []
  const baseline = buildBaseline({ existingEntries, candidates })
  return {
    modelId: 'test-model',
    workspaceRoot: WORKSPACE,
    existingEntries,
    candidates,
    baselineDecisions: baseline.decisions,
    now: NOW,
    ...extra
  }
}

// ── sanitizeOverrides ─────────────────────────────────────────────────────

describe('sanitizeOverrides', () => {
  it('drops items with out-of-range candidate indices', () => {
    const out = sanitizeOverrides(
      [
        { candidateIndex: 5, action: 'reject' },
        { candidateIndex: -1, action: 'add' },
        { candidateIndex: 0, action: 'reject' }
      ],
      2
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.candidateIndex).toBe(0)
  })

  it('drops items with unknown actions', () => {
    const out = sanitizeOverrides(
      [{ candidateIndex: 0, action: 'frobnicate' }],
      2
    )
    expect(out).toHaveLength(0)
  })

  it('requires mergeIntoEntryId for merge/replace', () => {
    const merged = sanitizeOverrides(
      [
        { candidateIndex: 0, action: 'merge' },
        { candidateIndex: 1, action: 'replace', mergeIntoEntryId: 'mem_x' }
      ],
      2
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.action).toBe('replace')
  })

  it('dedupes by candidateIndex (first wins)', () => {
    const out = sanitizeOverrides(
      [
        { candidateIndex: 0, action: 'reject', reason: 'first' },
        { candidateIndex: 0, action: 'add', reason: 'second' }
      ],
      2
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.action).toBe('reject')
  })

  it('keeps optional fields when valid', () => {
    const out = sanitizeOverrides(
      [
        {
          candidateIndex: 0,
          action: 'add',
          newScope: 'task',
          newKind: 'caveat',
          newText: '  tighter wording  ',
          reason: 'cleanup'
        }
      ],
      1
    )
    expect(out[0]).toMatchObject({
      newScope: 'task',
      newKind: 'caveat',
      newText: 'tighter wording',
      reason: 'cleanup'
    })
  })

  it('rejects bogus newKind / newScope values silently', () => {
    const out = sanitizeOverrides(
      [
        {
          candidateIndex: 0,
          action: 'add',
          newScope: 'global',
          newKind: 'lunch'
        }
      ],
      1
    )
    expect(out[0]?.newScope).toBeUndefined()
    expect(out[0]?.newKind).toBeUndefined()
  })

  it('returns [] on non-array input', () => {
    expect(sanitizeOverrides(undefined, 2)).toEqual([])
    expect(sanitizeOverrides('nope', 2)).toEqual([])
    expect(sanitizeOverrides({ items: [] }, 2)).toEqual([])
  })
})

// ── runLlmReconcileReview: fallbacks ─────────────────────────────────────

describe('runLlmReconcileReview fallback', () => {
  it('skips when there are no candidates (no model call)', async () => {
    const complete = vi.fn()
    const out = await runLlmReconcileReview(
      { complete },
      baseInput({ existingEntries: [], candidates: [] })
    )
    expect(complete).not.toHaveBeenCalled()
    expect(out.skipped).toBe(true)
    expect(out.decisions).toEqual([])
    expect(out.resultEntries).toEqual([])
    expect(out.overrideCount).toBe(0)
  })

  it('falls back to deterministic when the model errors', async () => {
    const peer = entry({})
    const cand = candidate({})
    const input = baseInput({ existingEntries: [peer], candidates: [cand] })
    const complete = vi.fn().mockRejectedValue(new Error('network'))

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.skipped).toBe(true)
    expect(out.overrideCount).toBe(0)
    // Deterministic decision for this case is merge.
    expect(out.decisions[0]?.action).toBe('merge')
    expect(out.resultEntries).toHaveLength(1)
  })

  it('falls back when the model returns unparseable text', async () => {
    const cand = candidate({})
    const input = baseInput({ existingEntries: [], candidates: [cand] })
    const complete = vi.fn().mockResolvedValue('???not json???')

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.skipped).toBe(true)
    expect(out.rawResponse).toContain('???')
    expect(out.decisions).toHaveLength(1)
  })

  it('keeps deterministic when overrides array is empty', async () => {
    const cand = candidate({})
    const input = baseInput({ existingEntries: [], candidates: [cand] })
    const complete = vi.fn().mockResolvedValue('{"overrides": []}')

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.skipped).toBe(false)
    expect(out.overrideCount).toBe(0)
    expect(out.decisions[0]?.action).toBe('add')
  })
})

// ── runLlmReconcileReview: real overrides ────────────────────────────────

describe('runLlmReconcileReview overrides', () => {
  it('flips ADD → REJECT when the model says so', async () => {
    const cand = candidate({})
    const input = baseInput({ existingEntries: [], candidates: [cand] })
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        overrides: [{ candidateIndex: 0, action: 'reject', reason: 'no evidence' }]
      })
    )

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.overrideCount).toBe(1)
    expect(out.decisions[0]?.action).toBe('reject')
    expect(out.decisions[0]?.reason).toBe('no evidence')
    expect(out.resultEntries).toHaveLength(0)
  })

  it('flips ADD → MERGE into a specific existing entry', async () => {
    // Candidate text token-overlap is intentionally too low for deterministic
    // merge, so the baseline picks ADD; the model overrides to MERGE.
    const peer = entry({
      id: 'mem_peer',
      text: 'engineer prefers strict typing in Node services'
    })
    const cand = candidate({ text: 'always opt for typed Node' })
    const input = baseInput({ existingEntries: [peer], candidates: [cand] })

    expect(input.baselineDecisions[0]?.action).toBe('add')

    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        overrides: [
          {
            candidateIndex: 0,
            action: 'merge',
            mergeIntoEntryId: 'mem_peer',
            reason: 'semantic dup'
          }
        ]
      })
    )

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.overrideCount).toBe(1)
    expect(out.decisions[0]?.action).toBe('merge')
    expect(out.decisions[0]?.affectedEntryId).toBe('mem_peer')
    expect(out.resultEntries).toHaveLength(1)
    const merged = out.resultEntries[0]!
    // Merge picks up the new conversation as evidence.
    expect(merged.evidence.some((e) => e.conversationId === 'conv-new')).toBe(true)
  })

  it('promotes a task-scoped candidate to workspace via newScope', async () => {
    const cand = candidate({ scope: 'task', taskId: 'audit-1' })
    const input = baseInput({ existingEntries: [], candidates: [cand] })
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        overrides: [
          { candidateIndex: 0, action: 'add', newScope: 'workspace', reason: 'project-wide' }
        ]
      })
    )

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.overrideCount).toBe(1)
    expect(out.resultEntries).toHaveLength(1)
    expect(out.resultEntries[0]?.scope).toBe('workspace')
    expect(out.resultEntries[0]?.taskId).toBeUndefined()
  })

  it('falls back to ADD when merge target is missing', async () => {
    const cand = candidate({})
    const input = baseInput({ existingEntries: [], candidates: [cand] })
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        overrides: [
          { candidateIndex: 0, action: 'merge', mergeIntoEntryId: 'mem_missing' }
        ]
      })
    )

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.decisions[0]?.action).toBe('add')
    expect(out.resultEntries).toHaveLength(1)
  })

  it('confirms unchanged decisions when only some are overridden', async () => {
    const candA = candidate({ text: 'avoid console.log in production' })
    const candB = candidate({ text: 'prefer dark mode' })
    const input = baseInput({
      existingEntries: [],
      candidates: [candA, candB]
    })

    expect(input.baselineDecisions[0]?.action).toBe('add')
    expect(input.baselineDecisions[1]?.action).toBe('add')

    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        overrides: [
          { candidateIndex: 1, action: 'reject', reason: 'ephemeral' }
        ]
      })
    )

    const out = await runLlmReconcileReview({ complete }, input)

    expect(out.overrideCount).toBe(1)
    expect(out.decisions).toHaveLength(2)
    expect(out.decisions[0]?.action).toBe('add')
    expect(out.decisions[1]?.action).toBe('reject')
    expect(out.resultEntries).toHaveLength(1)
  })
})

// ── prompt smoke check ────────────────────────────────────────────────────

describe('review prompt', () => {
  it('includes candidate text, baseline action, and peer ids', async () => {
    const peer = entry({ id: 'mem_peer', text: 'use TypeScript' })
    const cand = candidate({ text: 'we use TypeScript' })
    const input = baseInput({ existingEntries: [peer], candidates: [cand] })

    let capturedUser = ''
    const complete = vi.fn().mockImplementation(async (_id, _sys, user) => {
      capturedUser = user
      return '{"overrides": []}'
    })

    await runLlmReconcileReview({ complete }, input)

    expect(capturedUser).toContain('Workspace root: /tmp/ws')
    expect(capturedUser).toContain('mem_peer')
    expect(capturedUser).toContain('we use TypeScript')
    expect(capturedUser).toMatch(/baseline=(add|merge|replace|reject)/)
  })
})
