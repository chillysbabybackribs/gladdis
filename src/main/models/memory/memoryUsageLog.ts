/**
 * Memory-usage telemetry — diagnostic-only.
 *
 * Question this log exists to answer: "does the curated memory the dreamer
 * produces ever actually reach the model?". Before adding read-side
 * interventions (auto-recall, prompt nudges, etc.) we need a baseline of how
 * often the model voluntarily touches its working memory today. This module
 * captures one append-only JSONL event per `memory_*` tool dispatch so a
 * report script can produce that baseline without us guessing.
 *
 * Properties on purpose:
 *   • Local-only, per-workspace (`.gladdis/memory-usage.jsonl`).
 *   • Best-effort — writers swallow any error so a misbehaving disk silently
 *     degrades telemetry, never the chat. Writes ARE awaited (appendFile is
 *     sub-ms on SSD; the surrounding tool call is two orders of magnitude
 *     slower) so the log is consistent immediately after the dispatch
 *     returns. That keeps tests and `memory-usage-report` deterministic.
 *   • Privacy-respecting — entry CONTENTS are never logged, only ids,
 *     counts, and timing. Joining to actual text happens at analysis time
 *     and only against memory data the user already owns.
 *   • Easy to remove — every call site goes through `logMemoryUsage()` so
 *     deleting this file (plus the four `void logMemoryUsage(...)` hooks
 *     in `browserTools.ts`) removes the feature cleanly.
 *
 * Not designed for: cross-machine aggregation, high-throughput streaming,
 * or production analytics. If we later want any of those, this becomes the
 * source-of-truth schema and the next layer pulls from it.
 */

import { appendFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'

export const MEMORY_USAGE_FILE = 'memory-usage.jsonl'
const MEMORY_DIR = '.gladdis'

/** The six memory-touching tool dispatches we actually instrument. */
export type MemoryToolName =
  | 'memory_write'
  | 'memory_read'
  | 'memory_list'
  | 'memory_forget'
  | 'memory_create_task'
  | 'recall_history'

export interface MemoryUsageEvent {
  /** Epoch milliseconds — sortable + easy to join with chat timestamps. */
  ts: number
  tool: MemoryToolName
  workspaceRoot: string
  /** Source conversation, when known. Null for sessions outside a chat. */
  conversationId: string | null
  /** Tool-dispatcher tab id; used to distinguish concurrent panels. */
  tabId: string | null
  /** workspace | task | conversation | all — depends on the tool. */
  scope?: string
  taskId?: string | null
  /** Keys requested for memory_read; query for recall_history. */
  keys?: string[]
  query?: string
  /** Whether the dispatch returned ok:true. */
  ok: boolean
  /**
   * Entries returned for read/list, entries deleted for forget, 1 for
   * write/create_task. The interpretation is per-tool — analysis code knows
   * the convention; this just preserves the number.
   */
  resultCount: number
  /** Tool call wallclock. Helps spot accidental loops. */
  durationMs: number
}

/**
 * Fire-and-forget append. Never throws. Callers should `void` the promise.
 *
 * We deliberately do not buffer or batch — the volume is tiny (a few events
 * per conversation at most) and the latency of a single appendFile is
 * negligible compared to a model call.
 */
export async function logMemoryUsage(event: MemoryUsageEvent): Promise<void> {
  try {
    if (!event.workspaceRoot) return
    const dir = join(event.workspaceRoot, MEMORY_DIR)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const line = JSON.stringify(event) + '\n'
    await appendFile(join(dir, MEMORY_USAGE_FILE), line, 'utf8')
  } catch {
    /* telemetry is best-effort by design */
  }
}

/**
 * Load all events from a workspace's log. Skips malformed lines silently so
 * one bad write can't poison the entire dataset for analysis.
 */
export async function loadMemoryUsage(
  workspaceRoot: string
): Promise<MemoryUsageEvent[]> {
  try {
    const raw = await readFile(join(workspaceRoot, MEMORY_DIR, MEMORY_USAGE_FILE), 'utf8')
    const out: MemoryUsageEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as MemoryUsageEvent
        if (isValid(parsed)) out.push(parsed)
      } catch {
        /* drop the bad line, keep the rest */
      }
    }
    return out
  } catch {
    return []
  }
}

