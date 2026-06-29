import { app, BaseWindow, WebContentsView, ipcMain, dialog, desktopCapturer, screen } from 'electron'
import { attachContextMenu } from './contextMenu'
import { join } from 'path'
import { TabManager } from './TabManager'
import { KeyStore } from './models/KeyStore'
import { WorkspaceStore } from './fs/WorkspaceStore'
import { ChatStore } from './models/ChatStore'
import { ChatService } from './models/ChatService'
import { PageExtractor } from './extract/PageExtractor'
import { BrowserTools } from './models/browserTools'
import { ModelCallLedger } from './models/ModelCallLedger'
import { synthesizeSpeech } from './models/tts'
import { broadcastCdpEvent } from './pipeline/activeRunners'
import { registerTerminalIpc, sendIfLive } from './terminal'
import type { PtyHost } from './terminal/PtyHost'
import installExtension, {
  REACT_DEVELOPER_TOOLS
} from 'electron-devtools-installer'
import {
  IPC,
  type CdpCommand,
  type ChatPanelSide,
  type ChatRequest,
  type Conversation,
  type DreamRunRequest,
  type Provider,
  type ViewBounds
} from '../../shared/types'

let win: BaseWindow
let uiView: WebContentsView
let tabs: TabManager
let keys: KeyStore
let chats: ChatStore
let chat: ChatService
let extractor: PageExtractor
let audit: ModelCallLedger
let workspace: WorkspaceStore
let tools: BrowserTools
let ptyHost: PtyHost

const isDev = !!process.env.ELECTRON_RENDERER_URL
const trustLocalCertificates = process.env.GLADDIS_TRUST_LOCAL_CERTS === '1'
const extraTrustedHosts = new Set(
  (process.env.GLADDIS_TRUSTED_LOCAL_CERT_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
)
const trustedLocalCertHosts = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  ...extraTrustedHosts
])

/**
 * Remote debugging port — exposes the whole CDP surface of gladdis's Chromium
 * over a localhost WebSocket so external tools (Puppeteer/Playwright,
 * chrome://inspect, a CLI) can attach. OFF by default: a live remote-debugging
 * endpoint is an externally-attachable automation surface that bot walls (e.g.
 * Google's "this browser may not be secure" login check) flag, and gladdis drives
 * its own tabs through webContents.debugger anyway, so it isn't needed for normal
 * use. Opt in by setting GLADDIS_REMOTE_DEBUG to a port (e.g. "9222").
 *
 * Must be configured BEFORE app.whenReady(), hence at module top level.
 *
 * Conflict note: Chromium allows one command client per target. gladdis's own
 * tabs are already driven by CDPSession (webContents.debugger), so an external
 * client should only *inspect* those — to *drive*, open a fresh tab via the
 * port (Puppeteer's newPage / Target.createTarget); gladdis never attaches to
 * tabs it didn't create, so those stay conflict-free.
 */
const remoteDebug = process.env.GLADDIS_REMOTE_DEBUG ?? 'off'
if (!['0', 'off', 'none', 'false'].includes(remoteDebug.toLowerCase())) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebug)
  // Bind the DevTools endpoint to loopback only — never expose it on the LAN.
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  // Chromium 111+ refuses WS upgrades unless the Origin is explicitly allowed.
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1:' + remoteDebug)
  console.log(`[gladdis] remote debugging on http://127.0.0.1:${remoteDebug}`)
}

// Avoid exposing the obvious Selenium/WebDriver fingerprint on login pages that
// block on embedded-automation surfaces.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

if (trustLocalCertificates) {
  // Let localhost / local network admin cert flows through for dev and internal
  // staging URLs while we avoid a full browser-wide trust override.
  app.commandLine.appendSwitch('allow-insecure-localhost')
  app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
    if (isTrustedLocalCertificateHost(url)) {
      event.preventDefault()
      callback(true)
      return
    }
    callback(false)
  })
}

function isTrustedLocalCertificateHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return trustedLocalCertHosts.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

