import { describe, expect, it, vi } from 'vitest'
import {
  pickTriageCandidates,
  runHygieneStage,
  sanitizeHygieneDecisions
} from './hygieneStage'
import type { MemoryEntry } from './types'

const NOW = '2026-06-29T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DAY_MS = 86_400_000
const WORKSPACE = '/tmp/ws'

function entry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const createdAt = partial.freshness?.createdAt ?? '2026-06-01T12:00:00.000Z'
  const lastReinforcedAt = partial.freshness?.lastReinforcedAt ?? createdAt
  return {
    kind: 'preference',
    scope: 'workspace',
    workspaceRoot: WORKSPACE,
    text: 'placeholder claim',
    evidence: [{ conversationId: 'conv-x', messageIndex: 0 }],
    confidence: 0.7,
    tags: [],
    ...partial,
    freshness: {
      createdAt,
      lastReinforcedAt,
      ...(partial.freshness ?? {})
    }
  }
}

const isoDaysAgo = (days: number) => new Date(NOW_MS - days * DAY_MS).toISOString()

// ── pickTriageCandidates ─────────────────────────────────────────────────

describe('pickTriageCandidates', () => {
  it('excludes archived and too-young entries', () => {
    const entries: MemoryEntry[] = [
      // Too young (< 14 days)
      entry({ id: 'young', freshness: { createdAt: isoDaysAgo(3), lastReinforcedAt: isoDaysAgo(3) } }),
      // Already archived — never reconsidered
      entry({
        id: 'archived',
        freshness: {
          createdAt: isoDaysAgo(90),
          lastReinforcedAt: isoDaysAgo(90),
          archivedAt: isoDaysAgo(30)
        }
      }),
      // Stale, eligible
      entry({
        id: 'stale',
        freshness: { createdAt: isoDaysAgo(120), lastReinforcedAt: isoDaysAgo(120) },
        confidence: 0.4
      })
    ]
    const out = pickTriageCandidates(entries, NOW_MS)
    expect(out.map((c) => c.entry.id)).toEqual(['stale'])
  })

  it('orders by staleness descending', () => {
    const entries: MemoryEntry[] = [
      // Fresh-ish, high confidence
      entry({
        id: 'fresh-strong',
        freshness: { createdAt: isoDaysAgo(60), lastReinforcedAt: isoDaysAgo(7) },
        confidence: 0.9,
        evidence: [
          { conversationId: 'a' },
          { conversationId: 'b' },
          { conversationId: 'c' }
        ]
      }),
      // Old, low confidence, thin evidence
      entry({
        id: 'old-weak',
        freshness: { createdAt: isoDaysAgo(180), lastReinforcedAt: isoDaysAgo(180) },
        confidence: 0.3,
        evidence: []
      }),
      // Medium age + medium confidence
      entry({
        id: 'mid',
        freshness: { createdAt: isoDaysAgo(60), lastReinforcedAt: isoDaysAgo(60) },
        confidence: 0.6
      })
    ]
    const out = pickTriageCandidates(entries, NOW_MS)
    expect(out.map((c) => c.entry.id)).toEqual(['old-weak', 'mid', 'fresh-strong'])
  })

  it('respects the limit parameter', () => {
    const entries: MemoryEntry[] = []
    for (let i = 0; i < 20; i++) {
      entries.push(
        entry({
          id: `e${i}`,
          freshness: {
            createdAt: isoDaysAgo(60 + i),
            lastReinforcedAt: isoDaysAgo(60 + i)
          },
          confidence: 0.5 - i * 0.01
        })
      )
    }
    const out = pickTriageCandidates(entries, NOW_MS, 5)
    expect(out).toHaveLength(5)
  })
})

// ── sanitizeHygieneDecisions ─────────────────────────────────────────────

