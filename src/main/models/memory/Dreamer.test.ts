import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dreamer } from './Dreamer'
import type { ChatStore } from '../ChatStore'
import type {
  Conversation,
  ConversationMeta,
  DreamProgressEvent,
  DreamDiff,
  KeyStatus
} from '../../../../shared/types'
import type { MemoryFileV2 } from './types'
import { MEMORY_FILE_VERSION } from './types'

const KEYED: KeyStatus = {
  anthropic: false,
  google: false,
  codex: true, // pick cheapest → first codex entry
  openai: false,
  grok: false
}

function fakeChatStore(convs: Conversation[]): ChatStore {
  const list = (): ConversationMeta[] =>
    convs.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }))
  const get = (id: string): Conversation | null => convs.find((c) => c.id === id) ?? null
  return { list, get } as unknown as ChatStore
}

/**
 * Canned extract output: a single high-confidence candidate that will be
 * trivially "add"-ed by the deterministic reconciler. Followed by a verify
 * response that "supports" it.
 */
const EXTRACT_RESPONSE = JSON.stringify({
  candidates: [
    {
      kind: 'preference',
      scope: 'workspace',
      text: 'user prefers concise prose',
      evidence: [{ conversationId: 'conv-1', messageIndex: 1, turnExcerpt: 'keep it short please' }],
      tags: ['style'],
      confidence: 0.9
    }
  ]
})

const VERIFY_RESPONSE = JSON.stringify({
  verifications: []
})

const REVIEW_RESPONSE = JSON.stringify({
  overrides: []
})

function fakeComplete(): (modelId: string, system: string, user: string) => Promise<string> {
  return async (_modelId, system) => {
    if (system.includes('fact-checker')) return VERIFY_RESPONSE
    if (system.includes('reviewing a deterministic memory reconciler')) return REVIEW_RESPONSE
    return EXTRACT_RESPONSE
  }
}