function createWindow(): void {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#181818',
    title: 'gladdis'
  })

  // Root UI view: the React chat + tabstrip. Fills the whole window;
  // browser tab views are layered ON TOP, clipped to the right pane.
  uiView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Audible replies play seconds after the send click, by which point
      // Chromium's default user-gesture requirement has lapsed and would block
      // the <audio> silently. This is a trusted local UI, so allow autoplay.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  attachContextMenu(uiView.webContents)
  win.contentView.addChildView(uiView)

  const fit = () => {
    const { width, height } = win.getContentBounds()
    uiView.setBounds({ x: 0, y: 0, width, height })
  }
  fit()
  win.on('resize', fit)

  if (isDev) {
    void uiView.webContents.loadURL(process.env.ELECTRON_RENDERER_URL!)
    uiView.webContents.openDevTools({ mode: 'detach' })
  } else {
    void uiView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const pushTabs = () => {
    if (uiView.webContents.isDestroyed()) return
    uiView.webContents.send(IPC.TABS_UPDATED, tabs.snapshot())
  }

  tabs = new TabManager(
    win,
    pushTabs,
    (e) => {
      // Forward CDP events to active pipeline Runner(s) for the tab that changed.
      // Supports concurrent turns from two chat panels with bounded overhead.
      broadcastCdpEvent(e)
      if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.CDP_EVENT, e)
    }
  )

  keys = new KeyStore()
  chats = new ChatStore()
  audit = new ModelCallLedger((event) => {
    if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.AUDIT_EVENT, event)
  })
  extractor = new PageExtractor(tabs)
  workspace = new WorkspaceStore()
  tools = new BrowserTools(tabs, extractor, chats, keys)
  tabs.setNavigationCacheInvalidator((tabId) => {
    tools.clearPageCacheForTab(tabId)
  })
  // Apply the persisted working folder so fs tools resolve relative paths there.
  tools.setWorkspaceRoot(workspace.get().folder)
  // Wire the app-window capture (the root UI view lives here in main) so the
  // screenshot_app tool can grab the whole window — same source the old composer
  // "Screenshot App" button used (IPC.APP_CAPTURE), now a deterministic tool.
  tools.setAppCapture(captureAppWindowPng)
  chat = new ChatService(
    keys,
    (e) => {
      if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.CHAT_STREAM, e)
    },
    tools,
    audit,
    chats,
    (e) => {
      if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.DREAM_PROGRESS, e)
    }
  )
  // Seed Codex with the same persisted folder so its shell/cwd matches the fs
  // tools after a restart, not just after the user re-picks (constructed here
  // because chat must exist first).
  chat.setCodexFolder(workspace.get().folder)

  registerIpc()

  // Open the homepage so gladdis always starts with exactly one browser tab.
  tabs.ensureInitialTab()
}

async function captureAppWindowPng(): Promise<string> {
  const targetMediaSourceId = win?.getMediaSourceId()
  if (win && targetMediaSourceId) {
    try {
      const bounds = win.getBounds()
      const display = screen.getDisplayMatching(bounds)
      const scaleFactor = display.scaleFactor || 1
      const thumbnailSize = {
        width: Math.max(1, Math.round(bounds.width * scaleFactor)),
        height: Math.max(1, Math.round(bounds.height * scaleFactor))
      }
      const targetKey = targetMediaSourceId.split(':').slice(0, 2).join(':')
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize,
        fetchWindowIcons: false
      })
      const source =
        sources.find((candidate) => candidate.id === targetMediaSourceId) ??
        sources.find((candidate) => candidate.id.split(':').slice(0, 2).join(':') === targetKey) ??
        sources.find((candidate) => candidate.name === win.getTitle())
      const thumbnail = source?.thumbnail
      if (thumbnail && !thumbnail.isEmpty()) {
        return `data:image/png;base64,${thumbnail.toPNG().toString('base64')}`
      }
    } catch (error) {
      console.warn('[screenshot_app] desktopCapturer full-window capture failed:', error)
    }
  }

  if (!uiView || uiView.webContents.isDestroyed()) return ''
  const nativeImage = await uiView.webContents.capturePage()
  return `data:image/png;base64,${nativeImage.toPNG().toString('base64')}`
}

