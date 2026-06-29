import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendDreamHistory,
  loadDreamHistory,
  patchDreamHistory,
  __test
} from './dreamHistory'
import type { DreamHistoryEntry } from '../../../../shared/dream'

function makeEntry(id: string, completedAt: number, partial: Partial<DreamHistoryEntry> = {}): DreamHistoryEntry {
  return {
    id,
    completedAt,
    source: 'auto',
    scope: '24h',
    modelId: 'codex-mini-latest',
    modelProvider: 'codex',
    ok: true,
    autoAdopted: false,
    awaitingReview: true,
    summary: { added: 1, merged: 0, replaced: 0, rejected: 0, unchanged: 0 },
    ...partial
  }
}

describe('dreamHistory', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gladdis-history-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('returns an empty file when none exists', async () => {
    const file = await loadDreamHistory(workspace)
    expect(file).toEqual({ version: 1, entries: [] })
  })

  it('appends newest-first', async () => {
    await appendDreamHistory(workspace, makeEntry('a', 1000))
    await appendDreamHistory(workspace, makeEntry('b', 2000))
    await appendDreamHistory(workspace, makeEntry('c', 3000))
    const file = await loadDreamHistory(workspace)
    expect(file.entries.map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('caps the rolling log', async () => {
    const cap = 3
    for (let i = 0; i < 10; i++) {
      await appendDreamHistory(workspace, makeEntry(`r${i}`, i), cap)
    }
    const file = await loadDreamHistory(workspace)
    expect(file.entries).toHaveLength(cap)
    expect(file.entries.map((e) => e.id)).toEqual(['r9', 'r8', 'r7'])
  })

  it('patches a single entry without rewriting others', async () => {
    await appendDreamHistory(workspace, makeEntry('a', 1000))
    await appendDreamHistory(workspace, makeEntry('b', 2000))
    await patchDreamHistory(workspace, 'a', { awaitingReview: false, autoAdopted: true })
    const file = await loadDreamHistory(workspace)
    const a = file.entries.find((e) => e.id === 'a')!
    expect(a.awaitingReview).toBe(false)
    expect(a.autoAdopted).toBe(true)
    const b = file.entries.find((e) => e.id === 'b')!
    expect(b.awaitingReview).toBe(true)
  })

  it('ignores patch for unknown id', async () => {
    await appendDreamHistory(workspace, makeEntry('a', 1000))
    await patchDreamHistory(workspace, 'nope', { autoAdopted: true })
    const file = await loadDreamHistory(workspace)
    const a = file.entries.find((e) => e.id === 'a')!
    expect(a.autoAdopted).toBe(false)
  })

  it('falls back to empty on malformed JSON', async () => {
    await mkdir(join(workspace, __test.MEMORY_DIR), { recursive: true })
    await writeFile(join(workspace, __test.MEMORY_DIR, __test.HISTORY_FILE), '{not json', 'utf8')
    const file = await loadDreamHistory(workspace)
    expect(file).toEqual({ version: 1, entries: [] })
  })

  it('drops malformed rows defensively but keeps valid ones', async () => {
    await mkdir(join(workspace, __test.MEMORY_DIR), { recursive: true })
    await writeFile(
      join(workspace, __test.MEMORY_DIR, __test.HISTORY_FILE),
      JSON.stringify({
        version: 1,
        entries: [
          makeEntry('a', 1000),
          { id: 'broken' }, // missing required fields
          makeEntry('b', 2000)
        ]
      }),
      'utf8'
    )
    const file = await loadDreamHistory(workspace)
    expect(file.entries.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('rejects a file with the wrong version', async () => {
    await mkdir(join(workspace, __test.MEMORY_DIR), { recursive: true })
    await writeFile(
      join(workspace, __test.MEMORY_DIR, __test.HISTORY_FILE),
      JSON.stringify({ version: 999, entries: [] }),
      'utf8'
    )
    const file = await loadDreamHistory(workspace)
    expect(file).toEqual({ version: 1, entries: [] })
  })

  it('persists failure entries too', async () => {
    await appendDreamHistory(
      workspace,
      makeEntry('failed', 1000, { ok: false, error: 'network', summary: undefined })
    )
    const file = await loadDreamHistory(workspace)
    expect(file.entries[0].ok).toBe(false)
    expect(file.entries[0].error).toBe('network')
  })

  it('writes valid JSON to disk', async () => {
    await appendDreamHistory(workspace, makeEntry('a', 1000))
    const raw = await readFile(join(workspace, __test.MEMORY_DIR, __test.HISTORY_FILE), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
