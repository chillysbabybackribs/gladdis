import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MEMORY_USAGE_FILE,
  instrumentMemoryTool,
  loadMemoryUsage,
  logMemoryUsage,
  memoryListHitCount,
  memoryReadHitCount,
  recallHistoryHitCount,
  type MemoryUsageEvent
} from './memoryUsageLog'

describe('memoryUsageLog — persistence', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gladdis-memlog-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('returns [] when no log file exists yet', async () => {
    const events = await loadMemoryUsage(workspace)
    expect(events).toEqual([])
  })

  it('persists events in append order and parses them back', async () => {
    const a: MemoryUsageEvent = makeEvent({ ts: 1, tool: 'memory_write', resultCount: 1 }, workspace)
    const b: MemoryUsageEvent = makeEvent({ ts: 2, tool: 'memory_read', resultCount: 3 }, workspace)
    await logMemoryUsage(a)
    await logMemoryUsage(b)

    const loaded = await loadMemoryUsage(workspace)
    expect(loaded).toHaveLength(2)
    expect(loaded[0].tool).toBe('memory_write')
    expect(loaded[1].tool).toBe('memory_read')
    expect(loaded[1].resultCount).toBe(3)
  })

  it('skips malformed and invalid lines, keeping the good ones', async () => {
    const dir = join(workspace, '.gladdis')
    await mkdir(dir, { recursive: true })
    const good = JSON.stringify(makeEvent({ ts: 5, tool: 'memory_list', resultCount: 2 }, workspace))
    const fileContents = [
      good,
      '{not-json',
      JSON.stringify({ ts: 'not-a-number', tool: 'memory_read' }),
      good,
      ''
    ].join('\n')
    await writeFile(join(dir, MEMORY_USAGE_FILE), fileContents, 'utf8')

    const loaded = await loadMemoryUsage(workspace)
    expect(loaded).toHaveLength(2)
    expect(loaded.every((e) => e.tool === 'memory_list')).toBe(true)
  })

  it('logMemoryUsage never throws on missing workspace path', async () => {
    // No mkdir attempt, just call with a clearly bogus path. We don't actually
    // expect it to write anywhere; we expect the call to resolve without
    // throwing so telemetry never blocks a tool call.
    await expect(
      logMemoryUsage({
        ts: Date.now(),
        tool: 'memory_read',
        workspaceRoot: '',
        conversationId: null,
        tabId: null,
        ok: true,
        resultCount: 0,
        durationMs: 0
      })
    ).resolves.toBeUndefined()
  })
})

describe('memoryUsageLog — count helpers', () => {
  it('memoryReadHitCount counts only non-metadata keys', () => {
    const payload = JSON.stringify({
      updatedAt: '2026-06-29T20:00:00Z',
      label: 'My task',
      createdAt: '2026-06-29T19:00:00Z',
      typescript_pref: 'strict',
      indent: 2
    })
    expect(memoryReadHitCount(payload)).toBe(2)
  })

  it('memoryReadHitCount skips undefined values', () => {
    const payload = JSON.stringify({ updatedAt: 'x', foo: undefined })
    expect(memoryReadHitCount(payload)).toBe(0)
  })

  it('memoryReadHitCount returns 0 for malformed JSON', () => {
    expect(memoryReadHitCount('not-json')).toBe(0)
    expect(memoryReadHitCount('')).toBe(0)
    expect(memoryReadHitCount(undefined)).toBe(0)
  })

  it('memoryListHitCount reads keys array', () => {
    expect(memoryListHitCount(JSON.stringify({ keys: ['a', 'b', 'c'], updatedAt: 'x' }))).toBe(3)
  })

  it('memoryListHitCount reads tasks array', () => {
    expect(memoryListHitCount(JSON.stringify({ tasks: [{ id: 't1' }, { id: 't2' }] }))).toBe(2)
  })

  it('memoryListHitCount returns 0 when neither array present', () => {
    expect(memoryListHitCount(JSON.stringify({ updatedAt: 'x' }))).toBe(0)
    expect(memoryListHitCount('garbage')).toBe(0)
  })

  it('recallHistoryHitCount detects empty-state responses', () => {
    expect(recallHistoryHitCount('No saved Gladdis conversations are stored yet.')).toBe(0)
    expect(recallHistoryHitCount('No saved chats match "foo".')).toBe(0)
    expect(recallHistoryHitCount('No earlier turns match "foo".')).toBe(0)
    expect(recallHistoryHitCount('No earlier conversation history is stored yet.')).toBe(0)
  })

  it('recallHistoryHitCount returns 1 for real hits', () => {
    expect(recallHistoryHitCount('3 matching turn(s):\n\n…')).toBe(1)
    expect(recallHistoryHitCount('Conversation excerpt about Phase 5…')).toBe(1)
  })

  it('recallHistoryHitCount handles empty input gracefully', () => {
    expect(recallHistoryHitCount('')).toBe(0)
    expect(recallHistoryHitCount(undefined)).toBe(0)
  })
})

describe('memoryUsageLog — instrumentMemoryTool', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gladdis-memlog-instr-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('logs a successful call and forwards the result', async () => {
    const result = await instrumentMemoryTool(
      'memory_read',
      { workspaceRoot: workspace, conversationId: 'c1', tabId: 'tab', scope: 'workspace', keys: ['k'] },
      async () => ({ ok: true, text: JSON.stringify({ updatedAt: 'x', k: 1 }) }),
      (out) => memoryReadHitCount(out.text)
    )
    expect(result.ok).toBe(true)

    const events = await loadMemoryUsage(workspace)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      tool: 'memory_read',
      conversationId: 'c1',
      ok: true,
      resultCount: 1
    })
  })

  it('logs a failed call with resultCount=0 and rethrows the error', async () => {
    const boom = new Error('store offline')
    await expect(
      instrumentMemoryTool(
        'memory_write',
        { workspaceRoot: workspace, conversationId: null, tabId: null, scope: 'workspace' },
        async () => {
          throw boom
        },
        () => 1
      )
    ).rejects.toThrow('store offline')

    const events = await loadMemoryUsage(workspace)
    expect(events).toHaveLength(1)
    expect(events[0].ok).toBe(false)
    expect(events[0].resultCount).toBe(0)
  })

  it('logs ok:false with resultCount=0 when tool returns ok:false', async () => {
    await instrumentMemoryTool(
      'memory_list',
      { workspaceRoot: workspace, conversationId: 'c2', tabId: null, scope: 'workspace' },
      async () => ({ ok: false, text: 'memory_list requires scope' }),
      () => 99
    )
    const events = await loadMemoryUsage(workspace)
    expect(events).toHaveLength(1)
    expect(events[0].ok).toBe(false)
    expect(events[0].resultCount).toBe(0)
  })
})

function makeEvent(
  partial: Partial<MemoryUsageEvent> & Pick<MemoryUsageEvent, 'tool'>,
  workspaceRoot: string
): MemoryUsageEvent {
  const base: MemoryUsageEvent = {
    ts: 1,
    tool: partial.tool,
    workspaceRoot,
    conversationId: null,
    tabId: null,
    ok: true,
    resultCount: 0,
    durationMs: 0
  }
  return { ...base, ...partial }
}
