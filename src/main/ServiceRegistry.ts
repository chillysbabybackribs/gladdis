import { BaseWindow } from 'electron'
import type { WebContentsView } from 'electron'
import { TabManager } from './TabManager'
import { KeyStore } from './models/KeyStore'
import { WorkspaceStore } from './fs/WorkspaceStore'
import { ChatStore } from './models/ChatStore'
import { AgentStore } from './models/AgentStore'
import { ChatService } from './models/ChatService'
import { PageExtractor } from './extract/PageExtractor'
import { BrowserTools } from './models/browserTools'
import { ModelCallLedger } from './models/ModelCallLedger'
import { AutoDreamScheduler } from './models/memory/AutoDreamScheduler'
import { IPC } from '../../shared/types'
import type { ChatStreamEvent } from '../../shared/types'
import type { PtyHost } from './terminal/PtyHost'
import { ChatStreamIpcBatcher } from './chatStreamIpcBatcher'

/**
 * Lazy service factory. Services are created on-demand to reduce startup memory
 * and time. Dependency order is enforced: tabs before extractor before tools.
 */
export class ServiceRegistry {
  private _tabs: TabManager | null = null
  private _keys: KeyStore | null = null
  private _chats: ChatStore | null = null
  private _agents: AgentStore | null = null
  private _audit: ModelCallLedger | null = null
  private _extractor: PageExtractor | null = null
  private _workspace: WorkspaceStore | null = null
  private _tools: BrowserTools | null = null
  private _chat: ChatService | null = null
  private _autoDream: AutoDreamScheduler | null = null
  private _ptyHost: PtyHost | null = null
  private readonly chatStreamListeners = new Set<(event: ChatStreamEvent) => void>()
  private readonly chatStreamBatcher = new ChatStreamIpcBatcher((event) => {
    if (!this.uiView.webContents.isDestroyed()) {
      this.uiView.webContents.send(IPC.CHAT_STREAM, event)
    }
  })

  constructor(
    private readonly win: BaseWindow,
    private readonly uiView: WebContentsView,
    private readonly onChange: () => void,
    private readonly onCdpEvent: (e: any) => void,
    private readonly captureAppWindowPng: () => Promise<string>
  ) {}

  get tabs(): TabManager {
    if (!this._tabs) {
      this._tabs = new TabManager(this.win, this.onChange, this.onCdpEvent)
    }
    return this._tabs
  }

  get keys(): KeyStore {
    if (!this._keys) {
      this._keys = new KeyStore()
    }
    return this._keys
  }

  get chats(): ChatStore {
    if (!this._chats) {
      this._chats = new ChatStore()
    }
    return this._chats
  }

  get agents(): AgentStore {
    if (!this._agents) {
      this._agents = new AgentStore((next) => {
        if (!this.uiView.webContents.isDestroyed()) {
          this.uiView.webContents.send(IPC.AGENTS_UPDATED, next)
        }
      })
    }
    return this._agents
  }

  get audit(): ModelCallLedger {
    if (!this._audit) {
      this._audit = new ModelCallLedger((event) => {
        if (!this.uiView.webContents.isDestroyed()) {
          this.uiView.webContents.send(IPC.AUDIT_EVENT, event)
        }
      })
    }
    return this._audit
  }

  get workspace(): WorkspaceStore {
    if (!this._workspace) {
      this._workspace = new WorkspaceStore()
    }
    return this._workspace
  }

  get extractor(): PageExtractor {
    if (!this._extractor) {
      this._extractor = new PageExtractor(this.tabs)
    }
    return this._extractor
  }

  get tools(): BrowserTools {
    if (!this._tools) {
      this._tools = new BrowserTools(this.tabs, this.extractor, this.chats, this.keys)
      this.tabs.setNavigationCacheInvalidator((tabId) => {
        this._tools!.clearPageCacheForTab(tabId)
      })
      this._tools.setWorkspaceRoot(this.workspace.get().folder)
      this._tools.setAppCapture(this.captureAppWindowPng)
    }
    return this._tools
  }

  get chat(): ChatService {
    if (!this._chat) {
      this._chat = new ChatService(
        this.keys,
        (e) => this.emitChatStream(e),
        this.tools,
        this.audit,
        this.chats,
        (e) => {
          if (!this.uiView.webContents.isDestroyed()) {
            this.uiView.webContents.send(IPC.DREAM_PROGRESS, e)
          }
        }
      )
      this._chat.setCodexFolder(this.workspace.get().folder)
    }
    return this._chat
  }

  subscribeChatStream(listener: (event: ChatStreamEvent) => void): () => void {
    this.chatStreamListeners.add(listener)
    return () => this.chatStreamListeners.delete(listener)
  }

  private emitChatStream(event: ChatStreamEvent): void {
    this.chatStreamBatcher.push(event)
    for (const listener of this.chatStreamListeners) listener(event)
  }

  get autoDream(): AutoDreamScheduler {
    if (!this._autoDream) {
      this._autoDream = new AutoDreamScheduler({
        dreamer: this.chat.getDreamerInstance(),
        chats: this.chats,
        getWorkspaceRoot: () => this.workspace.get().folder,
        notify: (event) => {
          if (!this.uiView.webContents.isDestroyed()) {
            this.uiView.webContents.send(IPC.DREAM_AUTO_NOTIFICATION, event)
          }
        }
      })
    }
    return this._autoDream
  }

  get ptyHost(): PtyHost | null {
    return this._ptyHost
  }

  setPtyHost(host: PtyHost): void {
    this._ptyHost = host
  }

  disposePtyHost(): void {
    this._ptyHost?.disposeAll()
  }
}
