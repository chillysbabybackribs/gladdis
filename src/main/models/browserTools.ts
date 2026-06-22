import type { TabManager } from '../TabManager'
import type { PageExtractor } from '../extract/PageExtractor'
import type { ChatStore } from './ChatStore'
import { FileTools } from '../fs/FileTools'
import { AGENT_TOOLS } from './agentTools'
import type { LlmComplete } from '../pipeline/Planner'
import type { PipelineProgressEvent } from '../pipeline/Runner'
import { KeyStore } from './KeyStore'
import type { CapabilityBroker } from './capabilities/CapabilityBroker'

import {
  runClickXY,
  runCdpCommand,
  runExecuteInBrowser,
  runNavigate,
  runPressKey,
  runTypeText,
  runGrepClick,
  runGrepType
} from './tools/driveTools'
import { runReadClipboard, runWriteClipboard } from './tools/clipboardTools'
import {
  runEditFile,
  runListDir,
  runReadFile,
  runSearchFiles,
  runWriteFile
} from './tools/fsTools'
import { runGrepPage, runReadPage, runScreenshot, runScreenshotApp } from './tools/perceiveTools'
import {
  runReadSpans,
  runRepoOverview,
  runResearchDossier,
  runSearchRepo,
  runVerifyChange
} from './tools/repoCapabilityTools'
import {
  runDeepSearchTool,
  runFetchPage,
  runSearchTool
} from './tools/searchTools'
import { runShellCommand } from './tools/shellTools'
import {
  runAuditCodebase,
  runBrowseTask,
  runPublishChanges,
  runValidation
} from './tools/taskTools'
import { runRecallHistory, runRequestTools } from './tools/historyTools'

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const TOOLS: ToolDef[] = AGENT_TOOLS

export interface ToolOutcome {
  text: string
  imageBase64?: string
  ok: boolean
}

export interface ToolContext {
  tabId: string
  requestId?: string
  assistantMessageId?: string
  conversationId?: string | null
  taskId?: string
  iteration?: number
  fullResults?: Map<string, string>
  llm?: LlmComplete
  onProgress?: (event: PipelineProgressEvent) => void
  /**
   * Tools the model has pulled in this turn via request_tools, on top of the
   * lean starting profile. The provider loop rebuilds its tool list from
   * profile ∪ grantedTools after each step, so a model that needs filesystem
   * or browser tools asks for them and continues — it never narrates "I can't".
   */
  grantedTools?: Set<string>
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
  private capabilityBroker: CapabilityBroker | null = null

  /** Read-through digest cache for `read_page`. Keyed `${tabId}:${focus}:${viewportOnly}`. */
  private readonly pageCache = new Map<string, string>()
  private static readonly PAGE_CACHE_LIMIT = 32

  constructor(
    public readonly tabs: TabManager,
    public readonly extractor: PageExtractor,
    public readonly chats: ChatStore,
    public readonly keys?: KeyStore
  ) {}

  setAppCapture(fn: () => Promise<string>): void {
    this.appCapture = fn
  }

  setCapabilityBroker(broker: CapabilityBroker): void {
    this.capabilityBroker = broker
  }

  setWorkspaceRoot(root: string | null): void {
    this.files.setRoot(root)
  }

