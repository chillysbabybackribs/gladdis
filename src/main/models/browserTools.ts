import type { TabManager, TabBrief } from '../TabManager'
import { TAB_BRIEF_CARRYING_TOOLS } from './codex/dynamicBrowserTools'
import type { PageExtractor } from '../extract/PageExtractor'
import type { ChatStore } from './ChatStore'
import { FileTools } from '../fs/FileTools'
import { AGENT_TOOLS } from './agentTools'
import type { LlmComplete } from './llm'
import type { PipelineProgressStep } from '../../../shared/chat'
import { KeyStore } from './KeyStore'
import type { AxSnapshot, AxSnapshotNode } from '../extract/axTree'
import { axRefStillValid, resolveAxRef, type AxRefStore } from '../extract/axRef'
import { savePageCapture, type PageStoreConfig, type SavedPage } from '../extract/pageStore'
import type { PageCapture } from '../../../shared/extraction'

import {
  runAct,
  runCdpCommand,
  runExecuteInBrowser,
  runOpenResult,
  runNavigate,
  runGrepClick,
  runGrepType,
  runSetField,
  runSubmit
} from './tools/driveTools'
import {
  instrumentMemoryTool,
  memoryListHitCount,
  memoryReadHitCount,
  recallHistoryHitCount
} from './memory/memoryUsageLog'
import {
  runEditFile,
  runListDir,
  runReadFile,
  runSearchFiles,
  runWriteFile
} from './tools/fsTools'
import {
  type ReadPageCacheEntry,
  type ReadA11yCacheEntry,
  runDiagnoseTarget,
  runDiscoverDataSources,
  runExtractStructured,
  runGrepPage,
  runReadA11y,
  runReadPage,
  runScreenshot,
  runScreenshotApp,
  runWaitForLoad,
  runWatchNetwork
} from './tools/perceiveTools'
import { runSearchTool } from './tools/searchTools'
import { runShellCommand } from './tools/shellTools'
import { runRecallHistory } from './tools/historyTools'
import type { ReadPageCacheStats } from './tools/perceiveTools'
import {
  buildToolCalibrationBlock,
  createToolCalibrationState,
  maybeAddRecalibrationHint,
  noteToolCalibrationOutcome,
  type ToolCalibrationState,
} from './toolCalibration'

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  outputSchema?: Record<string, unknown>
}

export const TOOLS: ToolDef[] = AGENT_TOOLS

export interface ToolOutcome {
  text: string
  imageBase64?: string
  structuredContent?: Record<string, unknown>
  ok: boolean
}

export interface ToolContext {
  tabId: string
  requestId?: string
  assistantMessageId?: string
  conversationId?: string | null
  /** Latest substantive user request for this turn, stripped of UI preambles when applicable. */
  latestUserText?: string
  taskId?: string
  iteration?: number
  fullResults?: Map<string, string>
  llm?: LlmComplete
  onProgress?: (event: PipelineProgressStep) => void
  /**
   * Absolute path of the workspace folder for this turn. Required for memory_*
   * tools; ChatService.toolContext() sources it from the user-selected
   * workspace and falls back to process.cwd() only once, centrally. Memory
   * scoping is per-workspace, so this is the single source of truth.
   */
  workspaceRoot?: string
}

/**
 * Browser tools whose result should carry the tab-grounding brief. Sourced from
 * the single canonical list in dynamicBrowserTools so the runtime injection and
 * the prompt guidance can never drift apart.
 */
const TAB_BRIEF_TOOLS = new Set<string>(TAB_BRIEF_CARRYING_TOOLS)

/**
 * One-line, human-readable summary of the tab brief, appended to a tool's text
 * so text-only consumers (e.g. the MCP bridge, which historically dropped
 * structuredContent) stay grounded on which tab they are on and whether it is
 * still — or slowly — loading. Kept terse to avoid context bloat.
 */
function formatTabBriefLine(brief: TabBrief): string {
  const where = `tab ${brief.index}/${brief.count}`
  if (!brief.loading) return `[${where}] ${brief.url}`
  const secs = brief.loadingMs !== null ? ` ${(brief.loadingMs / 1000).toFixed(1)}s` : ''
  const slow = brief.slowLoad ? ' — LOADING LONGER THAN NORMAL; consider wait_for_load or re-check' : ''
  return `[${where}] loading${secs}${slow} ${brief.url}`
}

