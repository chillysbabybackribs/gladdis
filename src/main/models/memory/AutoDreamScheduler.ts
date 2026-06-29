/**
 * AutoDreamScheduler — Anthropic-calibrated background trigger for the
 * dream pipeline.
 *
 * Defaults match Auto Dream's published behavior: a dual gate of
 * "≥ 24 hours since last consolidation AND ≥ 5 new sessions" plus a
 * 10-minute scan throttle, a per-workspace lock, and an activity cooldown
 * that prevents triggering while a user is actively chatting. Users opt in
 * (the config defaults to `enabled: false`), and manual runs are unaffected
 * — they always work and reset the gates the same as an auto-run.
 *
 * Per-workspace state is split into two pieces:
 *
 *   • Persisted to `.gladdis/dream-auto.json`:
 *         { config, lastDreamAt, lastFailureAt }
 *     Survives restarts so a freshly-opened workspace doesn't
 *     immediately re-trigger a dream that just ran an hour ago.
 *
 *   • In-memory only:
 *         { lastUserMessageAt, lastScanAt, runsTodayDayKey, runsToday,
 *           lastSkipReason }
 *     Reset on restart. The time gate alone is enough to prevent
 *     fire-on-startup.
 *
 * The scheduler depends on a small surface (Dreamer, ChatStore, a clock
 * function for tests) and stays unaware of IPC details — the main process
 * wires `nudge()` to chat activity and `notify` to renderer push events.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChatStore } from '../ChatStore'
import { DEFAULT_DREAM_AUTO_CONFIG } from '../../../../shared/dream'
import type {
  DreamAutoConfig,
  DreamAutoNotification,
  DreamAutoStatus,
  DreamScope
} from '../../../../shared/dream'
import type { Dreamer } from './Dreamer'

const AUTO_FILE = 'dream-auto.json'
const MEMORY_DIR = '.gladdis'
const SCAN_THROTTLE_MS = 10 * 60 * 1000 // 10 minutes — matches Anthropic's documented throttle
const TICK_INTERVAL_MS = 60 * 1000 // every minute we re-evaluate; cheap
const AUTO_SCOPE: DreamScope = '24h' // auto-runs always look at the most recent day

export interface AutoDreamSchedulerDeps {
  dreamer: Dreamer
  chats: ChatStore
  /** Resolves the workspace this process is bound to (or null if none open). */
  getWorkspaceRoot: () => string | null
  /** Sink for the renderer notification event. */
  notify: (event: DreamAutoNotification) => void
  /** Injectable for tests. */
  now?: () => number
}

interface PersistedState {
  version: 1
  config: DreamAutoConfig
  lastDreamAt?: number
  lastFailureAt?: number
}

interface InMemoryState {
  lastUserMessageAt: number
  lastScanAt: number
  runsToday: number
  runsTodayDayKey: string
  lastSkipReason?: string
}

export class AutoDreamScheduler {
  private readonly deps: AutoDreamSchedulerDeps
  private readonly persisted = new Map<string, PersistedState>()
  private readonly memory = new Map<string, InMemoryState>()
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number