  getWorkspaceRoot(): string | null {
    return this.files.getRoot()
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

  private rememberDone(ctx: ToolContext, key: string, summary: string): void {
    const scope = this.taskScope(ctx)
    if (!scope.has(key) && scope.size >= BrowserTools.TASK_SCOPE_LIMIT) {
      const first = scope.keys().next().value
      if (first !== undefined) scope.delete(first)
    }
    scope.set(key, summary)
  }

  // Bound dep bundles for each tool module. Recomputed per call only because
  // a few of them depend on `this.capabilityBroker` which the renderer can
  // wire up post-construction.
  private driveDeps() {
    return { tabs: this.tabs }
  }

  private fsDeps() {
    return { files: this.files }
  }

  private perceiveDeps() {
    return {
      tabs: this.tabs,
      extractor: this.extractor,
      pageCache: this.pageCache,
      pageCacheLimit: BrowserTools.PAGE_CACHE_LIMIT,
      appCapture: this.appCapture
    }
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

  private repoCapabilityDeps() {
    return {
      capabilityBroker: this.capabilityBroker,
      getWorkspaceRoot: () => this.getWorkspaceRoot()
    }
  }

  private taskDeps() {
    return {
      tabs: this.tabs,
      extractor: this.extractor,
      files: this.files,
      keys: this.keys,
      getWorkspaceRoot: () => this.getWorkspaceRoot()
    }
  }

  private historyDeps() {
    return { chats: this.chats }
  }

  /** Dispatch a tool call to the right per-domain module. */
  async run(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
    try {
      switch (name) {
        // ── Perceive ────────────────────────────────────────────────────────
        case 'read_page':
          return runReadPage(this.perceiveDeps(), args, ctx.tabId)
        case 'grep_page':
          return runGrepPage(this.perceiveDeps(), args, ctx.tabId)
        case 'screenshot':
          return runScreenshot(this.perceiveDeps(), args, ctx.tabId)
        case 'screenshot_app':
          return runScreenshotApp(this.perceiveDeps())

        // ── Search ──────────────────────────────────────────────────────────
        case 'deep_search':
          return runDeepSearchTool(this.searchDeps(), args, ctx)
        case 'search':
          return runSearchTool(this.searchDeps(), args, ctx)
        case 'fetch_page':
          return runFetchPage(this.searchDeps(), args, ctx)

        // ── Repo intelligence (capability broker) ───────────────────────────
        case 'repo_overview':
          return runRepoOverview(this.repoCapabilityDeps(), args, ctx)
        case 'search_repo':
          return runSearchRepo(this.repoCapabilityDeps(), args, ctx)
        case 'read_spans':
          return runReadSpans(this.repoCapabilityDeps(), args, ctx)
        case 'research_dossier':
          return runResearchDossier(this.repoCapabilityDeps(), args, ctx)
        case 'verify_change':
          return runVerifyChange(this.repoCapabilityDeps(), args, ctx)

        // ── Task / pipeline ─────────────────────────────────────────────────
        case 'browse_task':
          return runBrowseTask(this.taskDeps(), args, ctx)
        case 'audit_codebase':
          return runAuditCodebase(this.taskDeps(), args)

        // ── Drive (CDP) ─────────────────────────────────────────────────────
        case 'execute_in_browser':
          return runExecuteInBrowser(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'navigate':
          return runNavigate(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'click_xy':
          return runClickXY(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'press_key':
          return runPressKey(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'type_text':
          return runTypeText(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'cdp_command':
          return runCdpCommand(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'grep_click':
          return runGrepClick(this.driveDeps(), args, { tabId: ctx.tabId })
        case 'grep_type':
          return runGrepType(this.driveDeps(), args, { tabId: ctx.tabId })

        // ── Filesystem ──────────────────────────────────────────────────────
        case 'read_file':
          return runReadFile(this.fsDeps(), args)
        case 'write_file':
          return runWriteFile(this.fsDeps(), args)
        case 'edit_file':
          return runEditFile(this.fsDeps(), args)
        case 'list_dir':
          return runListDir(this.fsDeps(), args)
        case 'search_files':
          return runSearchFiles(this.fsDeps(), args)

        // ── Clipboard ───────────────────────────────────────────────────────
        case 'read_clipboard':
          return runReadClipboard(args)
        case 'write_clipboard':
          return runWriteClipboard(args)

        // ── Local validation / shell / publish ──────────────────────────────
        case 'run_validation':
          return runValidation(this.taskDeps(), args)
        case 'run_command':
          return runShellCommand({ files: this.files }, args)
        case 'publish_changes':
          return runPublishChanges(this.taskDeps(), args)

        // ── Tool escalation + memory ────────────────────────────────────────
        case 'request_tools':
          return runRequestTools(args, ctx)
        case 'recall_history':
          return runRecallHistory(this.historyDeps(), args, ctx)

        case 'memory_write':
          return (await import('./memoryStore')).memoryWrite(args)
        case 'memory_read':
          return (await import('./memoryStore')).memoryRead(args)
        case 'memory_list':
          return (await import('./memoryStore')).memoryList(args)
        case 'memory_forget':
          return (await import('./memoryStore')).memoryForget(args)
        case 'memory_create_task':
          return (await import('./memoryStore')).memoryCreateTask(args)

        default:
          return { ok: false, text: `Unknown tool: ${name}` }
      }
    } catch (err) {
      return { ok: false, text: `Tool ${name} failed: ${(err as Error)?.message ?? String(err)}` }
    }
  }
}