/**
 * Merge the tab-grounding brief into a browser tool's successful outcome, both
 * as structured `tab` state and as an appended text line. Non-browser tools,
 * failures, and calls with no resolvable tab are returned unchanged.
 */
function withTabBrief(
  tabs: TabManager,
  name: string,
  tabId: string | null | undefined,
  outcome: ToolOutcome
): ToolOutcome {
  if (!outcome.ok || !TAB_BRIEF_TOOLS.has(name)) return outcome
  // Best-effort: grounding enrichment must never fail (or crash) a successful
  // tool call. If the tab layer can't produce a brief, return the outcome as-is.
  if (typeof tabs?.tabBrief !== 'function') return outcome
  let brief: TabBrief | null
  try {
    brief = tabs.tabBrief(tabId)
  } catch {
    return outcome
  }
  if (!brief) return outcome
  return {
    ...outcome,
    text: `${outcome.text}\n${formatTabBriefLine(brief)}`,
    structuredContent: { ...(outcome.structuredContent ?? {}), tab: brief }
  }
}

/**
 * BrowserTools is the dispatch façade for every tool the agent can call. The
 * actual logic per domain lives in `tools/*.ts`; this class owns the shared
 * state (page-digest cache, per-task memory, app-window capture handle,
 * capability broker reference) and routes each `name` to the right module.
 *
 * The split keeps any one tool's edits surgical: search caching only touches
 * `tools/searchTools.ts`, CDP key handling only touches `tools/driveTools.ts`,
 * etc.
 */
export class BrowserTools {
  private readonly files = new FileTools()
  private appCapture: (() => Promise<string>) | null = null
  /** Per-conversation/tab dedup memory for search/fetch/etc. */
  private readonly taskDone = new Map<string, Map<string, string>>()
  /** Capped by {@link TASK_DONE_LIMIT}. */
  private static readonly TASK_DONE_LIMIT = 64
  /** Per-scope dedup keys, capped to prevent unbounded growth on long tasks. */
  private static readonly TASK_SCOPE_LIMIT = 200

  /** Read-through digest cache for `read_page`. Keyed `${tabId}:${focus}:${viewportOnly}`. */
  private readonly pageCache = new Map<string, ReadPageCacheEntry>()
  private static readonly PAGE_CACHE_LIMIT = 32
  private static readonly PAGE_CACHE_TTL_MS = 120_000
  private readonly pageCacheStats: Pick<ReadPageCacheStats, 'hits' | 'misses' | 'expired' | 'evictions'> = {
    hits: 0,
    misses: 0,
    expired: 0,
    evictions: 0
  }

  /** Read-through digest cache for `read_a11y`. */
  private readonly a11yCache = new Map<string, ReadA11yCacheEntry>()
  private static readonly A11Y_CACHE_LIMIT = 32
  private static readonly A11Y_CACHE_TTL_MS = 120_000
  private readonly a11yCacheStats: Pick<ReadPageCacheStats, 'hits' | 'misses' | 'expired' | 'evictions'> = {
    hits: 0,
    misses: 0,
    expired: 0,
    evictions: 0
  }
  /** Latest read_a11y snapshot per tab for @aN actions. */
  private readonly axRefByTab = new Map<string, AxRefStore>()
  private static readonly AX_REF_TTL_MS = 120_000

  /** Root dir where navigate writes captured pages (set once at wire-up). */
  private pageStoreBaseDir: string | null = null
  /** Per-task calibration notes used for light runtime tool orientation. */
  private readonly calibrationByScope = new Map<string, ToolCalibrationState>()
  private static readonly CALIBRATION_SCOPE_LIMIT = 64

  constructor(
    public readonly tabs: TabManager,
    public readonly extractor: PageExtractor,
    public readonly chats: ChatStore,
    public readonly keys?: KeyStore
  ) {}

  setAppCapture(fn: () => Promise<string>): void {
    this.appCapture = fn
  }

  /** Where navigate persists captured pages, e.g. <userData>/gladdis-pages. */
  setPageStoreBaseDir(dir: string | null): void {
    this.pageStoreBaseDir = dir
  }

  setWorkspaceRoot(root: string | null): void {
    this.files.setRoot(root)
  }

  getWorkspaceRoot(): string | null {
    return this.files.getRoot()
  }

