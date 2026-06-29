import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoDreamScheduler, __test } from './AutoDreamScheduler'
import type { ChatStore } from '../ChatStore'
import type { Dreamer } from './Dreamer'
import type {
  Conversation,
  ConversationMeta,
  DreamAutoNotification,
  DreamDiff,
  DreamRunRequest,
  DreamRunResult
} from '../../../../shared/types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Lightweight fake ChatStore: only `.list()` matters for the scheduler;
 * everything else is unused in these tests.
 */
function fakeChats(metas: ConversationMeta[]): ChatStore {
  return {
    list: () => metas,
    get: () => null as Conversation | null
  } as unknown as ChatStore
}

/**
 * Fake Dreamer that records calls and returns canned results. Lets us assert
 * the scheduler invoked `runAuto` (or not) and with which policy.
 */
function fakeDreamer(opts: {
  result: () => DreamRunResult & { autoAdopted?: boolean }
} = { result: () => okResult() }): Dreamer & {
  calls: Array<{ req: DreamRunRequest; policy: string }>
} {
  const calls: Array<{ req: DreamRunRequest; policy: string }> = []
  const dreamer = {
    runAuto: async (req: DreamRunRequest, policy: string) => {
      calls.push({ req, policy })
      return opts.result()
    }
  } as unknown as Dreamer & { calls: typeof calls }
  dreamer.calls = calls
  return dreamer
}

function okResult(extra: Partial<DreamDiff> = {}): DreamRunResult & { autoAdopted?: boolean } {
  const diff: DreamDiff = {
    id: 'drm_test',
    createdAt: Date.now(),
    modelId: 'codex-mini-latest',
    modelProvider: 'codex',
    scope: '24h',
    workspaceRoot: '/tmp/ws',
    summary: { added: 1, merged: 0, replaced: 0, rejected: 0, unchanged: 0 },
    verifications: [],
    entries: [],
    adoption: { blocked: false, issues: [] },
    awaitingAdopt: true,
    candidateFilePath: '/tmp/ws/.gladdis/memory.next.json',
    sampledSessionCount: 5,
    ...extra
  }
  return { ok: true, diff, autoAdopted: true }
}