describe('sanitizeHygieneDecisions', () => {
  const validEntries = [
    entry({ id: 'a' }),
    entry({ id: 'b' }),
    entry({ id: 'c' })
  ]

  it('returns [] on non-array input', () => {
    expect(sanitizeHygieneDecisions(undefined, validEntries)).toEqual([])
    expect(sanitizeHygieneDecisions('nope', validEntries)).toEqual([])
    expect(sanitizeHygieneDecisions({ wat: true }, validEntries)).toEqual([])
  })

  it('drops items pointing to unknown entry ids', () => {
    const out = sanitizeHygieneDecisions(
      [
        { entryId: 'missing', action: 'archive' },
        { entryId: 'a', action: 'archive' }
      ],
      validEntries
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.entryId).toBe('a')
  })

  it('drops items with unknown actions', () => {
    const out = sanitizeHygieneDecisions(
      [{ entryId: 'a', action: 'delete' }],
      validEntries
    )
    expect(out).toHaveLength(0)
  })

  it('dedupes by entryId (first wins)', () => {
    const out = sanitizeHygieneDecisions(
      [
        { entryId: 'a', action: 'archive', reason: 'first' },
        { entryId: 'a', action: 'demote', reason: 'second' }
      ],
      validEntries
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.action).toBe('archive')
  })

  it('drops keep decisions without newText (they are no-ops)', () => {
    const out = sanitizeHygieneDecisions(
      [
        { entryId: 'a', action: 'keep' },
        { entryId: 'b', action: 'keep', newText: ' refined text ' }
      ],
      validEntries
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.entryId).toBe('b')
    expect(out[0]?.newText).toBe('refined text')
  })

  it('clamps newConfidence into [0, 1]', () => {
    const out = sanitizeHygieneDecisions(
      [
        { entryId: 'a', action: 'demote', newConfidence: 2 },
        { entryId: 'b', action: 'reinforce', newConfidence: -1 }
      ],
      validEntries
    )
    expect(out[0]?.newConfidence).toBe(1)
    expect(out[1]?.newConfidence).toBe(0)
  })
})

// ── runHygieneStage: fallbacks ───────────────────────────────────────────

describe('runHygieneStage fallback', () => {
  it('skips when there are too few stale candidates (no model call)', async () => {
    const complete = vi.fn()
    const entries = [
      entry({
        id: 'one',
        freshness: { createdAt: isoDaysAgo(60), lastReinforcedAt: isoDaysAgo(60) }
      }),
      entry({
        id: 'two',
        freshness: { createdAt: isoDaysAgo(60), lastReinforcedAt: isoDaysAgo(60) }
      })
    ]
    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )
    expect(complete).not.toHaveBeenCalled()
    expect(out.skipped).toBe(true)
    expect(out.decisions).toEqual([])
    expect(out.resultEntries).toBe(entries)
    expect(out.triagedCount).toBe(2)
  })

  it('falls back gracefully when the model errors', async () => {
    const entries = makeTriageableSet()
    const complete = vi.fn().mockRejectedValue(new Error('network'))

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )
    expect(out.skipped).toBe(true)
    expect(out.decisions).toEqual([])
    expect(out.resultEntries).toBe(entries)
  })

  it('falls back when response is unparseable JSON', async () => {
    const entries = makeTriageableSet()
    const complete = vi.fn().mockResolvedValue('not even close to json')

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )
    expect(out.skipped).toBe(true)
    expect(out.rawResponse).toContain('not even')
  })

  it('not-skipped when LLM responds with an empty decisions array', async () => {
    const entries = makeTriageableSet()
    const complete = vi.fn().mockResolvedValue('{"decisions": []}')

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )
    expect(out.skipped).toBe(false)
    expect(out.decisions).toEqual([])
    expect(out.resultEntries).toBe(entries) // unchanged
  })
})

// ── runHygieneStage: applied decisions ───────────────────────────────────