  /**
   * The workspace root a memory_* call should bind to. Prefers the turn's
   * ToolContext (set by ChatService from the selected folder, with a single
   * centralized fallback to process.cwd()), then the file-tools selection.
   * Returns null only when no source is available at all — callers should
   * surface that as an actionable error instead of silently using cwd.
   */
  private resolveMemoryWorkspaceRoot(ctx: ToolContext): string | null {
    return ctx.workspaceRoot ?? this.files.getRoot() ?? null
  }

  /**
   * Per-task memory bucket. Keyed by `conversationId || tabId`; the bucket
   * stores tool-call dedup keys (search query → result, fetch URL → digest)
   * so the model can't burn loops on the same input within one task.
   */
  private taskScope(ctx: ToolContext): Map<string, string> {
    const key = ctx.conversationId || ctx.tabId
    let scope = this.taskDone.get(key)
    if (!scope) {
      if (this.taskDone.size >= BrowserTools.TASK_DONE_LIMIT) {
        const first = this.taskDone.keys().next().value
        if (first !== undefined) this.taskDone.delete(first)
      }
      scope = new Map<string, string>()
      this.taskDone.set(key, scope)
    }
    return scope
  }

  private calibrationScope(ctx: Pick<ToolContext, 'conversationId' | 'tabId'>): ToolCalibrationState {
    const key = ctx.conversationId || ctx.tabId
    let state = this.calibrationByScope.get(key)
    if (!state) {
      if (this.calibrationByScope.size >= BrowserTools.CALIBRATION_SCOPE_LIMIT) {
        const first = this.calibrationByScope.keys().next().value
        if (first !== undefined) this.calibrationByScope.delete(first)
      }
      state = createToolCalibrationState()
      this.calibrationByScope.set(key, state)
    }
    return state
  }

  private rememberDone(ctx: ToolContext, key: string, summary: string): void {
    const scope = this.taskScope(ctx)
    if (!scope.has(key) && scope.size >= BrowserTools.TASK_SCOPE_LIMIT) {
      const first = scope.keys().next().value
      if (first !== undefined) scope.delete(first)
    }
    scope.set(key, summary)
  }

  clearPageCacheForTab(tabId: string): void {
    for (const key of this.pageCache.keys()) {
      if (key.startsWith(`${tabId}:`)) {
        this.pageCache.delete(key)
        this.recordPageCacheEvent('evicted')
      }
    }
    for (const key of this.a11yCache.keys()) {
      if (key.startsWith(`${tabId}:`)) {
        this.a11yCache.delete(key)
        this.recordA11yCacheEvent('evicted')
      }
    }
    this.axRefByTab.delete(tabId)
  }

  calibrationBlock(toolNames: Iterable<string>, ctx: Pick<ToolContext, 'tabId' | 'conversationId' | 'workspaceRoot'>): string {
    return buildToolCalibrationBlock({
      toolNames,
      tabId: ctx.tabId,
      workspaceRoot: ctx.workspaceRoot ?? this.files.getRoot(),
      state: this.calibrationScope(ctx)
    })
  }

  private setAxRefStore(tabId: string, entry: ReadA11yCacheEntry): void {
    this.axRefByTab.set(tabId, {
      pageUrl: entry.pageUrl,
      capturedAt: entry.capturedAt,
      nodes: entry.snapshot.nodes
    })
  }

  private resolveAxRef(tabId: string, query: string): AxSnapshotNode | null {
    const store = this.axRefByTab.get(tabId)
    if (!axRefStillValid(store, this.tabs.getTabUrl(tabId), BrowserTools.AX_REF_TTL_MS)) {
      return null
    }
    return resolveAxRef(store!.nodes, query)
  }

  /**
   * The page-save closure navigate/wait_for_load use to write a captured page to
   * disk. Undefined when no store dir is configured (so saving is skipped).
   */
  private savePageFn():
    | ((cap: PageCapture, conversationId: string | null | undefined) => Promise<SavedPage>)
    | undefined {
    if (!this.pageStoreBaseDir) return undefined
    const baseDir = this.pageStoreBaseDir
    return async (cap: PageCapture, conversationId: string | null | undefined): Promise<SavedPage> => {
      const config: PageStoreConfig = { baseDir }
      return savePageCapture(cap, conversationId || 'default', config)
    }
  }

  // Bound dep bundles for each tool module.
  private driveDeps() {
    return {
      tabs: this.tabs,
      resolveAxRef: (tabId: string, query: string) => this.resolveAxRef(tabId, query),
      extractor: this.extractor,
      savePage: this.savePageFn()
    }
  }

