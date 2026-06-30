import type {
  CdpCommand,
  CdpEventPayload,
  ExecResult,
  TabInfo,
  TabsUpdatedState,
  ViewBounds
} from './browser'
import type { AppCommand } from './appCommand'
import type {
  ChatPanelSide,
  ChatInterjectionRequest,
  ChatRequest,
  ChatStreamEvent,
  CodexStatus,
  Conversation,
  ConversationMeta,
  ConversationSearchHit,
  KeyStatus,
  ModelCallEvent,
  ModelCallRecord,
  Provider,
  TtsResult,
  Workspace
} from './chat'
import type {
  OptimizeAgentInput,
  OptimizeAgentResult,
  SavedAgent,
  SaveAgentInput,
} from './agents'
import type {
  DreamAdoptResult,
  DreamAdoptSelection,
  DreamAutoConfig,
  DreamAutoNotification,
  DreamAutoStatus,
  DreamDiff,
  DreamDiscardResult,
  DreamHistoryFile,
  DreamProgressEvent,
  DreamRunRequest,
  DreamRunResult,
  DreamStatus
} from './dream'
import type { PageCapture } from './extraction'
import type { ModelOption } from './models'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSpawnOpts
} from './terminal'

export interface GladdisApi {
  tabs: {
    create: (url?: string) => Promise<TabInfo>
    close: (id: string) => Promise<void>
    switch: (id: string) => Promise<void>
    navigate: (id: string, url: string) => Promise<void>
    back: (id: string) => Promise<void>
    forward: (id: string) => Promise<void>
    reload: (id: string) => Promise<void>
    reorder: (id: string, toIndex: number) => Promise<void>
    list: () => Promise<TabInfo[]>
    capture: (id: string) => Promise<string>
    onUpdated: (cb: (state: TabsUpdatedState) => void) => () => void
  }
  layout: {
    setBounds: (bounds: ViewBounds) => void
    setBrowserVisible: (visible: boolean) => void
  }
  app: {
    capture: () => Promise<string>
    /** Native menu and main-process commands routed into the renderer UI. */
    onCommand: (cb: (command: AppCommand) => void) => () => void
  }
  cdp: {
    send: (cmd: CdpCommand) => Promise<unknown>
    onEvent: (cb: (e: CdpEventPayload) => void) => () => void
  }
  chat: {
    send: (req: ChatRequest) => void
    /**
     * Add user context to an in-flight agentic task. It is consumed at the
     * next provider iteration boundary, optionally after interrupting the
     * current work and automatically continuing with that context.
     */
    interject: (req: ChatInterjectionRequest) => void
    abort: (requestId: string) => void
    /**
     * Pause an in-flight agentic task at the next iteration boundary. The
     * model stream currently being consumed finishes normally; the loop then
     * holds before starting the next iteration. Safe no-op if the request is
     * unknown or has already completed. Pause is not supported for Codex
     * (the local app-server owns its own loop) — the renderer hides the
     * button for that provider.
     */
    pause: (requestId: string) => void
    /**
     * Resume a previously-paused task. The agent loop continues from the
     * exact iteration it was holding at, with all messages/tool history
     * preserved. Safe no-op if the request is unknown or wasn't paused.
     */
    resume: (requestId: string) => void
    onStream: (cb: (e: ChatStreamEvent) => void) => () => void
  }
  keys: {
    status: () => Promise<KeyStatus>
    set: (provider: Provider, key: string) => Promise<KeyStatus>
  }
  tts: {
    /** Synthesize speech for reply text (audible replies); `voice` is an OpenAI voice id. */
    speak: (text: string, voice?: string) => Promise<TtsResult>
  }
  codex: {
    /** Install + auth status of the local Codex CLI. */
    status: () => Promise<CodexStatus>
    /** Live model catalog from the CLI's app-server ([] if unreachable). */
    models: () => Promise<ModelOption[]>
  }
  workspace: {
    /** The folder gladdis currently works from. */
    get: () => Promise<Workspace>
    /** Set the working folder (null => clear, resolve against cwd). */
    setFolder: (folder: string | null) => Promise<Workspace>
    /** Open a native folder picker; returns the updated workspace. */
    pickFolder: () => Promise<Workspace>
    /** Create a folder, then use it as the working folder. */
    createFolder: (folder: string) => Promise<Workspace>
    /** Live updates when the working folder changes outside this renderer path. */
    onUpdated: (cb: (workspace: Workspace) => void) => () => void
  }
  audit: {
    /** Recent model calls, newest first. */
    list: () => Promise<ModelCallRecord[]>
    /** Live model call updates from the main-process ledger. */
    onEvent: (cb: (event: ModelCallEvent) => void) => () => void
  }
  agents: {
    /** Saved custom agents, newest-updated first. */
    list: () => Promise<SavedAgent[]>
    /**
     * Turn a rough agent goal into a reusable agent blueprint for execution.
     *
     * Supports optional quick and deep optimization modes; deep mode performs
     * richer workspace discovery before distillation.
     */
    optimize: (input: OptimizeAgentInput) => Promise<OptimizeAgentResult>
    /** Create or update a saved custom agent. */
    save: (input: SaveAgentInput) => Promise<SavedAgent>
    /** Delete a saved custom agent. */
    delete: (id: string) => Promise<void>
    /** Live updates when the saved-agent registry changes. */
    onUpdated: (cb: (agents: SavedAgent[]) => void) => () => void
  }
  chats: {
    /** Conversation headers, newest-updated first; pass a panel to scope by side. */
    list: (panel?: ChatPanelSide) => Promise<ConversationMeta[]>
    /** Full conversation (messages included), or null if missing. */
    get: (id: string) => Promise<Conversation | null>
    /** Upsert a conversation; returns its persisted form. */
    save: (conv: Conversation) => Promise<Conversation>
    /** Synchronous save for shutdown / handoff flushes. */
    saveSync: (conv: Conversation) => Conversation
    /** Delete a conversation by id. */
    delete: (id: string) => Promise<void>
    /** Id of the most recently updated conversation for `panel`, or null. */
    lastActive: (panel?: ChatPanelSide) => Promise<string | null>
    /** Generate and persist a short title for a saved conversation. */
    autoTitle: (id: string, modelId: string) => Promise<string | null>
    /** Explicit full-history search across saved chats, optionally scoped to a side. */
    search: (
      query: string,
      limit?: number,
      panel?: ChatPanelSide
    ) => Promise<ConversationSearchHit[]>
  }
  extract: {
    /** Deeply extract the page in a tab (deterministic, CDP-driven). */
    run: (tabId: string) => Promise<PageCapture>
    /** Toggle the on-page visual overlay highlighting the action surface. */
    overlay: (tabId: string, on: boolean) => Promise<number>
  }
  browser: {
    /** Run JS inside a tab's page context. */
    exec: (tabId: string, jsCode: string) => Promise<ExecResult>
  }
  dream: {
    /**
     * Run the memory-dreaming pipeline against the current workspace. Produces
     * a candidate `memory.next.json` and returns its structured diff; the
     * candidate is not promoted until adopt() is called.
     */
    run: (req: DreamRunRequest) => Promise<DreamRunResult>
    /** Load the last awaiting-adopt diff for this workspace, if any. */
    loadLast: (workspaceRoot: string) => Promise<DreamDiff | null>
    /**
     * Atomically promote memory.next.json → memory.json.
     *
     * Pass a `selection` to cherry-pick rows: unselected diff or hygiene rows
     * fall back to whatever was in live memory before the dream. Omit it to
     * keep the legacy full-adopt behavior.
     */
    adopt: (
      workspaceRoot: string,
      selection?: DreamAdoptSelection
    ) => Promise<DreamAdoptResult>
    /** Remove memory.next.json (and the audit) without changing live memory. */
    discard: (workspaceRoot: string) => Promise<DreamDiscardResult>
    /** Is a dream currently running? At most one per workspace. */
    status: (workspaceRoot: string) => Promise<DreamStatus>
    /** Subscribe to stage-by-stage progress; returns an unsubscribe fn. */
    onProgress: (cb: (event: DreamProgressEvent) => void) => () => void
    /**
     * Auto-Dream scheduler — Anthropic-calibrated 24h + 5-session dual gate
     * with strict auto-adopt. Off by default; users opt in via setConfig.
     */
    auto: {
      /** Read the persisted scheduler config for a workspace. */
      getConfig: (workspaceRoot: string) => Promise<DreamAutoConfig>
      /** Update the config and persist; returns the canonical merged value. */
      setConfig: (
        workspaceRoot: string,
        patch: Partial<DreamAutoConfig>
      ) => Promise<DreamAutoConfig>
      /** Live scheduler state (gate counters, last skip reason, etc.). */
      status: (workspaceRoot: string) => Promise<DreamAutoStatus>
      /** Reset the activity-cooldown timer; called on user activity. */
      nudge: (workspaceRoot: string) => void
      /** One-shot when an auto-dream completes; renderer renders as toast. */
      onNotification: (cb: (event: DreamAutoNotification) => void) => () => void
    }
    /** Rolling history of past dream runs (manual + auto), newest first. */
    history: {
      list: (workspaceRoot: string) => Promise<DreamHistoryFile>
    }
  }
  terminal: {
    /** Spawn a new PTY session and return its id (one shell per id). */
    create: (opts: TerminalSpawnOpts) => Promise<TerminalInfo>
    /** Send keystrokes / raw bytes into the PTY's stdin. */
    write: (id: string, data: string) => void
    /** Resize the PTY (FitAddon-driven, fires on dock or window resize). */
    resize: (id: string, cols: number, rows: number) => void
    /** Kill the shell process and release the PTY. */
    kill: (id: string) => Promise<void>
    /** Convenience: `cd <folder>` inside the running shell. */
    setCwd: (id: string, folder: string) => void
    /** Stream of ANSI bytes from the PTY (xterm.write consumes directly). */
    onData: (cb: (e: TerminalDataEvent) => void) => () => void
    /** Fires once when the shell exits or is killed. */
    onExit: (cb: (e: TerminalExitEvent) => void) => () => void
  }
}
