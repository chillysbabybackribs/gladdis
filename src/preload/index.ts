import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type CdpCommand,
  type CdpEventPayload,
  type ChatPanelSide,
  type ChatRequest,
  type ChatStreamEvent,
  type Conversation,
  type GladdisApi,
  type ModelCallEvent,
  type Provider,
  type TabInfo,
  type TabsUpdatedState,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalSpawnOpts,
  type ViewBounds
} from '../../shared/types'

const api: GladdisApi = {
  tabs: {
    create: (url) => ipcRenderer.invoke(IPC.TAB_CREATE, url),
    close: (id) => ipcRenderer.invoke(IPC.TAB_CLOSE, id),
    switch: (id) => ipcRenderer.invoke(IPC.TAB_SWITCH, id),
    navigate: (id, url) => ipcRenderer.invoke(IPC.TAB_NAVIGATE, id, url),
    back: (id) => ipcRenderer.invoke(IPC.TAB_BACK, id),
    forward: (id) => ipcRenderer.invoke(IPC.TAB_FORWARD, id),
    reload: (id) => ipcRenderer.invoke(IPC.TAB_RELOAD, id),
    reorder: (id, toIndex) => ipcRenderer.invoke(IPC.TAB_REORDER, id, toIndex),
    list: () => ipcRenderer.invoke(IPC.TAB_LIST),
    capture: (id) => ipcRenderer.invoke(IPC.TAB_CAPTURE, id),
    onUpdated: (cb: (state: TabsUpdatedState) => void) => {
      const listener = (_e: unknown, state: TabsUpdatedState) => cb(state)
      ipcRenderer.on(IPC.TABS_UPDATED, listener)
      return () => ipcRenderer.removeListener(IPC.TABS_UPDATED, listener)
    }
  },
  layout: {
    setBounds: (bounds: ViewBounds) => ipcRenderer.send(IPC.LAYOUT_SET_BOUNDS, bounds)
  },
  app: {
    capture: () => ipcRenderer.invoke(IPC.APP_CAPTURE)
  },
  cdp: {
    send: (cmd: CdpCommand) => ipcRenderer.invoke(IPC.CDP_SEND, cmd),
    onEvent: (cb: (e: CdpEventPayload) => void) => {
      const listener = (_e: unknown, payload: CdpEventPayload) => cb(payload)
      ipcRenderer.on(IPC.CDP_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.CDP_EVENT, listener)
    }
  },
  chat: {
    send: (req: ChatRequest) => ipcRenderer.send(IPC.CHAT_SEND, req),
    abort: (requestId: string) => ipcRenderer.send(IPC.CHAT_ABORT, requestId),
    onStream: (cb: (e: ChatStreamEvent) => void) => {
      const listener = (_e: unknown, payload: ChatStreamEvent) => cb(payload)
      ipcRenderer.on(IPC.CHAT_STREAM, listener)
      return () => ipcRenderer.removeListener(IPC.CHAT_STREAM, listener)
    }
  },
  keys: {
    status: () => ipcRenderer.invoke(IPC.KEYS_STATUS),
    set: (provider: Provider, key: string) => ipcRenderer.invoke(IPC.KEYS_SET, provider, key)
  },
  tts: {
    speak: (text: string, voice?: string) => ipcRenderer.invoke(IPC.TTS_SPEAK, text, voice)
  },
  codex: {
    status: () => ipcRenderer.invoke(IPC.CODEX_STATUS),
    models: () => ipcRenderer.invoke(IPC.CODEX_MODELS)
  },
  workspace: {
    get: () => ipcRenderer.invoke(IPC.WORKSPACE_GET),
    setFolder: (folder: string | null) => ipcRenderer.invoke(IPC.WORKSPACE_SET_FOLDER, folder),
    pickFolder: () => ipcRenderer.invoke(IPC.WORKSPACE_PICK_FOLDER)
  },
  audit: {
    list: () => ipcRenderer.invoke(IPC.AUDIT_LIST),
    onEvent: (cb: (event: ModelCallEvent) => void) => {
      const listener = (_e: unknown, event: ModelCallEvent) => cb(event)
      ipcRenderer.on(IPC.AUDIT_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.AUDIT_EVENT, listener)
    }
  },
  chats: {
    list: (panel?: ChatPanelSide) => ipcRenderer.invoke(IPC.CHATS_LIST, panel),
    get: (id: string) => ipcRenderer.invoke(IPC.CHATS_GET, id),
    save: (conv: Conversation) => ipcRenderer.invoke(IPC.CHATS_SAVE, conv),
    saveSync: (conv: Conversation) => ipcRenderer.sendSync(IPC.CHATS_SAVE_SYNC, conv),
    delete: (id: string) => ipcRenderer.invoke(IPC.CHATS_DELETE, id),
    lastActive: (panel?: ChatPanelSide) => ipcRenderer.invoke(IPC.CHATS_LAST_ACTIVE, panel),
    autoTitle: (id: string, modelId: string) => ipcRenderer.invoke(IPC.CHATS_TITLE, id, modelId),
    search: (query: string, limit?: number, panel?: ChatPanelSide) =>
      ipcRenderer.invoke(IPC.CHATS_SEARCH, query, limit, panel)
  },
  extract: {
    run: (tabId: string) => ipcRenderer.invoke(IPC.EXTRACT_RUN, tabId),
    overlay: (tabId: string, on: boolean) => ipcRenderer.invoke(IPC.EXTRACT_OVERLAY, tabId, on)
  },
  browser: {
    exec: (tabId: string, jsCode: string) => ipcRenderer.invoke(IPC.BROWSER_EXEC, tabId, jsCode)
  },
  terminal: {
    create: (opts: TerminalSpawnOpts) => ipcRenderer.invoke(IPC.TERMINAL_CREATE, opts),
    write: (id: string, data: string) => ipcRenderer.send(IPC.TERMINAL_WRITE, id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.TERMINAL_RESIZE, id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke(IPC.TERMINAL_KILL, id),
    setCwd: (id: string, folder: string) => ipcRenderer.send(IPC.TERMINAL_SET_CWD, id, folder),
    onData: (cb: (e: TerminalDataEvent) => void) => {
      const listener = (_e: unknown, payload: TerminalDataEvent) => cb(payload)
      ipcRenderer.on(IPC.TERMINAL_DATA, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, listener)
    },
    onExit: (cb: (e: TerminalExitEvent) => void) => {
      const listener = (_e: unknown, payload: TerminalExitEvent) => cb(payload)
      ipcRenderer.on(IPC.TERMINAL_EXIT, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, listener)
    }
  }
}

contextBridge.exposeInMainWorld('gladdis', api)