describe('Dreamer progress emission', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gladdis-dreamer-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('emits started → all stages → done(ok) in order', async () => {
    const events: DreamProgressEvent[] = []
    const dreamer = new Dreamer({
      chats: fakeChatStore([
        {
          id: 'conv-1',
          title: 'sample',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [
            { role: 'user', text: 'keep it short please' },
            { role: 'assistant', text: 'got it' }
          ]
        }
      ]),
      complete: fakeComplete(),
      getKeyStatus: () => KEYED,
      emitProgress: (e) => events.push(e)
    })

    const result = await dreamer.run({
      workspaceRoot: workspace,
      scope: '7d',
      preferenceOrder: 'cheapest'
    })

    expect(result.ok).toBe(true)

    // First event is always 'started' with a runId.
    expect(events[0].type).toBe('started')
    const runId = (events[0] as { runId: string }).runId
    expect(runId).toMatch(/^drm_/)

    // Last event is 'done' with ok=true.
    const last = events.at(-1)!
    expect(last.type).toBe('done')
    expect((last as { ok: boolean }).ok).toBe(true)

    // All events carry the same runId and workspaceRoot.
    for (const e of events) {
      expect(e.runId).toBe(runId)
      expect(e.workspaceRoot).toBe(workspace)
    }

    // Stages appear in order. We allow each stage to be emitted twice (start
    // marker and the detail-bearing follow-up) but the first-appearance order
    // must be: sampling, extracting, reconciling, verifying, persisting.
    const firstSeen = new Map<string, number>()
    events.forEach((e, i) => {
      if (e.type === 'stage' && !firstSeen.has(e.stage)) {
        firstSeen.set(e.stage, i)
      }
    })
    const order = ['sampling', 'extracting', 'reconciling', 'reviewing', 'verifying', 'persisting']
    for (let i = 0; i < order.length - 1; i++) {
      const a = firstSeen.get(order[i])
      const b = firstSeen.get(order[i + 1])
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      expect(a!).toBeLessThan(b!)
    }
  })

  it('emits done(ok=false) when no conversations match the scope', async () => {
    const events: DreamProgressEvent[] = []
    const dreamer = new Dreamer({
      chats: fakeChatStore([]),
      complete: fakeComplete(),
      getKeyStatus: () => KEYED,
      emitProgress: (e) => events.push(e)
    })

    const result = await dreamer.run({
      workspaceRoot: workspace,
      scope: '7d'
    })
    expect(result.ok).toBe(false)
    const last = events.at(-1)!
    expect(last.type).toBe('done')
    expect((last as { ok: boolean }).ok).toBe(false)
  })

  it('does not throw when emitProgress is undefined', async () => {
    const dreamer = new Dreamer({
      chats: fakeChatStore([
        {
          id: 'conv-1',
          title: 'sample',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [{ role: 'user', text: 'hi' }]
        }
      ]),
      complete: fakeComplete(),
      getKeyStatus: () => KEYED
    })

    const result = await dreamer.run({ workspaceRoot: workspace, scope: '7d' })
    expect(result.ok).toBe(true)
  })

  it('swallows progress sink exceptions', async () => {
    const dreamer = new Dreamer({
      chats: fakeChatStore([
        {
          id: 'conv-1',
          title: 'sample',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [{ role: 'user', text: 'hi' }]
        }
      ]),
      complete: fakeComplete(),
      getKeyStatus: () => KEYED,
      emitProgress: () => {
        throw new Error('renderer is gone')
      }
    })

    const result = await dreamer.run({ workspaceRoot: workspace, scope: '7d' })
    expect(result.ok).toBe(true)
  })

  it('refuses to adopt a candidate when review policy is blocked', async () => {
    const dreamer = new Dreamer({
      chats: fakeChatStore([]),
      complete: fakeComplete(),
      getKeyStatus: () => KEYED
    })

    const dir = join(workspace, '.gladdis')
    await mkdir(dir, { recursive: true })
    const candidate: MemoryFileV2 = {
      version: MEMORY_FILE_VERSION,
      workspace: { root: workspace, updatedAt: new Date().toISOString() },
      entries: [
        {
          id: 'mem_blocked',
          kind: 'preference',
          scope: 'workspace',
          workspaceRoot: workspace,
          text: 'unsupported dream claim',
          evidence: [{ conversationId: 'conv-1' }],
          confidence: 0.9,
          freshness: {
            createdAt: new Date().toISOString(),
            lastReinforcedAt: new Date().toISOString()
          },
          tags: ['dreamed']
        }
      ],
      tasks: {}
    }
    const diff: DreamDiff = {
      id: 'drm_blocked',
      createdAt: Date.now(),
      modelId: 'codex-mini-latest',
      modelProvider: 'codex',
      scope: '7d',
      workspaceRoot: workspace,
      summary: { added: 1, merged: 0, replaced: 0, rejected: 0, unchanged: 0 },
      verifications: [
        { entryId: 'mem_blocked', verdict: 'unsupported', reason: 'evidence does not support it' }
      ],
      entries: [
        {
          action: 'add',
          entryId: 'mem_blocked',
          kind: 'preference',
          scope: 'workspace',
          text: 'unsupported dream claim',
          confidence: 0.9,
          evidenceCount: 1
        }
      ],
      adoption: {
        blocked: true,
        issues: [
          {
            code: 'unsupported-verification',
            entryId: 'mem_blocked',
            message: 'Verifier marked this unsupported: evidence does not support it'
          }
        ]
      },
      awaitingAdopt: true,
      candidateFilePath: join(dir, 'memory.next.json'),
      sampledSessionCount: 1
    }
    await writeFile(join(dir, 'memory.next.json'), JSON.stringify(candidate), 'utf8')
    await writeFile(join(dir, 'memory.next.diff.json'), JSON.stringify(diff), 'utf8')

    const result = await dreamer.adopt(workspace)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Dream adoption is blocked by review policy')
  })
})