  constructor(deps: AutoDreamSchedulerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /** Begin watching the given workspace (no-op if already watching). */
  async start(workspaceRoot: string): Promise<void> {
    if (!workspaceRoot) return
    if (this.persisted.has(workspaceRoot)) return
    const loaded = await loadPersisted(workspaceRoot)
    this.persisted.set(workspaceRoot, loaded)
    this.memory.set(workspaceRoot, freshInMemory(this.now()))
    this.ensureTicking()
  }

  /** Stop watching the given workspace. Used when the workspace changes. */
  stop(workspaceRoot: string): void {
    this.persisted.delete(workspaceRoot)
    this.memory.delete(workspaceRoot)
    if (this.persisted.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Stop all watchers and timers; used on app shutdown. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.persisted.clear()
    this.memory.clear()
  }

  /**
   * Signals user activity (a message sent). Resets the activity cooldown
   * so a dream won't fire mid-conversation, and updates the in-memory
   * state without touching disk.
   */
  nudge(workspaceRoot: string): void {
    const mem = this.memory.get(workspaceRoot)
    if (!mem) return
    mem.lastUserMessageAt = this.now()
  }

  getConfig(workspaceRoot: string): DreamAutoConfig {
    const p = this.persisted.get(workspaceRoot)
    return p?.config ?? { ...DEFAULT_DREAM_AUTO_CONFIG }
  }

  async setConfig(
    workspaceRoot: string,
    patch: Partial<DreamAutoConfig>
  ): Promise<DreamAutoConfig> {
    // start() is a precondition; if main-process forgot to call it, treat
    // the first setConfig as the start and proceed.
    if (!this.persisted.has(workspaceRoot)) {
      await this.start(workspaceRoot)
    }
    const current = this.persisted.get(workspaceRoot)!
    const merged: DreamAutoConfig = sanitizeConfig({ ...current.config, ...patch })
    current.config = merged
    await persist(workspaceRoot, current).catch((err) =>
      console.warn('[auto-dream] failed to persist config:', err)
    )
    return merged
  }

  /** Notify the scheduler that a MANUAL dream just completed successfully. */
  recordManualRun(workspaceRoot: string): void {
    const p = this.persisted.get(workspaceRoot)
    if (!p) return
    p.lastDreamAt = this.now()
    void persist(workspaceRoot, p)
  }

  status(workspaceRoot: string): DreamAutoStatus {
    const p = this.persisted.get(workspaceRoot)
    const config = p?.config ?? { ...DEFAULT_DREAM_AUTO_CONFIG }
    const mem = this.memory.get(workspaceRoot)
    return {
      enabled: config.enabled,
      config,
      lastDreamAt: p?.lastDreamAt,
      lastFailureAt: p?.lastFailureAt,
      runsToday: mem?.runsToday ?? 0,
      sessionsSinceLastDream: this.countSessionsSinceLastDream(p),
      nextEligibleAt: this.computeNextEligibleAt(p, mem, config),
      lastSkipReason: mem?.lastSkipReason
    }
  }

  /**
   * Evaluate gates and trigger a dream if eligible. Returns a discriminated
   * result instead of throwing so the periodic scanner can log skip reasons
   * without bubbling.
   */
  async tryRun(
    workspaceRoot: string
  ): Promise<
    | { triggered: false; reason: string }
    | { triggered: true; ok: boolean; autoAdopted: boolean; awaitingReview: boolean }
  > {
    const p = this.persisted.get(workspaceRoot)
    const mem = this.memory.get(workspaceRoot)
    if (!p || !mem) return this.skip(workspaceRoot, mem, 'not watching this workspace')
    const { config } = p
    if (!config.enabled) return this.skip(workspaceRoot, mem, 'auto-dream disabled')

    this.rolloverDailyCounter(mem)
    if (mem.runsToday >= config.dailyRunCap) {
      return this.skip(workspaceRoot, mem, `daily cap of ${config.dailyRunCap} reached`)
    }

    const now = this.now()
    if (p.lastDreamAt) {
      const elapsedHours = (now - p.lastDreamAt) / 3_600_000
      if (elapsedHours < config.minHours) {
        return this.skip(
          workspaceRoot,
          mem,
          `time gate (${elapsedHours.toFixed(1)}h < ${config.minHours}h)`
        )
      }
    }

    const sessions = this.countSessionsSinceLastDream(p)
    if (sessions < config.minSessions) {
      return this.skip(
        workspaceRoot,
        mem,
        `session gate (${sessions} < ${config.minSessions})`
      )
    }

    const sinceUserMs = now - mem.lastUserMessageAt
    if (sinceUserMs < config.activityCooldownSeconds * 1000) {
      return this.skip(
        workspaceRoot,
        mem,
        `activity cooldown (${(sinceUserMs / 1000).toFixed(0)}s < ${config.activityCooldownSeconds}s)`
      )
    }

    // Lock-equivalent: ask the dreamer; if a dream's already in flight it
    // returns ok=false and we'll back off until the next tick.
    mem.runsToday += 1
    mem.lastSkipReason = undefined
    const result = await this.deps.dreamer.runAuto(
      {
        workspaceRoot,
        scope: AUTO_SCOPE,
        preferenceOrder: config.preferenceOrder
      },
      config.autoAdopt
    )

    const ok = result.ok
    const autoAdopted = ok ? result.autoAdopted === true : false
    const awaitingReview = ok && !autoAdopted

    if (ok) {
      p.lastDreamAt = now
      delete p.lastFailureAt
    } else {
      p.lastFailureAt = now
    }
    await persist(workspaceRoot, p).catch((err) =>
      console.warn('[auto-dream] failed to persist after run:', err)
    )

    const message = buildNotificationMessage(result, autoAdopted, awaitingReview)
    this.deps.notify({
      runId: ok ? result.diff.id : `drm_auto_${now.toString(36)}`,
      workspaceRoot,
      completedAt: now,
      ok,
      autoAdopted,
      awaitingReview,
      message,
      ...(ok ? {} : { error: result.error })
    })

    return { triggered: true, ok, autoAdopted, awaitingReview }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private ensureTicking(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // Fire-and-forget — promise rejection logs but never bubbles.
      this.tickAll().catch((err) =>
        console.warn('[auto-dream] tick failed:', err)
      )
    }, TICK_INTERVAL_MS)
    // Don't keep the event loop alive purely for this timer (relevant in
    // tests and during graceful shutdown).
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private async tickAll(): Promise<void> {
    const now = this.now()
    for (const [workspaceRoot, mem] of this.memory) {
      if (now - mem.lastScanAt < SCAN_THROTTLE_MS) continue
      mem.lastScanAt = now
      await this.tryRun(workspaceRoot).catch(() => {})
    }
  }

  private rolloverDailyCounter(mem: InMemoryState): void {
    const today = utcDayKey(this.now())
    if (mem.runsTodayDayKey !== today) {
      mem.runsTodayDayKey = today
      mem.runsToday = 0
    }
  }

  private countSessionsSinceLastDream(p: PersistedState | undefined): number {
    if (!p) return 0
    const since = p.lastDreamAt ?? 0
    let n = 0
    try {
      for (const meta of this.deps.chats.list()) {
        if (meta.updatedAt > since) n += 1
      }
    } catch {
      /* defensive: if chat store is unavailable, count as zero */
    }
    return n
  }

  private computeNextEligibleAt(
    p: PersistedState | undefined,
    mem: InMemoryState | undefined,
    config: DreamAutoConfig
  ): number | undefined {
    if (!p || !mem || !config.enabled) return undefined
    const candidates: number[] = []
    if (p.lastDreamAt) {
      candidates.push(p.lastDreamAt + config.minHours * 3_600_000)
    } else {
      candidates.push(this.now())
    }
    candidates.push(mem.lastUserMessageAt + config.activityCooldownSeconds * 1000)
    return Math.max(...candidates)
  }

  private skip(
    workspaceRoot: string,
    mem: InMemoryState | undefined,
    reason: string
  ): { triggered: false; reason: string } {
    if (mem) mem.lastSkipReason = reason
    return { triggered: false, reason }
  }
}

// ── module-level helpers ────────────────────────────────────────────────

function freshInMemory(now: number): InMemoryState {
  return {
    lastUserMessageAt: now,
    lastScanAt: 0,
    runsToday: 0,
    runsTodayDayKey: utcDayKey(now)
  }
}

function utcDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d
    .getUTCDate()
    .toString()
    .padStart(2, '0')}`
}

function sanitizeConfig(input: DreamAutoConfig): DreamAutoConfig {
  const base = { ...DEFAULT_DREAM_AUTO_CONFIG, ...input }
  // Use `coerce()` rather than `Number(x) || default` so legitimate zero
  // values for cooldown/cap survive sanitization.
  return {
    enabled: !!base.enabled,
    minHours: clamp(coerce(base.minHours, DEFAULT_DREAM_AUTO_CONFIG.minHours), 1, 24 * 7),
    minSessions: clamp(
      Math.round(coerce(base.minSessions, DEFAULT_DREAM_AUTO_CONFIG.minSessions)),
      1,
      100
    ),
    activityCooldownSeconds: clamp(
      Math.round(
        coerce(base.activityCooldownSeconds, DEFAULT_DREAM_AUTO_CONFIG.activityCooldownSeconds)
      ),
      0,
      60 * 60
    ),
    dailyRunCap: clamp(
      Math.round(coerce(base.dailyRunCap, DEFAULT_DREAM_AUTO_CONFIG.dailyRunCap)),
      1,
      50
    ),
    preferenceOrder: base.preferenceOrder === 'best' ? 'best' : 'cheapest',
    autoAdopt:
      base.autoAdopt === 'permissive' || base.autoAdopt === 'off' ? base.autoAdopt : 'strict'
  }
}

function coerce(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

async function loadPersisted(workspaceRoot: string): Promise<PersistedState> {
  const path = join(workspaceRoot, MEMORY_DIR, AUTO_FILE)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedState
    if (parsed && parsed.version === 1 && parsed.config) {
      parsed.config = sanitizeConfig(parsed.config)
      return parsed
    }
  } catch {
    /* missing or unreadable → fall through to defaults */
  }
  return { version: 1, config: { ...DEFAULT_DREAM_AUTO_CONFIG } }
}

async function persist(workspaceRoot: string, state: PersistedState): Promise<void> {
  const dir = join(workspaceRoot, MEMORY_DIR)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const path = join(dir, AUTO_FILE)
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8')
}

function buildNotificationMessage(
  result:
    | { ok: true; diff: { summary: DreamSummaryShape } }
    | { ok: false; error: string },
  autoAdopted: boolean,
  awaitingReview: boolean
): string {
  if (!result.ok) return `Auto-dream failed: ${result.error}`
  const s = result.diff.summary
  const parts: string[] = []
  if (s.added) parts.push(`${s.added} added`)
  if (s.merged) parts.push(`${s.merged} merged`)
  if (s.archived) parts.push(`${s.archived} archived`)
  if (s.demoted) parts.push(`${s.demoted} demoted`)
  if (s.reinforced) parts.push(`${s.reinforced} reinforced`)
  const headline = parts.length === 0 ? 'no changes' : parts.join(', ')
  if (autoAdopted) return `Memory auto-updated: ${headline}`
  if (awaitingReview) return `Dream complete — ${headline} awaiting review`
  return `Auto-dream: ${headline}`
}

// Subset of DreamDiffSummary we actually read in the notification headline.
// Hygiene counts are optional (Phase 4 additions to the summary), so we
// model them that way locally rather than re-typing the full shape.
interface DreamSummaryShape {
  added?: number
  merged?: number
  archived?: number
  demoted?: number
  reinforced?: number
}

export const __test = {
  AUTO_FILE,
  MEMORY_DIR,
  SCAN_THROTTLE_MS,
  TICK_INTERVAL_MS,
  AUTO_SCOPE,
  sanitizeConfig,
  utcDayKey
}
