import {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  dialog,
  desktopCapturer,
  screen,
  Menu,
  type MenuItemConstructorOptions
} from 'electron'
import { attachContextMenu } from './contextMenu'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { mkdir } from 'fs/promises'
import { TabManager } from './TabManager'
import { KeyStore } from './models/KeyStore'
import { WorkspaceStore } from './fs/WorkspaceStore'
import { ChatStore } from './models/ChatStore'
import { AgentStore } from './models/AgentStore'
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
  type AppCommand,
  type CdpCommand,
  type ChatInterjectionRequest,
  type ChatPanelSide,
  type ChatRequest,
  type Conversation,
  type DreamAutoConfig,
  type DreamRunRequest,
  type OptimizeAgentInput,
  type Provider,
  type SaveAgentInput,
  type ViewBounds,
  MODELS
} from '../../shared/types'
import { AutoDreamScheduler } from './models/memory/AutoDreamScheduler'
import { loadDreamHistory } from './models/memory/dreamHistory'
import { ServiceRegistry } from './ServiceRegistry'

let win: BaseWindow
let uiView: WebContentsView
let registry: ServiceRegistry

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

function applyWorkspaceFolder(folder: string | null) {
  const previous = registry.workspace.get().folder
  const ws = registry.workspace.setFolder(folder)
  registry.tools.setWorkspaceRoot(ws.folder)
  registry.chat.setCodexFolder(ws.folder)
  if (previous && previous !== ws.folder) registry.autoDream.stop(previous)
  if (ws.folder) void registry.autoDream.start(ws.folder)
  if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.WORKSPACE_UPDATED, ws)
  return ws
}

