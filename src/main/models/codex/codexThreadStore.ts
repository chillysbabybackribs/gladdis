import type { ChatRequest, CodexWorkspace } from '../../../../shared/types'
import type { CodexAppServer } from './CodexAppServer'
import type { ThreadCompactor } from './ThreadCompactor'
import { resolveCodexPosture, type CodexPosture } from './posture'
import {
  CODEX_BROWSER_TOOLS,
  CODEX_DISABLED_NATIVE_CONFIG
} from './dynamicBrowserTools'
import {
  requestWithOptimizationFallback,
  serviceTierForModel
} from './turnOptions'
import type {
  JsonValue,
  ThreadResumeParams,
  ThreadStartParams
} from './protocol'

export interface ThreadResolution {
  threadId: string
  /** True when a stale binding can still be discarded and retried once. */
  canRetryFresh: boolean
}

export interface PersistedThreads {
  get: (conversationId: string) => string | null
  set: (conversationId: string, threadId: string | null) => void
}

export interface CodexThreadStoreDeps {
  /** Lazily resolves the running app-server (start it if not yet up). */
  ensureServer: () => Promise<CodexAppServer>
  getWorkspace: () => CodexWorkspace
  compactor: ThreadCompactor
  persistedThreads: PersistedThreads
}

/**
 * Owns the conversation-id → Codex threadId binding, both in-memory and on
 * disk. Knows how to start fresh threads, resume persisted ones, and pick the
 * right cwd / approval / sandbox posture from the user's chosen workspace.
 *
 * Extracted from CodexClient so the client itself can focus on the live-turn
 * surface (ensureServer, send, complete, dispose) without also juggling
 * thread lifecycle. Two key invariants:
 *
 *   • Codex always gets unrestricted OS-user access — the workspace folder is
 *     a launch location only.
 *   • Ephemeral threads (no conversationId) are never remembered, so an
 *     internal `complete()` call doesn't leak a binding into the next turn.
 */
export class CodexThreadStore {
  /** conversationId / ephemeral key → Codex threadId */
  private readonly threads = new Map<string, string>()

  constructor(private readonly deps: CodexThreadStoreDeps) {}

  /** Drop all in-memory bindings (called when the app-server exits). */
  clear(): void {
    this.threads.clear()
  }

  /**
   * Resolve cwd + approval + sandbox posture for a turn. The user's folder
   * choice is a launch location only; permissions are always full OS access.
   */
  posture(useWorkspace = true): CodexPosture {
    return resolveCodexPosture(useWorkspace ? this.deps.getWorkspace().folder : null)
  }

  /** Get (or recover) the Codex thread for this conversation. */
  async ensureThread(
    req: ChatRequest,
    system?: string,
    useWorkspace = true
  ): Promise<ThreadResolution> {
    const conversationId = req.conversationId ?? null
    const key = this.threadKey(conversationId, useWorkspace)
    const cached = this.threads.get(key)
    if (cached) {
      // If the cached thread is mid-compaction, wait for it before reusing —
      // turn/start during compaction races and can drop messages.
      await this.deps.compactor.wait(cached)
      return { threadId: cached, canRetryFresh: !!conversationId }
    }
    if (!conversationId) {
      const threadId = await this.startThread(null, req.modelId, system, false, useWorkspace)
      return { threadId, canRetryFresh: false }
    }

    const persisted = this.deps.persistedThreads.get(conversationId)
    if (persisted) {
      // We have a thread on disk from a previous run — try to resume it. If
      // the resume fails (Codex restarted, GC'd, etc.) the caller can fall
      // back to a fresh start via `forget` + `startThread`.
      const threadId = await this.resumeThread(
        conversationId,
        persisted,
        req.modelId,
        system,
        useWorkspace
      )
      return { threadId, canRetryFresh: true }
    }

    const threadId = await this.startThread(conversationId, req.modelId, system, false, useWorkspace)
    return { threadId, canRetryFresh: false }
  }

