import { describe, expect, it } from 'vitest'
import { applyPartialAdoption } from './applyPartialAdoption'
import type { MemoryEntry, MemoryFileV2 } from './types'
import { MEMORY_FILE_VERSION } from './types'
import type { DreamDiff } from '../../../../shared/dream'

const NOW = '2026-06-29T19:00:00.000Z'
const WS = '/tmp/ws'

function entry(id: string, partial: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: 'preference',
    scope: 'workspace',
    workspaceRoot: WS,
    text: `entry ${id}`,
    evidence: [],
    confidence: 0.8,
    freshness: { createdAt: NOW, lastReinforcedAt: NOW },
    tags: [],
    ...partial
  }
}

function memoryFile(entries: MemoryEntry[]): MemoryFileV2 {
  return {
    version: MEMORY_FILE_VERSION,
    workspace: { root: WS, updatedAt: NOW },
    entries,
    tasks: {}
  }
}

function diff(partial: Partial<DreamDiff> = {}): DreamDiff {
  return {
    id: 'drm_test',
    createdAt: 0,
    modelId: 'codex-mini-latest',
    modelProvider: 'codex',
    scope: '24h',
    workspaceRoot: WS,
    summary: { added: 0, merged: 0, replaced: 0, rejected: 0, unchanged: 0 },
    verifications: [],
    entries: [],
    adoption: { blocked: false, issues: [] },
    awaitingAdopt: true,
    candidateFilePath: '/tmp/ws/.gladdis/memory.next.json',
    sampledSessionCount: 1,
    ...partial
  }
}