async function createAndUseWorkspaceFolder(folder: string) {
  const target = resolve(folder.trim())
  await mkdir(target, { recursive: true })
  return applyWorkspaceFolder(target)
}

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

  // A single navigation fires a burst of WebContents events (did-start-navigation,
  // did-start-loading, page-title-updated, did-navigate, did-stop-loading, …),
  // each calling onChange. Coalesce that burst into one trailing send per tick so
  // we rebuild the snapshot (native getters per tab) and serialize over IPC once,
  // not ~6×. A microtask flushes before any I/O, so the tabstrip stays in sync.
  let pushQueued = false
  const pushTabs = () => {
    if (pushQueued) return
    pushQueued = true
    queueMicrotask(() => {
      pushQueued = false
      if (uiView.webContents.isDestroyed()) return
      uiView.webContents.send(IPC.TABS_UPDATED, registry.tabs.snapshot())
    })
  }

  registry = new ServiceRegistry(
    win,
    uiView,
    pushTabs,
    (e) => {
      // Forward CDP events to active pipeline Runner(s) for the tab that changed.
      // Supports concurrent turns from two chat panels with bounded overhead.
      broadcastCdpEvent(e)
      if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.CDP_EVENT, e)
    },
    captureAppWindowPng
  )

  // Start watching whichever workspace was open on launch (no-op if none).
  // Access via registry triggers lazy initialization of dependent services.
  void (async () => {
    const folder = registry.workspace.get().folder
    if (folder) await registry.autoDream.start(folder)
  })()

  registerIpc()
  registerApplicationMenu()

  // Open the homepage so gladdis always starts with exactly one browser tab.
  registry.tabs.ensureInitialTab()
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
  ipcMain.handle(IPC.TAB_CREATE, (_e, url?: string) => registry.tabs.create(url))
  ipcMain.handle(IPC.TAB_CLOSE, (_e, id: string) => registry.tabs.close(id))
  ipcMain.handle(IPC.TAB_SWITCH, (_e, id: string) => registry.tabs.switch(id))
  ipcMain.handle(IPC.TAB_NAVIGATE, (_e, id: string, url: string) =>
    // URL-bar input is the ONE place we want the "type words → DDG SERP, type
    // bare host → https://host" smart-input rewrite. Every other navigate path
    // (tool calls, search auto-navigate, deep-search probes) goes through the
    // strict ensureNavigableUrl validation by default.
    registry.tabs.navigate(id, url, { smartAddressBarInput: true })
  )
  ipcMain.handle(IPC.TAB_BACK, (_e, id: string) => registry.tabs.back(id))
  ipcMain.handle(IPC.TAB_FORWARD, (_e, id: string) => registry.tabs.forward(id))
  ipcMain.handle(IPC.TAB_RELOAD, (_e, id: string) => registry.tabs.reload(id))
  ipcMain.handle(IPC.TAB_REORDER, (_e, id: string, toIndex: number) => registry.tabs.reorder(id, toIndex))
  ipcMain.handle(IPC.TAB_LIST, () => registry.tabs.list())
  ipcMain.handle(IPC.TAB_CAPTURE, async (_e, id: string) => {
    const base64 = await registry.tabs.capturePagePng(id)
    return `data:image/png;base64,${base64}`
  })
  ipcMain.handle(IPC.APP_CAPTURE, () => captureAppWindowPng())
  ipcMain.on(IPC.LAYOUT_SET_BOUNDS, (_e, bounds: ViewBounds) => registry.tabs.setBounds(bounds))
  ipcMain.on(IPC.LAYOUT_SET_BROWSER_VISIBLE, (_e, visible: boolean) =>
    registry.tabs.setBrowserVisible(visible)
  )
  ipcMain.on(IPC.BROWSER_SET_ZOOM, (_e, factor: number) => registry.tabs.setZoomFactor(factor))
  ipcMain.handle(IPC.CDP_SEND, (_e, cmd: CdpCommand) =>
    registry.tabs.cdpSend(cmd.tabId, cmd.method, cmd.params)
  )

  // Chat / models
  ipcMain.on(IPC.CHAT_SEND, (_e, req: ChatRequest) => {
    const folder = registry.workspace.get().folder
    if (folder) registry.autoDream.nudge(folder)
    // Pre-warm Cursor MCP bridge when a Cursor model with browser intent is selected
    const model = MODELS.find((m) => m.id === req.modelId)
    if (model?.provider === 'cursor') {
      registry.chat.warmCursorBridge()
    }
    void registry.chat.send(req)
  })
  ipcMain.on(IPC.CHAT_INTERJECT, (_e, req: ChatInterjectionRequest) => registry.chat.interject(req))
  ipcMain.on(IPC.CHAT_ABORT, (_e, requestId: string) => registry.chat.abort(requestId))
  ipcMain.on(IPC.CHAT_PAUSE, (_e, requestId: string) => registry.chat.pauseRequest(requestId))
  ipcMain.on(IPC.CHAT_RESUME, (_e, requestId: string) => registry.chat.resumeRequest(requestId))
  ipcMain.handle(IPC.KEYS_STATUS, () => registry.keys.status())
  ipcMain.handle(IPC.KEYS_SET, (_e, provider: Provider, key: string) => registry.keys.set(provider, key))

  ipcMain.handle(IPC.TTS_SPEAK, (_e, text: string, voice?: string) =>
    synthesizeSpeech(registry.keys, text, voice)
  )

  ipcMain.handle(IPC.CODEX_STATUS, () => registry.chat.codexStatus())
  ipcMain.handle(IPC.CODEX_MODELS, () => registry.chat.codexModels())
  ipcMain.handle(IPC.CLAUDE_CODE_STATUS, () => registry.chat.claudeCodeStatus())
  ipcMain.handle(IPC.CURSOR_STATUS, () => registry.chat.cursorStatus())
  ipcMain.handle(IPC.CURSOR_MODELS, () => registry.chat.cursorModels())

  ipcMain.handle(IPC.WORKSPACE_GET, () => registry.workspace.get())
  ipcMain.handle(IPC.WORKSPACE_SET_FOLDER, (_e, folder: string | null) => applyWorkspaceFolder(folder))
  ipcMain.handle(IPC.WORKSPACE_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a folder to work from',
      defaultPath: registry.workspace.get().folder ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use folder'
    })
    if (result.canceled || result.filePaths.length === 0) return registry.workspace.get()
    return applyWorkspaceFolder(result.filePaths[0])
  })
  ipcMain.handle(IPC.WORKSPACE_CREATE_FOLDER, (_e, folder: string) =>
    createAndUseWorkspaceFolder(folder)
  )

  ipcMain.handle(IPC.AUDIT_LIST, () => registry.audit.list())

  ipcMain.handle(IPC.AGENTS_LIST, () => registry.agents.list())
  ipcMain.handle(IPC.AGENTS_OPTIMIZE, (_e, input: OptimizeAgentInput) =>
    registry.chat.agentOptimizer.optimizeAgent(input)
  )
  ipcMain.handle(IPC.AGENTS_SAVE, (_e, input: SaveAgentInput) => registry.agents.save(input))
  ipcMain.handle(IPC.AGENTS_DELETE, (_e, id: string) => registry.agents.delete(id))

  ipcMain.handle(IPC.CHATS_LIST, (_e, panel?: ChatPanelSide) => registry.chats.list(panel))
  ipcMain.handle(IPC.CHATS_GET, (_e, id: string) => registry.chats.get(id))
  ipcMain.handle(IPC.CHATS_SAVE, (_e, conv: Conversation) => registry.chats.save(conv))
  ipcMain.on(IPC.CHATS_SAVE_SYNC, (e, conv: Conversation) => {
    e.returnValue = registry.chats.save(conv)
  })
  ipcMain.handle(IPC.CHATS_DELETE, (_e, id: string) => registry.chats.delete(id))
  ipcMain.handle(IPC.CHATS_LAST_ACTIVE, (_e, panel?: ChatPanelSide) => registry.chats.lastActive(panel))
  ipcMain.handle(IPC.CHATS_TITLE, async (_e, id: string, modelId: string) => {
    const conv = registry.chats.get(id)
    if (!conv) return null
    const title = await registry.chat.generateTitle(
      modelId,
      conv.messages.map((m) => ({ role: m.role, text: m.text }))
    )
    if (title) registry.chats.setTitle(id, title)
    return title
  })
  ipcMain.handle(
    IPC.CHATS_SEARCH,
    (_e, query: string, limit?: number, panel?: ChatPanelSide) => registry.chats.search(query, limit, panel)
  )

  ipcMain.handle(IPC.EXTRACT_RUN, (_e, tabId: string) => registry.extractor.run(tabId))
  ipcMain.handle(IPC.EXTRACT_OVERLAY, (_e, tabId: string, on: boolean) =>
    registry.extractor.overlay(tabId, on)
  )

  ipcMain.handle(IPC.BROWSER_EXEC, (_e, tabId: string, jsCode: string) =>
    registry.tabs.executeJavaScript(tabId, jsCode)
  )

  ipcMain.handle(IPC.DREAM_RUN, async (_e, req: DreamRunRequest) => {
    const result = await registry.chat.dreamRun(req)
    if (result.ok) registry.autoDream.recordManualRun(req.workspaceRoot)
    return result
  })
  ipcMain.handle(IPC.DREAM_LOAD_LAST, (_e, workspaceRoot: string) =>
    registry.chat.dreamLoadLast(workspaceRoot)
  )
  ipcMain.handle(
    IPC.DREAM_ADOPT,
    (
      _e,
      workspaceRoot: string,
      selection?: import('../../shared/types').DreamAdoptSelection
    ) => registry.chat.dreamAdopt(workspaceRoot, selection)
  )
  ipcMain.handle(IPC.DREAM_DISCARD, (_e, workspaceRoot: string) =>
    registry.chat.dreamDiscard(workspaceRoot)
  )
  ipcMain.handle(IPC.DREAM_STATUS, (_e, workspaceRoot: string) =>
    registry.chat.dreamStatus(workspaceRoot)
  )

  ipcMain.handle(IPC.DREAM_AUTO_GET_CONFIG, (_e, workspaceRoot: string) => {
    void registry.autoDream.start(workspaceRoot)
    return registry.autoDream.getConfig(workspaceRoot)
  })
  ipcMain.handle(
    IPC.DREAM_AUTO_SET_CONFIG,
    (_e, workspaceRoot: string, patch: Partial<DreamAutoConfig>) =>
      registry.autoDream.setConfig(workspaceRoot, patch)
  )
  ipcMain.handle(IPC.DREAM_AUTO_STATUS, (_e, workspaceRoot: string) =>
    registry.autoDream.status(workspaceRoot)
  )
  ipcMain.on(IPC.DREAM_AUTO_NUDGE, (_e, workspaceRoot: string) => {
    registry.autoDream.nudge(workspaceRoot)
  })
  ipcMain.handle(IPC.DREAM_HISTORY_LIST, (_e, workspaceRoot: string) =>
    loadDreamHistory(workspaceRoot)
  )

  const ptyHost = registerTerminalIpc(
    () => registry.workspace.get().folder,
    (channel, payload) => sendIfLive(uiView.webContents, channel, payload)
  )
  registry.setPtyHost(ptyHost)
}