function isValid(e: unknown): e is MemoryUsageEvent {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.ts === 'number' &&
    typeof o.tool === 'string' &&
    typeof o.workspaceRoot === 'string' &&
    typeof o.ok === 'boolean' &&
    typeof o.resultCount === 'number'
  )
}

/**
 * Small helper for the hooks in `browserTools.ts`: time a tool call, log
 * its result, and rethrow the underlying outcome. Used so the dispatch
 * sites stay readable.
 */
// ── result-count helpers ────────────────────────────────────────────────────
//
// The dispatch in `browserTools.ts` wraps each tool with
// `instrumentMemoryTool(...)` and supplies a `countFromResult` callback. These
// helpers do the boring text parsing so the call sites stay one-liners.
//
// Conventions:
//   • memory_read:  count of non-metadata keys in the JSON payload (i.e. the
//     entries the model actually got back).
//   • memory_list:  length of the `keys` array, or `tasks` array when the
//     model listed all tasks.
//   • recall_history: 1 if the call returned a real hit, 0 if it returned a
//     stock "no results" message. recall_history doesn't return JSON, so we
//     rely on a short prefix sniff — good enough for a baseline metric.

const READ_METADATA_KEYS = new Set(['updatedAt', 'createdAt', 'label'])

export function memoryReadHitCount(text: string | undefined): number {
  if (!text) return 0
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return 0
    let n = 0
    for (const [k, v] of Object.entries(parsed)) {
      if (READ_METADATA_KEYS.has(k)) continue
      if (v === undefined) continue
      n++
    }
    return n
  } catch {
    return 0
  }
}

export function memoryListHitCount(text: string | undefined): number {
  if (!text) return 0
  try {
    const parsed = JSON.parse(text) as { keys?: unknown; tasks?: unknown }
    if (Array.isArray(parsed.keys)) return parsed.keys.length
    if (Array.isArray(parsed.tasks)) return parsed.tasks.length
    return 0
  } catch {
    return 0
  }
}

export function recallHistoryHitCount(text: string | undefined): number {
  if (!text) return 0
  // Treat stock empty-state responses as 0 hits, everything else as 1.
  // These prefixes come straight from `historyTools.ts`.
  const head = text.slice(0, 120).toLowerCase()
  if (
    head.startsWith('no saved gladdis conversations') ||
    head.startsWith('no saved chats match') ||
    head.startsWith('no earlier conversation history') ||
    head.startsWith('no earlier turns match')
  ) {
    return 0
  }
  return 1
}

export async function instrumentMemoryTool<T extends { ok: boolean }>(
  tool: MemoryToolName,
  ctx: {
    workspaceRoot: string
    conversationId: string | null
    tabId: string | null
    scope?: string
    taskId?: string | null
    keys?: string[]
    query?: string
  },
  exec: () => Promise<T>,
  countFromResult: (result: T) => number
): Promise<T> {
  const t0 = Date.now()
  let result: T
  try {
    result = await exec()
  } catch (err) {
    await logMemoryUsage({
      ts: t0,
      tool,
      workspaceRoot: ctx.workspaceRoot,
      conversationId: ctx.conversationId,
      tabId: ctx.tabId,
      scope: ctx.scope,
      taskId: ctx.taskId ?? undefined,
      keys: ctx.keys,
      query: ctx.query,
      ok: false,
      resultCount: 0,
      durationMs: Date.now() - t0
    })
    throw err
  }
  await logMemoryUsage({
    ts: t0,
    tool,
    workspaceRoot: ctx.workspaceRoot,
    conversationId: ctx.conversationId,
    tabId: ctx.tabId,
    scope: ctx.scope,
    taskId: ctx.taskId ?? undefined,
    keys: ctx.keys,
    query: ctx.query,
    ok: result.ok,
    resultCount: result.ok ? countFromResult(result) : 0,
    durationMs: Date.now() - t0
  })
  return result
}