function registerIpc(): void {
  ipcMain.handle(IPC.TAB_CREATE, (_e, url?: string) => tabs.create(url))
  ipcMain.handle(IPC.TAB_CLOSE, (_e, id: string) => tabs.close(id))
  ipcMain.handle(IPC.TAB_SWITCH, (_e, id: string) => tabs.switch(id))
  ipcMain.handle(IPC.TAB_NAVIGATE, (_e, id: string, url: string) => tabs.navigate(id, url))
  ipcMain.handle(IPC.TAB_BACK, (_e, id: string) => tabs.back(id))
  ipcMain.handle(IPC.TAB_FORWARD, (_e, id: string) => tabs.forward(id))
  ipcMain.handle(IPC.TAB_RELOAD, (_e, id: string) => tabs.reload(id))
  ipcMain.handle(IPC.TAB_REORDER, (_e, id: string, toIndex: number) => tabs.reorder(id, toIndex))
  ipcMain.handle(IPC.TAB_LIST, () => tabs.list())
  ipcMain.handle(IPC.TAB_CAPTURE, async (_e, id: string) => {
    const base64 = await tabs.capturePagePng(id)
    return `data:image/png;base64,${base64}`
  })
  ipcMain.handle(IPC.APP_CAPTURE, () => captureAppWindowPng())
  ipcMain.on(IPC.LAYOUT_SET_BOUNDS, (_e, bounds: ViewBounds) => tabs.setBounds(bounds))
  ipcMain.handle(IPC.CDP_SEND, (_e, cmd: CdpCommand) =>
    tabs.cdpSend(cmd.tabId, cmd.method, cmd.params)
  )

  // Chat / models
  ipcMain.on(IPC.CHAT_SEND, (_e, req: ChatRequest) => void chat.send(req))
  ipcMain.on(IPC.CHAT_ABORT, (_e, requestId: string) => chat.abort(requestId))
  ipcMain.handle(IPC.KEYS_STATUS, () => keys.status())
  ipcMain.handle(IPC.KEYS_SET, (_e, provider: Provider, key: string) => keys.set(provider, key))

  // Text-to-speech for audible replies (opt-in via the composer toggle). Reads
  // text the model already produced; independent of chat/Codex generation.
  ipcMain.handle(IPC.TTS_SPEAK, (_e, text: string, voice?: string) =>
    synthesizeSpeech(keys, text, voice)
  )

  // Codex (local app-server) status. The Codex working folder is no longer set
  // here — it follows the single workspace folder (see setWorkspaceFolder below).
  ipcMain.handle(IPC.CODEX_STATUS, () => chat.codexStatus())
  ipcMain.handle(IPC.CODEX_MODELS, () => chat.codexModels())

  // Working folder: the single "work from here" choice. One picker drives both
  // routes — gladdis's own fs tools (relative-path root) AND Codex's starting cwd
  // (where its shell runs, what its pwd reports). Without the Codex half, the
  // header folder set fs-tool paths but Codex's shell still ran in homedir, so
  // `pwd` answered the home dir instead of the chosen folder.
  const setWorkspaceFolder = (folder: string | null) => {
    const ws = workspace.setFolder(folder)
    tools.setWorkspaceRoot(ws.folder)
    chat.setCodexFolder(ws.folder)
    return ws
  }
  ipcMain.handle(IPC.WORKSPACE_GET, () => workspace.get())
  ipcMain.handle(IPC.WORKSPACE_SET_FOLDER, (_e, folder: string | null) => setWorkspaceFolder(folder))
  ipcMain.handle(IPC.WORKSPACE_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a folder to work from',
      defaultPath: workspace.get().folder ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use folder'
    })
    if (result.canceled || result.filePaths.length === 0) return workspace.get()
    return setWorkspaceFolder(result.filePaths[0])
  })

  ipcMain.handle(IPC.AUDIT_LIST, () => audit.list())

  // Chat history persistence. Both panels persist independently and each
  // restores its own side on launch, so the optional `panel` arg is what
  // keeps left and right chats from ever appearing on the wrong side.
  ipcMain.handle(IPC.CHATS_LIST, (_e, panel?: ChatPanelSide) => chats.list(panel))
  ipcMain.handle(IPC.CHATS_GET, (_e, id: string) => chats.get(id))
  ipcMain.handle(IPC.CHATS_SAVE, (_e, conv: Conversation) => chats.save(conv))
  ipcMain.on(IPC.CHATS_SAVE_SYNC, (e, conv: Conversation) => {
    e.returnValue = chats.save(conv)
  })
  ipcMain.handle(IPC.CHATS_DELETE, (_e, id: string) => chats.delete(id))
  ipcMain.handle(IPC.CHATS_LAST_ACTIVE, (_e, panel?: ChatPanelSide) => chats.lastActive(panel))
  ipcMain.handle(IPC.CHATS_TITLE, async (_e, id: string, modelId: string) => {
    const conv = chats.get(id)
    if (!conv) return null
    const title = await chat.generateTitle(
      modelId,
      conv.messages.map((m) => ({ role: m.role, text: m.text }))
    )
    if (title) chats.setTitle(id, title)
    return title
  })
  ipcMain.handle(
    IPC.CHATS_SEARCH,
    (_e, query: string, limit?: number, panel?: ChatPanelSide) => chats.search(query, limit, panel)
  )

  // Deep page extraction (perception layer)
  ipcMain.handle(IPC.EXTRACT_RUN, (_e, tabId: string) => extractor.run(tabId))
  ipcMain.handle(IPC.EXTRACT_OVERLAY, (_e, tabId: string, on: boolean) =>
    extractor.overlay(tabId, on)
  )

  // Exec bridge: run JS inside a tab's page context, structured result back.
  ipcMain.handle(IPC.BROWSER_EXEC, (_e, tabId: string, jsCode: string) =>
    tabs.executeJavaScript(tabId, jsCode)
  )

  // Memory "Dreaming" — the manual-trigger background memory curator. The
  // pipeline lives in ChatService so it can reuse its provider-agnostic
  // complete() and the live Codex catalog without duplicating those plumbing
  // concerns here.
  ipcMain.handle(IPC.DREAM_RUN, (_e, req: DreamRunRequest) => chat.dreamRun(req))
  ipcMain.handle(IPC.DREAM_LOAD_LAST, (_e, workspaceRoot: string) =>
    chat.dreamLoadLast(workspaceRoot)
  )
  ipcMain.handle(IPC.DREAM_ADOPT, (_e, workspaceRoot: string) => chat.dreamAdopt(workspaceRoot))
  ipcMain.handle(IPC.DREAM_DISCARD, (_e, workspaceRoot: string) =>
    chat.dreamDiscard(workspaceRoot)
  )
  ipcMain.handle(IPC.DREAM_STATUS, (_e, workspaceRoot: string) =>
    chat.dreamStatus(workspaceRoot)
  )

  // Real PTY terminal — the human's interactive shell, separate from any
  // tool-loop shell access the model already has. Defaults its cwd to the
  // user-chosen workspace folder so the three "where am I" answers
  // (terminal, Codex shell, fs tools) all line up.
  ptyHost = registerTerminalIpc(
    () => workspace.get().folder,
    (channel, payload) => sendIfLive(uiView.webContents, channel, payload)
  )
}

app.whenReady().then(async () => {
  await TabManager.ensureSession()
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true') {
    try {
      const name = await installExtension(REACT_DEVELOPER_TOOLS)
      console.log(`Added Extension:  ${name}`)
    } catch (err) {
      console.log('An error occurred: ', err)
    }
  }
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Kill every live shell so we don't orphan PTY processes when the app exits.
  ptyHost?.disposeAll()
})