async function promptCreateWorkspaceFolder(): Promise<void> {
  const defaultParent = registry?.workspace.get().folder ?? join(homedir(), 'Desktop')
  const result = await dialog.showSaveDialog(win, {
    title: 'Create a new workspace folder',
    defaultPath: join(defaultParent, 'untitled-workspace'),
    buttonLabel: 'Create Folder',
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (result.canceled || !result.filePath) return

  const target = resolve(result.filePath)
  await createAndUseWorkspaceFolder(target)
}

function sendAppCommand(command: AppCommand): void {
  if (!uiView.webContents.isDestroyed()) uiView.webContents.send(IPC.APP_COMMAND, command)
}

function registerApplicationMenu(): void {
  const hasWorkspace = !!registry.workspace.get().folder
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Folder...',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            void promptCreateWorkspaceFolder().catch((error) => {
              console.error('[workspace] failed to create folder:', error)
              void dialog.showErrorBox(
                'Could not create folder',
                error instanceof Error ? error.message : String(error)
              )
            })
          }
        },
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void dialog
              .showOpenDialog(win, {
                title: 'Choose a folder to work from',
                defaultPath: registry.workspace.get().folder ?? undefined,
                properties: ['openDirectory', 'createDirectory'],
                buttonLabel: 'Use folder'
              })
              .then((result) => {
                if (result.canceled || result.filePaths.length === 0) return
                applyWorkspaceFolder(result.filePaths[0])
              })
              .catch((error) => console.error('[workspace] failed to pick folder:', error))
          }
        },
        { type: 'separator' },
        {
          label: 'Start Codex in Terminal',
          enabled: hasWorkspace,
          submenu: [
            {
              label: 'Standard',
              accelerator: 'CmdOrCtrl+Alt+C',
              click: () => sendAppCommand({ type: 'terminal:run', command: 'codex' })
            },
            {
              label: 'Unrestricted (--yolo)',
              click: () => sendAppCommand({ type: 'terminal:run', command: 'codex --yolo' })
            }
          ]
        },
        {
          label: 'Start Claude Code in Terminal',
          enabled: hasWorkspace,
          submenu: [
            {
              label: 'Standard',
              accelerator: 'CmdOrCtrl+Alt+L',
              click: () => sendAppCommand({ type: 'terminal:run', command: 'claude' })
            },
            {
              label: 'Unrestricted (--dangerously-skip-permissions)',
              click: () =>
                sendAppCommand({
                  type: 'terminal:run',
                  command: 'claude --dangerously-skip-permissions'
                })
            }
          ]
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Memory',
      submenu: [
        {
          label: 'Curate Memory...',
          enabled: hasWorkspace,
          click: () => sendAppCommand({ type: 'memory:open', section: 'curate' })
        },
        {
          label: 'Review Last Dream...',
          enabled: hasWorkspace,
          click: () => sendAppCommand({ type: 'memory:open', section: 'review' })
        },
        {
          label: 'Dream History...',
          enabled: hasWorkspace,
          click: () => sendAppCommand({ type: 'memory:open', section: 'history' })
        },
        { type: 'separator' },
        {
          label: 'Auto-dream Settings...',
          enabled: hasWorkspace,
          click: () => sendAppCommand({ type: 'memory:open', section: 'auto' })
        }
      ]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        // Per-panel chat zoom, flattened into the View dropdown so + and -
        // sit right next to "Chat Left" / "Chat Right" instead of behind a
        // submenu. Native OS menus dismiss on every click, so the
        // accelerators below let the user fire the same actions repeatedly
        // without re-opening View.
        {
          label: 'Chat Left  \u2212',
          accelerator: 'CommandOrControl+Shift+[',
          click: () => sendAppCommand({ type: 'chat:zoom', panel: 'left', action: 'out' })
        },
        {
          label: 'Chat Left  +',
          accelerator: 'CommandOrControl+Shift+]',
          click: () => sendAppCommand({ type: 'chat:zoom', panel: 'left', action: 'in' })
        },
        {
          label: 'Chat Left  Reset',
          accelerator: 'CommandOrControl+Shift+\\',
          click: () => sendAppCommand({ type: 'chat:zoom', panel: 'left', action: 'reset' })
        },
        { type: 'separator' },
        {
          label: 'Chat Right  \u2212',
          accelerator: 'CommandOrControl+Alt+[',
          click: () => sendAppCommand({ type: 'chat:zoom', panel: 'right', action: 'out' })
        },
        {
          label: 'Chat Right  +',
          accelerator: 'CommandOrControl+Alt+]',
          click: () => sendAppCommand({ type: 'chat:zoom', panel: 'right', action: 'in' })
        },
        {
          label: 'Chat Right  Reset',
          accelerator: 'CommandOrControl+Alt+\\',
          click: () => sendAppCommand({ type: 'chat:zoom', panel: 'right', action: 'reset' })
        },
        { type: 'separator' },
        // Embedded browser zoom — one factor applied across every tab.
        // Like the chat zooms above, this scales page CONTENT inside the
        // existing WebContentsView rect; the workspace layout slot stays
        // exactly the same size.
        {
          label: 'Browser  \u2212',
          accelerator: 'CommandOrControl+Shift+Alt+[',
          click: () => sendAppCommand({ type: 'browser:zoom', action: 'out' })
        },
        {
          label: 'Browser  +',
          accelerator: 'CommandOrControl+Shift+Alt+]',
          click: () => sendAppCommand({ type: 'browser:zoom', action: 'in' })
        },
        {
          label: 'Browser  Reset',
          accelerator: 'CommandOrControl+Shift+Alt+\\',
          click: () => sendAppCommand({ type: 'browser:zoom', action: 'reset' })
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
  registry?.disposePtyHost()
})
