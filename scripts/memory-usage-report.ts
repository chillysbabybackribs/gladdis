/**
 * Memory-usage report — Step 0 of the read-side memory work.
 *
 * Reads `<workspace>/.gladdis/memory-usage.jsonl` and prints a baseline
 * report answering one question: "does the curated memory the dreamer
 * produces actually reach the model in conversation?".
 *
 * Usage:
 *   npx tsx scripts/memory-usage-report.ts                 # uses cwd
 *   npx tsx scripts/memory-usage-report.ts --workspace=/path/to/proj
 *   npx tsx scripts/memory-usage-report.ts --json          # machine-readable
 *
 * Output sections:
 *   • Total events + date range + distinct conversations touched.
 *   • Per-tool counts (memory_read, memory_write, memory_list, …).
 *   • Hit-rate per tool — what fraction of calls actually returned data.
 *   • Utilisation — memory entries in store vs. read calls per conversation.
 *   • Top conversations by memory activity (so we can sanity-check the data).
 *
 * The script is read-only and side-effect free. Run it whenever you want
 * a snapshot of how the current build is using memory in the wild.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { loadMemoryUsage, type MemoryUsageEvent, type MemoryToolName } from '../src/main/models/memory/memoryUsageLog'

const ALL_TOOLS: MemoryToolName[] = [
  'memory_read',
  'memory_list',
  'memory_write',
  'memory_forget',
  'memory_create_task',
  'recall_history'
]

const READ_TOOLS = new Set<MemoryToolName>(['memory_read', 'memory_list', 'recall_history'])

interface PerToolStats {
  tool: MemoryToolName
  calls: number
  ok: number
  nonEmpty: number
  totalResults: number
  avgDurationMs: number
}

interface PerConversationStats {
  conversationId: string
  totalCalls: number
  reads: number
  writes: number
  firstTs: number
  lastTs: number
}

interface ReportShape {
  workspace: string
  totalEvents: number
  firstEventAt: string | null
  lastEventAt: string | null
  distinctConversations: number
  conversationsWithReads: number
  memoryEntriesInStore: number | null
  perTool: PerToolStats[]
  perConversationTop: PerConversationStats[]
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2))
  const workspaceArg = Array.from(argv).find((a) => a.startsWith('--workspace='))?.split('=')[1]
  const jsonOut = argv.has('--json')
  const workspace = workspaceArg || process.cwd()

  const events = await loadMemoryUsage(workspace)
  const memoryEntriesInStore = await readEntryCount(workspace)

  const report = buildReport(workspace, events, memoryEntriesInStore)

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  printHuman(report)
}

function buildReport(
  workspace: string,
  events: MemoryUsageEvent[],
  memoryEntriesInStore: number | null
): ReportShape {
  const perTool: Record<MemoryToolName, PerToolStats> = Object.fromEntries(
    ALL_TOOLS.map((t) => [t, { tool: t, calls: 0, ok: 0, nonEmpty: 0, totalResults: 0, avgDurationMs: 0 } as PerToolStats])
  ) as Record<MemoryToolName, PerToolStats>

  const conversations = new Map<string, PerConversationStats>()
  const conversationsWithReadsSet = new Set<string>()
  let first = Number.POSITIVE_INFINITY
  let last = 0
  const durationBuckets: Record<MemoryToolName, number[]> = Object.fromEntries(
    ALL_TOOLS.map((t) => [t, []])
  ) as Record<MemoryToolName, number[]>

  for (const e of events) {
    const tool = e.tool
    const bucket = perTool[tool]
    if (!bucket) continue
    bucket.calls++
    if (e.ok) bucket.ok++
    if (e.resultCount > 0) bucket.nonEmpty++
    bucket.totalResults += e.resultCount
    durationBuckets[tool].push(e.durationMs)
    if (e.ts < first) first = e.ts
    if (e.ts > last) last = e.ts

    const cid = e.conversationId ?? '(no-conversation)'
    let conv = conversations.get(cid)
    if (!conv) {
      conv = {
        conversationId: cid,
        totalCalls: 0,
        reads: 0,
        writes: 0,
        firstTs: e.ts,
        lastTs: e.ts
      }
      conversations.set(cid, conv)
    }
    conv.totalCalls++
    if (READ_TOOLS.has(tool)) {
      conv.reads++
      conversationsWithReadsSet.add(cid)
    }
    if (tool === 'memory_write') conv.writes++
    if (e.ts < conv.firstTs) conv.firstTs = e.ts
    if (e.ts > conv.lastTs) conv.lastTs = e.ts
  }

  for (const t of ALL_TOOLS) {
    const durs = durationBuckets[t]
    perTool[t].avgDurationMs = durs.length
      ? Math.round((durs.reduce((a, b) => a + b, 0) / durs.length) * 10) / 10
      : 0
  }

  const perConversationTop = Array.from(conversations.values())
    .sort((a, b) => b.totalCalls - a.totalCalls)
    .slice(0, 10)

  return {
    workspace,
    totalEvents: events.length,
    firstEventAt: events.length ? new Date(first).toISOString() : null,
    lastEventAt: events.length ? new Date(last).toISOString() : null,
    distinctConversations: conversations.size,
    conversationsWithReads: conversationsWithReadsSet.size,
    memoryEntriesInStore,
    perTool: ALL_TOOLS.map((t) => perTool[t])
  ,
    perConversationTop
  }
}

async function readEntryCount(workspace: string): Promise<number | null> {
  try {
    const raw = await readFile(join(workspace, '.gladdis', 'memory.json'), 'utf8')
    const parsed = JSON.parse(raw) as { entries?: unknown[] }
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed.entries.length
  } catch {
    return null
  }
}

function printHuman(r: ReportShape): void {
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log('Memory usage report')
  console.log('-------------------')
  console.log(`Workspace             : ${r.workspace}`)
  console.log(`Total events          : ${r.totalEvents}`)
  console.log(`Time range            : ${r.firstEventAt ?? '(none)'}  →  ${r.lastEventAt ?? '(none)'}`)
  console.log(`Distinct conversations: ${r.distinctConversations}`)
  console.log(`  with any read       : ${r.conversationsWithReads}`)
  console.log(`Memory entries in store: ${r.memoryEntriesInStore ?? '(unknown)'}`)
  console.log('')
  console.log('Per-tool')
  console.log(`  ${pad('tool', 22)} ${pad('calls', 8)} ${pad('ok', 8)} ${pad('non-empty', 12)} ${pad('avg result', 12)} ${pad('avg ms', 8)}`)
  for (const t of r.perTool) {
    const avgResult = t.calls ? (t.totalResults / t.calls).toFixed(1) : '-'
    console.log(
      `  ${pad(t.tool, 22)} ${pad(String(t.calls), 8)} ${pad(String(t.ok), 8)} ${pad(String(t.nonEmpty), 12)} ${pad(avgResult, 12)} ${pad(String(t.avgDurationMs), 8)}`
    )
  }
  console.log('')
  if (r.perConversationTop.length) {
    console.log('Top conversations by memory activity')
    console.log(`  ${pad('conversationId', 30)} ${pad('total', 8)} ${pad('reads', 8)} ${pad('writes', 8)} window`)
    for (const c of r.perConversationTop) {
      const window = `${new Date(c.firstTs).toISOString().slice(0, 19)} → ${new Date(c.lastTs).toISOString().slice(0, 19)}`
      console.log(
        `  ${pad(c.conversationId.slice(0, 30), 30)} ${pad(String(c.totalCalls), 8)} ${pad(String(c.reads), 8)} ${pad(String(c.writes), 8)} ${window}`
      )
    }
    console.log('')
  }

  // Topline interpretation, the one number we built this for.
  if (r.distinctConversations === 0) {
    console.log('Verdict: no memory tool activity recorded yet — open a few real chats and re-run.')
    return
  }
  const readRate = (r.conversationsWithReads / r.distinctConversations) * 100
  console.log(`Conversations that read memory: ${r.conversationsWithReads}/${r.distinctConversations} (${readRate.toFixed(1)}%)`)
  if (readRate < 25) {
    console.log('  → Models almost never read curated memory voluntarily. Lever 1 (auto-recall) is the right next step.')
  } else if (readRate < 60) {
    console.log('  → Models read memory in some conversations but not consistently. Mix of Lever 2 (prompt nudges) + Lever 1.')
  } else {
    console.log('  → Models already pull memory in most conversations; focus dreamer quality, not retrieval.')
  }
}

main().catch((err) => {
  console.error('memory-usage-report failed:', err)
  process.exit(1)
})