  private fsDeps() {
    return { files: this.files }
  }

  private perceiveDeps() {
    return {
      tabs: this.tabs,
      extractor: this.extractor,
      resolveAxRef: (tabId: string, query: string) => this.resolveAxRef(tabId, query),
      pageCache: this.pageCache,
      pageCacheLimit: BrowserTools.PAGE_CACHE_LIMIT,
      pageCacheTtlMs: BrowserTools.PAGE_CACHE_TTL_MS,
      a11yCache: this.a11yCache,
      a11yCacheLimit: BrowserTools.A11Y_CACHE_LIMIT,
      a11yCacheTtlMs: BrowserTools.A11Y_CACHE_TTL_MS,
      setAxRefStore: (tabId: string, entry: ReadA11yCacheEntry) => this.setAxRefStore(tabId, entry),
      appCapture: this.appCapture,
      getPageCacheStats: () => this.getPageCacheStatsSnapshot(),
      getA11yCacheStats: () => this.getA11yCacheStatsSnapshot(),
      recordPageCacheEvent: (event: 'hit' | 'miss' | 'expired' | 'evicted') =>
        this.recordPageCacheEvent(event),
      recordA11yCacheEvent: (event: 'hit' | 'miss' | 'expired' | 'evicted') =>
        this.recordA11yCacheEvent(event),
      savePage: this.savePageFn()
    }
  }

  private getA11yCacheStatsSnapshot(): ReadPageCacheStats {
    return {
      ...this.a11yCacheStats,
      size: this.a11yCache.size,
      limit: BrowserTools.A11Y_CACHE_LIMIT,
      ttlMs: BrowserTools.A11Y_CACHE_TTL_MS
    }
  }

  private recordA11yCacheEvent(event: 'hit' | 'miss' | 'expired' | 'evicted'): void {
    if (event === 'hit') this.a11yCacheStats.hits += 1
    if (event === 'miss') this.a11yCacheStats.misses += 1
    if (event === 'expired') this.a11yCacheStats.expired += 1
    if (event === 'evicted') this.a11yCacheStats.evictions += 1
  }

  private getPageCacheStatsSnapshot(): ReadPageCacheStats {
    return {
      ...this.pageCacheStats,
      size: this.pageCache.size,
      limit: BrowserTools.PAGE_CACHE_LIMIT,
      ttlMs: BrowserTools.PAGE_CACHE_TTL_MS
    }
  }

  private recordPageCacheEvent(event: 'hit' | 'miss' | 'expired' | 'evicted'): void {
    if (event === 'hit') this.pageCacheStats.hits += 1
    if (event === 'miss') this.pageCacheStats.misses += 1
    if (event === 'expired') this.pageCacheStats.expired += 1
    if (event === 'evicted') this.pageCacheStats.evictions += 1
  }

  private searchDeps() {
    return {
      tabs: this.tabs,
      extractor: this.extractor,
      keys: this.keys,
      taskScope: (ctx: ToolContext) => this.taskScope(ctx),
      rememberDone: (ctx: ToolContext, key: string, summary: string) =>
        this.rememberDone(ctx, key, summary)
    }
  }

  private historyDeps() {
    return { chats: this.chats }
  }