describe('applyPartialAdoption', () => {
  it('returns the candidate unchanged when no selection is provided', () => {
    const live = memoryFile([entry('mem_a')])
    const candidate = memoryFile([entry('mem_a'), entry('mem_b')])
    const result = applyPartialAdoption(live, candidate, diff(), undefined)
    expect(result).toBe(candidate)
  })

  it('returns the candidate unchanged when both selection arrays are undefined', () => {
    const live = memoryFile([])
    const candidate = memoryFile([entry('mem_a')])
    const result = applyPartialAdoption(live, candidate, diff(), {})
    expect(result).toBe(candidate)
  })

  it('drops new "add" entries when their row is unselected', () => {
    const live = memoryFile([entry('mem_a')])
    const candidate = memoryFile([entry('mem_a'), entry('mem_new')])
    const d = diff({
      entries: [
        {
          action: 'add',
          entryId: 'mem_new',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_new',
          confidence: 0.8,
          evidenceCount: 0
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedEntryIds: [] })
    expect(result.entries.map((e) => e.id)).toEqual(['mem_a'])
  })

  it('keeps new "add" entries when their row is selected', () => {
    const live = memoryFile([entry('mem_a')])
    const candidate = memoryFile([entry('mem_a'), entry('mem_new')])
    const d = diff({
      entries: [
        {
          action: 'add',
          entryId: 'mem_new',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_new',
          confidence: 0.8,
          evidenceCount: 0
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedEntryIds: ['mem_new'] })
    expect(result.entries.map((e) => e.id).sort()).toEqual(['mem_a', 'mem_new'])
  })

  it('falls back to live for unselected merge rows', () => {
    const live = memoryFile([entry('mem_a', { text: 'original A' })])
    const candidate = memoryFile([entry('mem_a', { text: 'merged A' })])
    const d = diff({
      entries: [
        {
          action: 'merge',
          entryId: 'mem_a',
          kind: 'preference',
          scope: 'workspace',
          text: 'merged A',
          confidence: 0.85,
          evidenceCount: 1
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedEntryIds: [] })
    expect(result.entries[0].text).toBe('original A')
  })

  it('falls back to live for unselected replace rows', () => {
    const live = memoryFile([entry('mem_a', { text: 'original A', confidence: 0.7 })])
    const candidate = memoryFile([entry('mem_a', { text: 'replaced A', confidence: 0.95 })])
    const d = diff({
      entries: [
        {
          action: 'replace',
          entryId: 'mem_a',
          kind: 'preference',
          scope: 'workspace',
          text: 'replaced A',
          confidence: 0.95,
          evidenceCount: 1
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedEntryIds: [] })
    expect(result.entries[0].text).toBe('original A')
    expect(result.entries[0].confidence).toBe(0.7)
  })

  it('preserves live entries the candidate dropped (defensive)', () => {
    const live = memoryFile([entry('mem_a'), entry('mem_ghost')])
    const candidate = memoryFile([entry('mem_a')])
    const result = applyPartialAdoption(live, candidate, diff(), {
      acceptedEntryIds: []
    })
    expect(result.entries.map((e) => e.id).sort()).toEqual(['mem_a', 'mem_ghost'])
  })

  it('falls back to live for unselected hygiene rows', () => {
    const live = memoryFile([
      entry('mem_old', {
        confidence: 0.6,
        freshness: { createdAt: NOW, lastReinforcedAt: NOW }
      })
    ])
    const candidate = memoryFile([
      entry('mem_old', {
        confidence: 0.6,
        freshness: {
          createdAt: NOW,
          lastReinforcedAt: NOW,
          archivedAt: NOW,
          archivedReason: 'stale'
        }
      })
    ])
    const d = diff({
      hygiene: [
        {
          action: 'archive',
          entryId: 'mem_old',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_old',
          confidence: 0.6,
          reason: 'stale'
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedHygieneIds: [] })
    expect(result.entries[0].freshness.archivedAt).toBeUndefined()
  })

  it('applies hygiene rows when selected', () => {
    const live = memoryFile([
      entry('mem_old', {
        confidence: 0.6,
        freshness: { createdAt: NOW, lastReinforcedAt: NOW }
      })
    ])
    const candidate = memoryFile([
      entry('mem_old', {
        confidence: 0.4,
        freshness: { createdAt: NOW, lastReinforcedAt: NOW }
      })
    ])
    const d = diff({
      hygiene: [
        {
          action: 'demote',
          entryId: 'mem_old',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_old',
          confidence: 0.4,
          previousConfidence: 0.6,
          reason: 'thin evidence'
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedHygieneIds: ['mem_old'] })
    expect(result.entries[0].confidence).toBe(0.4)
  })

  it('handles a mixed-selection scenario end-to-end', () => {
    const live = memoryFile([
      entry('mem_keep', { text: 'live keep' }),
      entry('mem_merged', { text: 'live merged' }),
      entry('mem_archived', {
        text: 'live archived',
        freshness: { createdAt: NOW, lastReinforcedAt: NOW }
      })
    ])
    const candidate = memoryFile([
      entry('mem_keep', { text: 'live keep' }),
      entry('mem_merged', { text: 'merged version' }),
      entry('mem_new'),
      entry('mem_archived', {
        text: 'live archived',
        freshness: {
          createdAt: NOW,
          lastReinforcedAt: NOW,
          archivedAt: NOW,
          archivedReason: 'stale'
        }
      })
    ])
    const d = diff({
      entries: [
        {
          action: 'merge',
          entryId: 'mem_merged',
          kind: 'preference',
          scope: 'workspace',
          text: 'merged version',
          confidence: 0.85,
          evidenceCount: 2
        },
        {
          action: 'add',
          entryId: 'mem_new',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_new',
          confidence: 0.85,
          evidenceCount: 1
        }
      ],
      hygiene: [
        {
          action: 'archive',
          entryId: 'mem_archived',
          kind: 'preference',
          scope: 'workspace',
          text: 'live archived',
          confidence: 0.8,
          reason: 'stale'
        }
      ]
    })
    // Accept the merge but reject the new entry and the archive.
    const result = applyPartialAdoption(live, candidate, d, {
      acceptedEntryIds: ['mem_merged'],
      acceptedHygieneIds: []
    })
    const byId = new Map(result.entries.map((e) => [e.id, e]))
    expect(byId.get('mem_merged')!.text).toBe('merged version')
    expect(byId.has('mem_new')).toBe(false)
    expect(byId.get('mem_archived')!.freshness.archivedAt).toBeUndefined()
    expect(byId.get('mem_keep')!.text).toBe('live keep')
  })

  it('handles a null live memory (first-ever adopt)', () => {
    const candidate = memoryFile([entry('mem_a')])
    const d = diff({
      entries: [
        {
          action: 'add',
          entryId: 'mem_a',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_a',
          confidence: 0.85,
          evidenceCount: 1
        }
      ]
    })
    const result = applyPartialAdoption(null, candidate, d, { acceptedEntryIds: ['mem_a'] })
    expect(result.entries.map((e) => e.id)).toEqual(['mem_a'])
  })

  it('refreshes workspace.updatedAt on partial adopt', () => {
    const live = memoryFile([entry('mem_a')])
    const candidate = memoryFile([entry('mem_a'), entry('mem_b')])
    const d = diff({
      entries: [
        {
          action: 'add',
          entryId: 'mem_b',
          kind: 'preference',
          scope: 'workspace',
          text: 'entry mem_b',
          confidence: 0.8,
          evidenceCount: 1
        }
      ]
    })
    const result = applyPartialAdoption(live, candidate, d, { acceptedEntryIds: ['mem_b'] })
    // The fresh ISO timestamp is generated at call time, so just check it
    // changed from the candidate's static one.
    expect(result.workspace.updatedAt).not.toBe(NOW)
    expect(result.workspace.root).toBe(WS)
  })
})
