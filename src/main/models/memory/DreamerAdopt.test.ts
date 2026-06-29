import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dreamer } from './Dreamer'
import type { ChatStore } from '../ChatStore'
import type { DreamDiff, KeyStatus } from '../../../../shared/types'
import type { MemoryFileV2 } from './types'
import { MEMORY_FILE_VERSION } from './types'

const KEYED: KeyStatus = {
  anthropic: false,
  google: false,
  codex: true,
  openai: false,
  grok: false
}

function fakeChatStore(): ChatStore {
  return { list: () => [], get: () => null } as unknown as ChatStore
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('Dreamer adoption', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gladdis-dreamer-adopt-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('promotes an approved candidate and clears the pending adopt file', async () => {
    const dir = join(workspace, '.gladdis')
    const candidatePath = join(dir, 'memory.next.json')
    const diffPath = join(dir, 'memory.next.diff.json')
    await mkdir(dir, { recursive: true })

    const now = new Date().toISOString()
    const candidate: MemoryFileV2 = {
      version: MEMORY_FILE_VERSION,
      workspace: { root: '/moved/workspace', updatedAt: '2000-01-01T00:00:00.000Z' },
      entries: [
        {
          id: 'mem_adoptable',
          kind: 'preference',
          scope: 'workspace',
          workspaceRoot: workspace,
          text: 'user prefers concise prose',
          evidence: [{ conversationId: 'conv-1' }],
          confidence: 0.95,
          freshness: { createdAt: now, lastReinforcedAt: now },
          tags: ['dreamed']
        }
      ],
      tasks: {}
    }
    const diff: DreamDiff = {
      id: 'drm_adoptable',
      createdAt: Date.now(),
      modelId: 'codex-mini-latest',
      modelProvider: 'codex',
      scope: '7d',
      workspaceRoot: workspace,
      summary: { added: 1, merged: 0, replaced: 0, rejected: 0, unchanged: 0 },
      verifications: [{ entryId: 'mem_adoptable', verdict: 'supported', reason: 'confirmed' }],
      entries: [
        {
          action: 'add',
          entryId: 'mem_adoptable',
          kind: 'preference',
          scope: 'workspace',
          text: 'user prefers concise prose',
          confidence: 0.95,
          evidenceCount: 1
        }
      ],
      adoption: { blocked: false, issues: [] },
      awaitingAdopt: true,
      candidateFilePath: candidatePath,
      sampledSessionCount: 1
    }
    await writeFile(candidatePath, JSON.stringify(candidate), 'utf8')
    await writeFile(diffPath, JSON.stringify(diff), 'utf8')

    const dreamer = new Dreamer({
      chats: fakeChatStore(),
      complete: async () => '{}',
      getKeyStatus: () => KEYED
    })

    const result = await dreamer.adopt(workspace)
    const memory = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8')) as MemoryFileV2
    const last = await dreamer.loadLast(workspace)

    expect(result).toEqual({ ok: true, entryCount: 1 })
    expect(memory.workspace.root).toBe(workspace)
    expect(memory.entries).toHaveLength(1)
    expect(memory.entries[0].id).toBe('mem_adoptable')
    expect(await exists(candidatePath)).toBe(false)
    expect(last?.awaitingAdopt).toBe(false)
  })

  it('recomputes stale persisted policy when adopting an existing merge row', async () => {
    const dir = join(workspace, '.gladdis')
    const candidatePath = join(dir, 'memory.next.json')
    const diffPath = join(dir, 'memory.next.diff.json')
    await mkdir(dir, { recursive: true })

    const now = new Date().toISOString()
    const candidate: MemoryFileV2 = {
      version: MEMORY_FILE_VERSION,
      workspace: { root: workspace, updatedAt: now },
      entries: [
        {
          id: 'mem_existing',
          kind: 'caveat',
          scope: 'workspace',
          workspaceRoot: workspace,
          text: 'existing claim with additional evidence',
          evidence: [{ conversationId: 'conv-1' }, { conversationId: 'conv-2' }],
          confidence: 0.92,
          freshness: { createdAt: now, lastReinforcedAt: now },
          tags: ['dreamed']
        }
      ],
      tasks: {}
    }
    const diff: DreamDiff = {
      id: 'drm_merge',
      createdAt: Date.now(),
      modelId: 'codex-mini-latest',
      modelProvider: 'codex',
      scope: '7d',
      workspaceRoot: workspace,
      summary: { added: 0, merged: 1, replaced: 0, rejected: 0, unchanged: 0 },
      verifications: [
        { entryId: 'mem_existing', verdict: 'partial', reason: 'some but not all evidence is explicit' }
      ],
      entries: [
        {
          action: 'merge',
          entryId: 'mem_existing',
          kind: 'caveat',
          scope: 'workspace',
          text: 'existing claim with additional evidence',
          confidence: 0.92,
          evidenceCount: 2
        }
      ],
      adoption: {
        blocked: true,
        issues: [
          {
            code: 'partial-verification',
            entryId: 'mem_existing',
            message: 'stale policy from an older app version'
          }
        ]
      },
      awaitingAdopt: true,
      candidateFilePath: candidatePath,
      sampledSessionCount: 1
    }
    await writeFile(candidatePath, JSON.stringify(candidate), 'utf8')
    await writeFile(diffPath, JSON.stringify(diff), 'utf8')

    const dreamer = new Dreamer({
      chats: fakeChatStore(),
      complete: async () => '{}',
      getKeyStatus: () => KEYED
    })

    const lastBefore = await dreamer.loadLast(workspace)
    const result = await dreamer.adopt(workspace)

    expect(lastBefore?.adoption).toEqual({ blocked: false, issues: [] })
    expect(result).toEqual({ ok: true, entryCount: 1 })
    expect(await exists(candidatePath)).toBe(false)
  })
})