  /** Dispatch a tool call to the right per-domain module. */
  async run(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
    try {
      let outcome: ToolOutcome
      switch (name) {
        // ── Perceive ────────────────────────────────────────────────────────
        case 'read_page':
          outcome = await runReadPage(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'wait_for_load':
          outcome = await runWaitForLoad(this.perceiveDeps(), args, ctx.tabId, ctx.conversationId)
          break
        case 'read_a11y':
          outcome = await runReadA11y(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'grep_page':
          outcome = await runGrepPage(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'diagnose_target':
          outcome = await runDiagnoseTarget(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'extract_structured':
          outcome = await runExtractStructured(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'watch_network':
          outcome = await runWatchNetwork(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'discover_data_sources':
          outcome = await runDiscoverDataSources(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'screenshot':
          outcome = await runScreenshot(this.perceiveDeps(), args, ctx.tabId)
          break
        case 'screenshot_app':
          outcome = await runScreenshotApp(this.perceiveDeps())
          break

        // ── Search ──────────────────────────────────────────────────────────
        case 'search':
          outcome = await runSearchTool(this.searchDeps(), args, ctx)
          break

        // ── Drive (CDP) ─────────────────────────────────────────────────────
        case 'act':
          outcome = await runAct(this.driveDeps(), args, { tabId: ctx.tabId, conversationId: ctx.conversationId })
          break
        case 'set_field':
          outcome = await runSetField(this.driveDeps(), args, { tabId: ctx.tabId })
          break
        case 'submit':
          outcome = await runSubmit(this.driveDeps(), args, { tabId: ctx.tabId })
          break
        case 'open_result':
          outcome = await runOpenResult(this.driveDeps(), args, { tabId: ctx.tabId })
          break
        case 'execute_in_browser':
          outcome = await runExecuteInBrowser(this.driveDeps(), args, { tabId: ctx.tabId })
          break
        case 'navigate':
          outcome = await runNavigate(this.driveDeps(), args, { tabId: ctx.tabId, conversationId: ctx.conversationId })
          break
        case 'cdp_command':
          outcome = await runCdpCommand(this.driveDeps(), args, { tabId: ctx.tabId })
          break
        case 'grep_click':
          outcome = await runGrepClick(this.driveDeps(), args, { tabId: ctx.tabId })
          break
        case 'grep_type':
          outcome = await runGrepType(this.driveDeps(), args, { tabId: ctx.tabId })
          break

        // ── Filesystem ──────────────────────────────────────────────────────
        case 'read_file': {
          // Dedup identical re-reads within one task. The model re-reads the same
          // path+range across turns (e.g. re-opening a file it already pulled in),
          // and each re-read re-sends the full contents at full price. If this exact
          // read already happened this task, point it back at the prior result rather
          // than shipping the file again. Reuses the existing per-task dedup scope.
          const num = (v: unknown): string => {
            const n = typeof v === 'number' ? v : Number(v)
            return Number.isFinite(n) ? String(n) : ''
          }
          const readKey =
            `read_file:${String(args.path ?? '')}:${num(args.start_line)}:` +
            `${num(args.end_line)}:${args.full === true ? 'full' : ''}`
          const priorRead = this.taskScope(ctx).get(readKey)
          if (priorRead) {
            outcome = {
              ok: true,
              text:
                `Already read ${String(args.path ?? '')} earlier in this task — its contents are above ` +
                `(${priorRead}). Re-use that; call recall_history if it was trimmed. ` +
                `Read again only if the file may have changed since.`
            }
            break
          }
          outcome = await runReadFile(this.fsDeps(), args)
          if (outcome.ok) {
            this.rememberDone(ctx, readKey, `read at iteration ${ctx.iteration ?? '?'}`)
          }
          break
        }
        case 'write_file':
          outcome = await runWriteFile(this.fsDeps(), args)
          break
        case 'edit_file':
          outcome = await runEditFile(this.fsDeps(), args)
          break
        case 'list_dir':
          outcome = await runListDir(this.fsDeps(), args)
          break
        case 'search_files':
          outcome = await runSearchFiles(this.fsDeps(), args)
          break

        // ── Shell ───────────────────────────────────────────────────────────
        case 'run_command':
          outcome = await runShellCommand({ files: this.files }, args)
          break

        // ── Memory ──────────────────────────────────────────────────────────
        case 'recall_history': {
          const root = this.resolveMemoryWorkspaceRoot(ctx)
          // recall_history can run without a workspace (it reads ChatStore),
          // but logging requires one. When absent we just skip the log and
          // dispatch normally — telemetry never blocks behaviour.
          if (!root) {
            outcome = await runRecallHistory(this.historyDeps(), args, ctx)
            break
          }
          outcome = await instrumentMemoryTool(
            'recall_history',
            {
              workspaceRoot: root,
              conversationId: ctx.conversationId ?? null,
              tabId: ctx.tabId ?? null,
              scope: typeof args.scope === 'string' ? args.scope : 'conversation',
              query: typeof args.query === 'string' ? args.query : undefined
            },
            async () => runRecallHistory(this.historyDeps(), args, ctx),
            (out) => recallHistoryHitCount(out.text)
          )
          break
        }

        case 'memory_write': {
          const root = this.resolveMemoryWorkspaceRoot(ctx)
          if (!root) {
            outcome = { ok: false, text: 'memory_write requires a workspace folder. Open one and retry.' }
            break
          }
          outcome = await instrumentMemoryTool(
            'memory_write',
            {
              workspaceRoot: root,
              conversationId: ctx.conversationId ?? null,
              tabId: ctx.tabId ?? null,
              scope: typeof args.scope === 'string' ? args.scope : undefined,
              taskId: typeof args.task_id === 'string' ? args.task_id : null,
              keys: typeof args.key === 'string' ? [args.key] : undefined
            },
            async () =>
              (await import('./memoryStore')).memoryWrite(
                { ...args, conversationId: args.conversationId ?? ctx.conversationId ?? undefined },
                root
              ),
            () => 1
          )
          break
        }
        case 'memory_read': {
          const root = this.resolveMemoryWorkspaceRoot(ctx)
          if (!root) {
            outcome = { ok: false, text: 'memory_read requires a workspace folder. Open one and retry.' }
            break
          }
          outcome = await instrumentMemoryTool(
            'memory_read',
            {
              workspaceRoot: root,
              conversationId: ctx.conversationId ?? null,
              tabId: ctx.tabId ?? null,
              scope: typeof args.scope === 'string' ? args.scope : undefined,
              taskId: typeof args.task_id === 'string' ? args.task_id : null,
              keys: Array.isArray(args.keys) ? args.keys.filter((k: unknown) => typeof k === 'string') : undefined
            },
            async () => (await import('./memoryStore')).memoryRead(args, root),
            (out) => memoryReadHitCount(out.text)
          )
          break
        }
        case 'memory_list': {
          const root = this.resolveMemoryWorkspaceRoot(ctx)
          if (!root) {
            outcome = { ok: false, text: 'memory_list requires a workspace folder. Open one and retry.' }
            break
          }
          outcome = await instrumentMemoryTool(
            'memory_list',
            {
              workspaceRoot: root,
              conversationId: ctx.conversationId ?? null,
              tabId: ctx.tabId ?? null,
              scope: typeof args.scope === 'string' ? args.scope : undefined,
              taskId: typeof args.task_id === 'string' ? args.task_id : null
            },
            async () => (await import('./memoryStore')).memoryList(args, root),
            (out) => memoryListHitCount(out.text)
          )
          break
        }
        case 'memory_forget': {
          const root = this.resolveMemoryWorkspaceRoot(ctx)
          if (!root) {
            outcome = { ok: false, text: 'memory_forget requires a workspace folder. Open one and retry.' }
            break
          }
          outcome = await instrumentMemoryTool(
            'memory_forget',
            {
              workspaceRoot: root,
              conversationId: ctx.conversationId ?? null,
              tabId: ctx.tabId ?? null,
              scope: typeof args.scope === 'string' ? args.scope : undefined,
              taskId: typeof args.task_id === 'string' ? args.task_id : null,
              keys: Array.isArray(args.keys) ? args.keys.filter((k: unknown) => typeof k === 'string') : undefined
            },
            async () => (await import('./memoryStore')).memoryForget(args, root),
            () => 1
          )
          break
        }
        case 'memory_create_task': {
          const root = this.resolveMemoryWorkspaceRoot(ctx)
          if (!root) {
            outcome = { ok: false, text: 'memory_create_task requires a workspace folder. Open one and retry.' }
            break
          }
          outcome = await instrumentMemoryTool(
            'memory_create_task',
            {
              workspaceRoot: root,
              conversationId: ctx.conversationId ?? null,
              tabId: ctx.tabId ?? null,
              scope: 'task'
            },
            async () => (await import('./memoryStore')).memoryCreateTask(args, root),
            () => 1
          )
          break
        }

        default:
          outcome = { ok: false, text: `Unknown tool: ${name}` }
          break
      }
      // Ground the model on where it is in the browser: every successful
      // perception/drive result carries the current tab (id, index/count) and
      // its live load state, so the model always knows which tab it is on and
      // whether that tab is still — or abnormally slowly — loading.
      outcome = withTabBrief(this.tabs, name, ctx.tabId, outcome)
      const state = this.calibrationScope(ctx)
      noteToolCalibrationOutcome(state, name, outcome, ctx.iteration)
      return maybeAddRecalibrationHint(state, name, outcome)
    } catch (err) {
      const outcome = { ok: false, text: `Tool ${name} failed: ${(err as Error)?.message ?? String(err)}` }
      const state = this.calibrationScope(ctx)
      noteToolCalibrationOutcome(state, name, outcome, ctx.iteration)
      return maybeAddRecalibrationHint(state, name, outcome)
    }
  }
}
