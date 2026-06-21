import type {
  CdpCommand,
  CdpEventPayload,
  ExecResult,
  TabInfo,
  ViewBounds
} from './browser'
import type {
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
import type { PageCapture } from './extraction'
import type { ModelOption } from './models'

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
    onUpdated: (cb: (tabs: TabInfo[]) => void) => () => void
  }
  layout: {
    setBounds: (bounds: ViewBounds) => void
  }
  app: {
    capture: () => Promise<string>
  }
  cdp: {
    send: (cmd: CdpCommand) => Promise<unknown>
    onEvent: (cb: (e: CdpEventPayload) => void) => () => void
  }
  chat: {
    send: (req: ChatRequest) => void
    abort: (requestId: string) => void
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
  }
  audit: {
    /** Recent model calls, newest first. */
    list: () => Promise<ModelCallRecord[]>
    /** Live model call updates from the main-process ledger. */
    onEvent: (cb: (event: ModelCallEvent) => void) => () => void
  }
  chats: {
    /** Conversation headers, newest-updated first. */
    list: () => Promise<ConversationMeta[]>
    /** Full conversation (messages included), or null if missing. */
    get: (id: string) => Promise<Conversation | null>
    /** Upsert a conversation; returns its persisted form. */
    save: (conv: Conversation) => Promise<Conversation>
    /** Synchronous save for shutdown / handoff flushes. */
    saveSync: (conv: Conversation) => Conversation
    /** Delete a conversation by id. */
    delete: (id: string) => Promise<void>
    /** Id of the most recently updated conversation, or null. */
    lastActive: () => Promise<string | null>
    /** Generate and persist a short title for a saved conversation. */
    autoTitle: (id: string, modelId: string) => Promise<string | null>
    /** Explicit full-history search across saved chats. */
    search: (query: string, limit?: number) => Promise<ConversationSearchHit[]>
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
}