describe('AutoDreamScheduler', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gladdis-auto-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('starts opt-in: disabled by default does nothing', async () => {
    const dreamer = fakeDreamer()
    const notifications: DreamAutoNotification[] = []
    const sched = new AutoDreamScheduler({
      dreamer,
      chats: fakeChats(makeManySessions(10)),
      getWorkspaceRoot: () => workspace,
      notify: (n) => notifications.push(n),
      now: () => Date.now() + 100 * DAY_MS
    })
    await sched.start(workspace)
    const res = await sched.tryRun(workspace)
    expect(res.triggered).toBe(false)
    expect('reason' in res ? res.reason : '').toMatch(/disabled/i)
    expect(dreamer.calls).toHaveLength(0)
    sched.dispose()
  })

  it('triggers when both gates clear and activity is quiet', async () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0)
    const dreamer = fakeDreamer()
    const sched = new AutoDreamScheduler({
      dreamer,
      chats: fakeChats(makeManySessions(10, now - 6 * HOUR_MS)),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => now
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, { enabled: true, activityCooldownSeconds: 0 })
    // Push lastUserMessageAt back so the activity gate clears.
    // The scheduler sets lastUserMessageAt to now() on first start; we
    // override here by configuring activityCooldownSeconds: 0.
    const res = await sched.tryRun(workspace)
    expect(res.triggered).toBe(true)
    expect(dreamer.calls).toHaveLength(1)
    expect(dreamer.calls[0].policy).toBe('strict')
    sched.dispose()
  })

  it('blocks on the session gate (< minSessions)', async () => {
    const now = Date.now()
    const dreamer = fakeDreamer()
    const sched = new AutoDreamScheduler({
      dreamer,
      chats: fakeChats(makeManySessions(2, now - 12 * HOUR_MS)),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => now
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, { enabled: true, activityCooldownSeconds: 0 })
    const res = await sched.tryRun(workspace)
    expect(res.triggered).toBe(false)
    expect('reason' in res ? res.reason : '').toMatch(/session gate/)
    sched.dispose()
  })

  it('blocks on the time gate (< minHours)', async () => {
    const now = Date.now()
    const dreamer = fakeDreamer()
    const sched = new AutoDreamScheduler({
      dreamer,
      chats: fakeChats(makeManySessions(20, now - 30 * 60 * 1000)),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => now
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, { enabled: true, activityCooldownSeconds: 0 })
    // Simulate a prior dream that ran 10 hours ago (< default 24h).
    sched.recordManualRun(workspace)
    const cfg = sched.getConfig(workspace)
    expect(cfg.minHours).toBeGreaterThanOrEqual(1)
    const res = await sched.tryRun(workspace)
    expect(res.triggered).toBe(false)
    expect('reason' in res ? res.reason : '').toMatch(/time gate/i)
    sched.dispose()
  })

  it('blocks while activity cooldown is active (nudge resets the timer)', async () => {
    const now = Date.now()
    const dreamer = fakeDreamer()
    const sched = new AutoDreamScheduler({
      dreamer,
      chats: fakeChats(makeManySessions(20, now - 48 * HOUR_MS)),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => now
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, { enabled: true, activityCooldownSeconds: 60 })
    sched.nudge(workspace) // user just sent a message
    const res = await sched.tryRun(workspace)
    expect(res.triggered).toBe(false)
    expect('reason' in res ? res.reason : '').toMatch(/activity cooldown/)
    sched.dispose()
  })

  it('enforces the daily run cap', async () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0)
    let clock = now
    // Chats list rebuilt per call so each tryRun sees "fresh" sessions
    // (updatedAt advances with the clock) — keeps the session gate satisfied
    // across multiple runs and isolates the daily-cap assertion.
    const dynamicChats: ChatStore = {
      list: () =>
        Array.from({ length: 20 }, (_, i) => ({
          id: `c${i}`,
          title: `Conversation ${i}`,
          createdAt: clock - i * 1000,
          updatedAt: clock - i
        })),
      get: () => null
    } as unknown as ChatStore
    const dreamer = fakeDreamer()
    const sched = new AutoDreamScheduler({
      dreamer,
      chats: dynamicChats,
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => clock
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, {
      enabled: true,
      activityCooldownSeconds: 0,
      dailyRunCap: 2,
      minHours: 1,
      minSessions: 1
    })

    const r1 = await sched.tryRun(workspace)
    expect(r1.triggered).toBe(true)
    clock += 90 * 60 * 1000 // > 1h but same UTC day
    const r2 = await sched.tryRun(workspace)
    expect(r2.triggered).toBe(true)
    clock += 90 * 60 * 1000
    const r3 = await sched.tryRun(workspace)
    expect(r3.triggered).toBe(false)
    expect('reason' in r3 ? r3.reason : '').toMatch(/daily cap/i)
    sched.dispose()
  })

  it('emits a notification after each auto-run', async () => {
    const now = Date.now()
    const notes: DreamAutoNotification[] = []
    const sched = new AutoDreamScheduler({
      dreamer: fakeDreamer(),
      chats: fakeChats(makeManySessions(20, now - 48 * HOUR_MS)),
      getWorkspaceRoot: () => workspace,
      notify: (n) => notes.push(n),
      now: () => now
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, { enabled: true, activityCooldownSeconds: 0 })
    await sched.tryRun(workspace)
    expect(notes).toHaveLength(1)
    expect(notes[0].ok).toBe(true)
    expect(notes[0].workspaceRoot).toBe(workspace)
    expect(notes[0].message).toMatch(/auto-updated|awaiting review|auto-dream/i)
    sched.dispose()
  })

  it('persists config between scheduler instances', async () => {
    const a = new AutoDreamScheduler({
      dreamer: fakeDreamer(),
      chats: fakeChats([]),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => Date.now()
    })
    await a.start(workspace)
    await a.setConfig(workspace, { enabled: true, minHours: 12, minSessions: 3 })
    a.dispose()

    const b = new AutoDreamScheduler({
      dreamer: fakeDreamer(),
      chats: fakeChats([]),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => Date.now()
    })
    await b.start(workspace)
    const cfg = b.getConfig(workspace)
    expect(cfg.enabled).toBe(true)
    expect(cfg.minHours).toBe(12)
    expect(cfg.minSessions).toBe(3)
    b.dispose()
  })

  it('sanitizes out-of-range config values', () => {
    const s = __test.sanitizeConfig({
      enabled: true,
      minHours: 9999,
      minSessions: -5,
      activityCooldownSeconds: 1_000_000,
      dailyRunCap: 0,
      preferenceOrder: 'cheapest',
      autoAdopt: 'strict'
    } as never)
    expect(s.minHours).toBeLessThanOrEqual(24 * 7)
    expect(s.minSessions).toBeGreaterThanOrEqual(1)
    expect(s.activityCooldownSeconds).toBeLessThanOrEqual(3600)
    expect(s.dailyRunCap).toBeGreaterThanOrEqual(1)
  })

  it('records manual runs into the time gate', async () => {
    const now = Date.now()
    const sched = new AutoDreamScheduler({
      dreamer: fakeDreamer(),
      chats: fakeChats([]),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => now
    })
    await sched.start(workspace)
    sched.recordManualRun(workspace)
    const st = sched.status(workspace)
    expect(st.lastDreamAt).toBe(now)
    sched.dispose()
  })

  it('produces a sensible status snapshot', async () => {
    const now = Date.now()
    const sched = new AutoDreamScheduler({
      dreamer: fakeDreamer(),
      chats: fakeChats(makeManySessions(7, now - 30 * HOUR_MS)),
      getWorkspaceRoot: () => workspace,
      notify: () => {},
      now: () => now
    })
    await sched.start(workspace)
    await sched.setConfig(workspace, { enabled: true })
    const st = sched.status(workspace)
    expect(st.enabled).toBe(true)
    expect(st.sessionsSinceLastDream).toBe(7)
    expect(st.runsToday).toBe(0)
    sched.dispose()
  })
})

function makeManySessions(n: number, sinceMs: number = Date.now() - 12 * HOUR_MS): ConversationMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title: `Conversation ${i}`,
    createdAt: sinceMs - i * 1000,
    updatedAt: sinceMs + i * 1000
  }))
}
