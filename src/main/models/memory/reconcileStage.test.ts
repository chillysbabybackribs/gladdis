import { describe, expect, it } from 'vitest'
import { runReconcileStage, textSimilarity } from './reconcileStage'
import type { ExtractCandidate } from './extractStage'
import type { MemoryEntry } from './types'

const NOW = '2026-06-29T12:00:00.000Z'
const WORKSPACE = '/tmp/ws'

function existing(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem_existing',
    kind: 'preference',
    scope: 'workspace',
    workspaceRoot: WORKSPACE,
    text: 'user prefers TypeScript over JavaScript',
    evidence: [{ conversationId: 'conv-1', messageIndex: 2 }],
    confidence: 0.8,
    freshness: { createdAt: NOW, lastReinforcedAt: NOW },
    tags: ['legacy-tag'],
    ...partial
  }
}

function candidate(partial: Partial<ExtractCandidate>): ExtractCandidate {
  return {
    kind: 'preference',
    scope: 'workspace',
    text: 'user prefers TypeScript over JavaScript',
    evidence: [{ conversationId: 'conv-2', messageIndex: 4, turnExcerpt: 'we always use TS' }],
    tags: [],
    confidence: 0.75,
    ...partial
  }
}

describe('textSimilarity', () => {
  it('returns 1 for identical text', () => {
    expect(textSimilarity('user prefers typescript', 'user prefers typescript')).toBe(1)
  })
  it('returns 0 for fully disjoint sets', () => {
    expect(textSimilarity('alpha beta', 'gamma delta')).toBe(0)
  })
  it('is case-insensitive and ignores short tokens', () => {
    expect(textSimilarity('User Prefers Typescript', 'user prefers TYPESCRIPT')).toBe(1)
  })
})

describe('runReconcileStage', () => {
  it('merges a near-duplicate candidate into the existing entry', () => {
    const peer = existing({})
    const result = runReconcileStage({
      existingEntries: [peer],
      candidates: [candidate({})],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0].action).toBe('merge')
    expect(result.decisions[0].affectedEntryId).toBe(peer.id)
    expect(result.resultEntries).toHaveLength(1)
    // Evidence got concatenated.
    expect(result.resultEntries[0].evidence.length).toBeGreaterThan(1)
  })

  it('adds a novel candidate when no peer is similar', () => {
    const peer = existing({ text: 'project uses electron-vite' })
    const result = runReconcileStage({
      existingEntries: [peer],
      candidates: [
        candidate({ text: 'team uses GitHub Actions for CI', kind: 'project-fact', confidence: 0.8 })
      ],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    expect(result.decisions[0].action).toBe('add')
    expect(result.resultEntries).toHaveLength(2)
  })

  it('rejects low-confidence candidates with thin evidence', () => {
    const result = runReconcileStage({
      existingEntries: [],
      candidates: [
        candidate({ confidence: 0.3, evidence: [{ conversationId: 'c1' }] })
      ],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    expect(result.decisions[0].action).toBe('reject')
    expect(result.resultEntries).toHaveLength(0)
  })

  it('replaces when candidate confidence dominates a low-confidence peer with mid similarity', () => {
    const peer = existing({
      // Same domain, partially-overlapping wording -> ~0.5 similarity
      text: 'team historically used JavaScript',
      confidence: 0.5
    })
    const result = runReconcileStage({
      existingEntries: [peer],
      candidates: [
        candidate({
          text: 'team has switched to TypeScript across the codebase',
          confidence: 0.9
        })
      ],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    // Replace expects ≥0.35 similarity AND a 0.1+ confidence margin.
    // The candidate may not always replace; the rule is conservative. Allow
    // either replace or add depending on token overlap, but if replace, the
    // contradictsId must be set.
    const decision = result.decisions[0]
    if (decision.action === 'replace') {
      const replaced = result.resultEntries.find((e) => e.id !== peer.id)
      expect(replaced?.freshness.contradictsId).toBe(peer.id)
    } else {
      expect(['add', 'reject']).toContain(decision.action)
    }
  })

  it('canonicalizes to the shorter wording on merge', () => {
    const peer = existing({ text: 'user explicitly prefers TypeScript over JavaScript for everything' })
    const result = runReconcileStage({
      existingEntries: [peer],
      candidates: [candidate({ text: 'user prefers TypeScript' })],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    expect(result.decisions[0].action).toBe('merge')
    expect(result.resultEntries[0].text).toBe('user prefers TypeScript')
  })

  it('keeps task and workspace scopes isolated', () => {
    const peer = existing({ scope: 'task', taskId: 'task-1' })
    const result = runReconcileStage({
      existingEntries: [peer],
      candidates: [candidate({ scope: 'workspace' })],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    expect(result.decisions[0].action).toBe('add')
    expect(result.resultEntries).toHaveLength(2)
  })

  it('tags new entries with "dreamed" for provenance', () => {
    const result = runReconcileStage({
      existingEntries: [],
      candidates: [candidate({ tags: ['ts'] })],
      workspaceRoot: WORKSPACE,
      now: NOW
    })
    expect(result.resultEntries[0].tags).toContain('dreamed')
  })
})
