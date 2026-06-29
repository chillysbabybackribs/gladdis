import { describe, expect, it } from 'vitest'
import { composeDreamDiff } from './diff'
import type { ExtractCandidate } from './extractStage'
import type { ReconcileDecision } from './reconcileStage'
import type { MemoryEntry } from './types'

const NOW = '2026-06-29T12:00:00.000Z'
const WORKSPACE = '/tmp/ws'

function entry(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem_x',
    kind: 'preference',
    scope: 'workspace',
    workspaceRoot: WORKSPACE,
    text: 'placeholder',
    evidence: [],
    confidence: 0.8,
    freshness: { createdAt: NOW, lastReinforcedAt: NOW },
    tags: [],
    ...partial
  }
}

function cand(partial: Partial<ExtractCandidate>): ExtractCandidate {
  return {
    kind: 'preference',
    scope: 'workspace',
    text: 'candidate text',
    evidence: [{ conversationId: 'c' }],
    tags: [],
    confidence: 0.7,
    ...partial
  }
}

describe('composeDreamDiff', () => {
  it('counts unchanged existing entries that no decision touched', () => {
    const untouched = entry({ id: 'mem_a', text: 'unchanged claim' })
    const affected = entry({ id: 'mem_b', text: 'something old' })
    const result = entry({ id: 'mem_b', text: 'something new' })

    const decisions: ReconcileDecision[] = [
      {
        action: 'replace',
        candidate: cand({ text: 'something new' }),
        affectedEntryId: 'mem_b',
        resultEntryId: 'mem_b',
        previousText: 'something old',
        reason: 'higher confidence'
      }
    ]

    const diff = composeDreamDiff({
      id: 'drm_test',
      createdAt: 1_700_000_000_000,
      modelId: 'claude-haiku-4-5',
      modelProvider: 'anthropic',
      scope: '7d',
      workspaceRoot: WORKSPACE,
      existingEntries: [untouched, affected],
      resultEntries: [untouched, result],
      decisions,
      verifications: [],
      sampledSessionCount: 1
    })

    expect(diff.summary.unchanged).toBe(1)
    expect(diff.summary.replaced).toBe(1)
    expect(diff.summary.added).toBe(0)
    expect(diff.entries.find((e) => e.action === 'replace')?.previousText).toBe('something old')
    expect(diff.awaitingAdopt).toBe(true)
  })

  it('counts and labels adds and merges separately', () => {
    const added = entry({ id: 'mem_new', text: 'novel' })
    const decisions: ReconcileDecision[] = [
      { action: 'add', candidate: cand({ text: 'novel' }), resultEntryId: 'mem_new', reason: 'novel' },
      {
        action: 'merge',
        candidate: cand({ text: 'something' }),
        affectedEntryId: 'mem_a',
        resultEntryId: 'mem_a',
        reason: 'same claim'
      }
    ]
    const peer = entry({ id: 'mem_a', text: 'something' })

    const diff = composeDreamDiff({
      id: 'drm_test',
      createdAt: 1,
      modelId: 'm',
      modelProvider: 'codex',
      scope: '24h',
      workspaceRoot: WORKSPACE,
      existingEntries: [peer],
      resultEntries: [peer, added],
      decisions,
      verifications: [],
      sampledSessionCount: 2
    })

    expect(diff.summary.added).toBe(1)
    expect(diff.summary.merged).toBe(1)
    expect(diff.summary.unchanged).toBe(0)
  })

  it('places reject decisions in the entries array using the candidate text', () => {
    const decisions: ReconcileDecision[] = [
      { action: 'reject', candidate: cand({ text: 'too vague' }), reason: 'low confidence' }
    ]
    const diff = composeDreamDiff({
      id: 'drm_test',
      createdAt: 1,
      modelId: 'm',
      modelProvider: 'codex',
      scope: '24h',
      workspaceRoot: WORKSPACE,
      existingEntries: [],
      resultEntries: [],
      decisions,
      verifications: [],
      sampledSessionCount: 1
    })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0].action).toBe('reject')
    expect(diff.entries[0].text).toBe('too vague')
    expect(diff.summary.rejected).toBe(1)
  })
})