describe('runHygieneStage application', () => {
  it('archives an entry without mutating the input list', async () => {
    const entries = makeTriageableSet()
    const target = entries.find((e) => e.id === 'old-weak')!
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decisions: [{ entryId: 'old-weak', action: 'archive', reason: 'stale' }]
      })
    )

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )

    expect(out.skipped).toBe(false)
    expect(out.decisions[0]?.action).toBe('archive')
    expect(target.freshness.archivedAt).toBeUndefined() // input unchanged
    const archived = out.resultEntries.find((e) => e.id === 'old-weak')
    expect(archived?.freshness.archivedAt).toBe(NOW)
    expect(archived?.freshness.archivedReason).toBe('stale')
  })

  it('demote drops confidence but floors at 0.3 and reports previous value', async () => {
    const entries = [
      ...makeTriageableSet(),
      entry({
        id: 'over-confident',
        freshness: { createdAt: isoDaysAgo(90), lastReinforcedAt: isoDaysAgo(90) },
        confidence: 0.85
      })
    ]
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decisions: [
          { entryId: 'over-confident', action: 'demote', newConfidence: 0.4, reason: 'over-stated' }
        ]
      })
    )

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )

    const decision = out.decisions.find((d) => d.entryId === 'over-confident')
    expect(decision?.action).toBe('demote')
    expect(decision?.previousConfidence).toBeCloseTo(0.85, 5)
    expect(decision?.newConfidence).toBeCloseTo(0.4, 5)
    const updated = out.resultEntries.find((e) => e.id === 'over-confident')!
    expect(updated.confidence).toBeCloseTo(0.4, 5)
  })

  it('demote rejected when proposed confidence is higher than current', async () => {
    const entries = [
      ...makeTriageableSet(),
      entry({
        id: 'low',
        freshness: { createdAt: isoDaysAgo(90), lastReinforcedAt: isoDaysAgo(90) },
        confidence: 0.3
      })
    ]
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decisions: [{ entryId: 'low', action: 'demote', newConfidence: 0.9 }]
      })
    )

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )

    // The bound clamps proposed-down to existing, so it ends up a no-op.
    const decision = out.decisions.find((d) => d.entryId === 'low')
    expect(decision).toBeUndefined()
  })

  it('reinforce bumps confidence and lastReinforcedAt', async () => {
    const entries = [
      ...makeTriageableSet(),
      entry({
        id: 'underrated',
        freshness: { createdAt: isoDaysAgo(90), lastReinforcedAt: isoDaysAgo(60) },
        confidence: 0.55
      })
    ]
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decisions: [{ entryId: 'underrated', action: 'reinforce', newConfidence: 0.8 }]
      })
    )

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )

    const updated = out.resultEntries.find((e) => e.id === 'underrated')!
    expect(updated.confidence).toBeCloseTo(0.8, 5)
    expect(updated.freshness.lastReinforcedAt).toBe(NOW)
  })

  it('keep with newText updates text only', async () => {
    const entries = makeTriageableSet()
    const targetBefore = entries.find((e) => e.id === 'old-weak')!
    const beforeConfidence = targetBefore.confidence
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decisions: [
          { entryId: 'old-weak', action: 'keep', newText: 'tighter wording' }
        ]
      })
    )

    const out = await runHygieneStage(
      { complete },
      { modelId: 'm', workspaceRoot: WORKSPACE, entries, now: NOW }
    )

    const decision = out.decisions.find((d) => d.entryId === 'old-weak')
    expect(decision?.action).toBe('keep')
    expect(decision?.newText).toBe('tighter wording')
    const updated = out.resultEntries.find((e) => e.id === 'old-weak')!
    expect(updated.text).toBe('tighter wording')
    expect(updated.confidence).toBe(beforeConfidence)
  })
})

// ── helpers ──────────────────────────────────────────────────────────────

function makeTriageableSet(): MemoryEntry[] {
  // At least MIN_ENTRIES_TO_TRIAGE (3) stale-eligible entries so the stage runs.
  return [
    entry({
      id: 'old-weak',
      freshness: { createdAt: isoDaysAgo(180), lastReinforcedAt: isoDaysAgo(180) },
      confidence: 0.4,
      text: 'old weak claim that probably is stale by now'
    }),
    entry({
      id: 'unused-fact',
      freshness: { createdAt: isoDaysAgo(90), lastReinforcedAt: isoDaysAgo(90) },
      confidence: 0.6,
      evidence: [],
      text: 'an unused fact with no evidence'
    }),
    entry({
      id: 'stale-pref',
      freshness: { createdAt: isoDaysAgo(120), lastReinforcedAt: isoDaysAgo(120) },
      confidence: 0.5,
      text: 'a stale preference'
    })
  ]
}