  /**
   * Start a fresh thread. Set `ephemeral` for one-shot turns (no
   * conversationId binding) — those never get remembered or persisted.
   */
  async startThread(
    conversationId: string | null,
    modelId: string,
    system?: string,
    ephemeral = false,
    useWorkspace = true
  ): Promise<string> {
    const server = await this.deps.ensureServer()
    const p = this.posture(useWorkspace)
    const serviceTier = serviceTierForModel(modelId)
    const params: ThreadStartParams = {
      model: modelId,
      cwd: p.cwd,
      approvalPolicy: p.approvalPolicy,
      sandbox: p.sandbox,
      config: await this.codexConfig(modelId),
      dynamicTools: CODEX_BROWSER_TOOLS,
      ...(serviceTier ? { serviceTier } : {}),
      ephemeral,
      // gladdis's identity for the thread. Without it, the codex CLI falls
      // back to its own default persona + global config (~/.codex), which
      // would leak an unrelated identity into gladdis chat.
      ...(system ? { developerInstructions: system } : {})
    }
    const res = (await requestWithOptimizationFallback(server, 'thread/start', params)) as {
      thread: { id: string }
    }
    const threadId = res.thread.id
    if (!ephemeral) this.remember(conversationId, threadId, useWorkspace)
    return threadId
  }

  /** Resume an existing persisted thread, refreshing its config + tools. */
  async resumeThread(
    conversationId: string,
    threadId: string,
    modelId: string,
    system?: string,
    useWorkspace = true
  ): Promise<string> {
    const server = await this.deps.ensureServer()
    const p = this.posture(useWorkspace)
    const serviceTier = serviceTierForModel(modelId)
    const params: ThreadResumeParams = {
      threadId,
      model: modelId,
      cwd: p.cwd,
      approvalPolicy: p.approvalPolicy,
      sandbox: p.sandbox,
      config: await this.codexConfig(modelId),
      dynamicTools: CODEX_BROWSER_TOOLS,
      ...(serviceTier ? { serviceTier } : {}),
      ...(system ? { developerInstructions: system } : {})
    }
    const res = (await requestWithOptimizationFallback(server, 'thread/resume', params)) as {
      thread: { id: string }
    }
    const resumedThreadId = res.thread.id
    this.remember(conversationId, resumedThreadId, useWorkspace)
    return resumedThreadId
  }

  remember(conversationId: string | null, threadId: string, useWorkspace = true): void {
    this.threads.set(this.threadKey(conversationId, useWorkspace), threadId)
    if (conversationId) this.deps.persistedThreads.set(conversationId, threadId)
  }

  forget(conversationId: string | null, threadId?: string, useWorkspace = true): void {
    const key = this.threadKey(conversationId, useWorkspace)
    if (!threadId || this.threads.get(key) === threadId) this.threads.delete(key)
    if (conversationId) this.deps.persistedThreads.set(conversationId, null)
  }

  private threadKey(conversationId: string | null, useWorkspace = true): string {
    return conversationId ? conversationId : `__ephemeral__:${useWorkspace ? 'workspace' : 'ambient'}`
  }

  /**
   * Build the per-thread Codex config: native web search disabled (we route
   * through gladdis tools), plus the model's service-tier preferences when
   * applicable.
   *
   * NOTE: only the top-level `web_search` knob is set. `tools.web_search` is
   * an untagged enum that rejects `null`, which would make thread/start fail
   * with "data did not match any variant of untagged enum
   * WebSearchToolConfigInput".
   */
  private async codexConfig(modelId?: string): Promise<{ [key: string]: JsonValue }> {
    const serviceTier = modelId ? serviceTierForModel(modelId) : null
    return {
      ...CODEX_DISABLED_NATIVE_CONFIG,
      ...(serviceTier
        ? {
            service_tier: serviceTier,
            ...(serviceTier === 'fast' ? { features: { fast_mode: true } } : {})
          }
        : {})
    }
  }
}
