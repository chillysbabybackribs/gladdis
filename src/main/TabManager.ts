import { app, BaseWindow, shell, WebContentsView } from 'electron'
import { attachContextMenu } from './contextMenu'
import { CDPSession } from './cdp/CDPSession'
import { BROWSER_VIEW_BACKGROUND } from './browserPolish'
import { STEALTH_INIT_SCRIPT } from './stealth'
import {
  normalizeAddress,
  isNavigableUrl,
  waitForNavigationSettled as waitForNavigationSettledImpl,
  navigateTo,
  goBack,
  goForward,
  reloadPage,
} from './tabs/navigation'
import { ensureSession as ensureSessionImpl } from './tabs/session'
import { DEFAULT_URL, ABOUT_BLANK, BROWSER_PARTITION } from './tabs/constants'
import {
  buildNetworkFilter,
  createWatchNetworkRecorder,
  type CapturedNetworkBody,
  type CapturedNetworkRequest,
  type NetworkFilterSpec,
  type WatchNetworkOptions
} from './network/watchNetworkRecorder'
import {
  summarizeDataSourceDiscovery,
  type NetworkAwarenessState
} from './network/dataSourceDiscovery'
import type { CdpEventPayload, ExecResult, TabInfo, ViewBounds } from '../../shared/types'

const NETWORK_CAPTURE_POLL_MS = 50
const NETWORK_CAPTURE_IDLE_FALLBACK_MS = 150
const NAVIGATION_CAPTURE_MAX_EXTRA_WAIT_MS = 1_500

interface Tab {
  id: string
  view: WebContentsView
  cdp: CDPSession
  favicon: string | null
}

type NetworkCaptureResult = {
  captured: CapturedNetworkRequest[]
  totalSeen: number
  bodies: CapturedNetworkBody[]
  filter?: NetworkFilterSpec
}

type NavigationNetworkCaptureOptions = Omit<WatchNetworkOptions, 'windowMs'> & {
  timeoutMs?: number
  quietWindowMs?: number
  waitForNavigation?: boolean
  /** Opt-in to URL-bar smart-input rewriting; see navigateTo for semantics. */
  smartAddressBarInput?: boolean
}

type PendingNetworkCaptureArm = WatchNetworkOptions

/**
 * A tab id is usable only if it is a non-empty string that is not the literal
 * `"null"` / `"undefined"` produced when a null id is serialized across IPC.
 * Acts as a type guard so callers narrow `string | null` to `string`.
 */
export function isUsableTabId(id: string | null | undefined): id is string {
  return !!id && id !== 'null' && id !== 'undefined'
}

export { BROWSER_PARTITION } from './tabs/constants'

async function waitForNetworkCaptureQuiet(
  recorder: Pick<ReturnType<typeof createWatchNetworkRecorder>, 'getSnapshot'>,
  opts: { quietWindowMs: number; idleFallbackMs?: number; maxWaitMs?: number }
): Promise<void> {
  const startedAt = Date.now()
  const idleFallbackMs = Math.max(0, opts.idleFallbackMs ?? NETWORK_CAPTURE_IDLE_FALLBACK_MS)
  const maxWaitMs = Math.max(idleFallbackMs, opts.maxWaitMs ?? NAVIGATION_CAPTURE_MAX_EXTRA_WAIT_MS)
  const deadline = startedAt + maxWaitMs

  while (Date.now() < deadline) {
    const snapshot = recorder.getSnapshot()
    const now = Date.now()
    if (snapshot.lastActivityAt === null) {
      if (now - startedAt >= idleFallbackMs) return
    } else if (now - snapshot.lastActivityAt >= opts.quietWindowMs) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, NETWORK_CAPTURE_POLL_MS))
  }
}

/**
 * Owns every browser tab as a native WebContentsView layered over the UI view.
 * Only the active tab's view is visible and positioned into the right pane;
 * the rest are hidden. All state changes flow out via onChange / onCdpEvent.
 */
export class TabManager {
  private tabs = new Map<string, Tab>()
  private order: string[] = []
  private activeId: string | null = null
  private bounds: ViewBounds = { x: 0, y: 0, width: 0, height: 0 }
  private browserVisible = true
  private seq = 0
  /**
   * Single zoom factor applied uniformly across all browser tabs. Driven by
   * the View > Browser menu items via setZoomFactor(); also re-applied to
   * each newly created tab so freshly opened pages match the rest. The
   * factor scales page CONTENT inside the existing WebContentsView bounds,
   * so the rectangle in the workspace layout never shrinks or grows.
   */
  private zoomFactor = 1
  private onPageNavigation?: (tabId: string) => void
  private pendingNetworkCapture = new Map<string, PendingNetworkCaptureArm>()
  private networkAwareness = new Map<string, NetworkAwarenessState>()

  constructor(
    private readonly win: BaseWindow,
    private readonly onChange: () => void,
    private readonly onCdpEvent: (e: CdpEventPayload) => void
  ) {}

  setNavigationCacheInvalidator(handler: (tabId: string) => void): void {
    this.onPageNavigation = handler
  }

  private notifyPageNavigation(tabId: string): void {
    this.onPageNavigation?.(tabId)
  }

  private nextId(): string {
    this.seq += 1
    return `tab-${this.seq}`
  }

  create(url: string = DEFAULT_URL, options: { background?: boolean } = {}): TabInfo {
    const id = this.nextId()
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    view.setBackgroundColor(BROWSER_VIEW_BACKGROUND)
    attachContextMenu(view.webContents, {
      openLinkInNewTab: (targetUrl) => this.create(targetUrl, { background: false })
    })

    const wc = view.webContents
    // Hand the stealth patch script to the CDP session so it registers it in the
    // attach sequence (after Page.enable), guaranteeing it runs before the first
    // page script — no race, and one seam instead of a separate inject call.
    const cdp = new CDPSession(wc, id, this.onCdpEvent, [STEALTH_INIT_SCRIPT])

    const tab: Tab = { id, view, cdp, favicon: null }
    view.setVisible(false)

    // Push UI updates on any navigation / title / favicon / load change.
    const emit = () => this.onChange()
    wc.on('page-title-updated', emit)
    // Capture the highest-quality favicon the page reports.
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[favicons.length - 1] ?? tab.favicon
      this.onChange()
    })
    // A fresh navigation invalidates the old icon until the new one arrives.
    wc.on('did-start-navigation', (_e, _url, _inPage, isMainFrame) => {
      if (isMainFrame) {
        tab.favicon = null
        this.networkAwareness.delete(id)
        this.notifyPageNavigation(id)
        this.onChange()
      }
    })
    wc.on('did-navigate-in-page', () => {
      this.notifyPageNavigation(id)
    })
    wc.on('did-start-loading', emit)
    wc.on('did-stop-loading', emit)
    wc.on('did-navigate', emit)
    wc.on('did-navigate-in-page', emit)
    // Re-apply the workspace browser zoom on every commit so Chromium's
    // per-host zoom preferences don't snap us back to 100% when the user
    // navigates between origins.
    wc.on('did-finish-load', () => {
      wc.setZoomFactor(this.zoomFactor)
    })
    wc.on('will-navigate', (_event, url) => {
      if (isNavigableUrl(url)) return
      _event.preventDefault()
      if (url === ABOUT_BLANK) return
      void shell.openExternal(url)
    })
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      if (!isNavigableUrl(target)) {
        void shell.openExternal(target)
        return { action: 'deny' }
      }
      // A real popup (window.open with window features, e.g. an OAuth/login flow)
      // must keep its opener so the provider's window.close() after auth actually
      // closes it. Denying + making our own tab severed that link, orphaning the
      // popup as a permanent blank tab. So ALLOW it as a native child window that
      // shares our browser partition (same Google session) — Chrome does the same.
      if (disposition === 'new-window' || disposition === 'other') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 640,
            backgroundColor: BROWSER_VIEW_BACKGROUND,
            webPreferences: {
              partition: BROWSER_PARTITION,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          }
        }
      }
      // A foreground/background tab (target=_blank link, modifier-click) is a real
      // new tab, not a self-closing popup — open it in the strip as before.
      this.create(target)
      return { action: 'deny' }
    })

    this.tabs.set(id, tab)
    this.order.push(id)
    this.win.contentView.addChildView(view)
    // Pre-stamp the current workspace zoom factor so a freshly created tab
    // never flashes at 100% before did-finish-load re-applies it.
    if (this.zoomFactor !== 1) wc.setZoomFactor(this.zoomFactor)
    if (!options.background) this.switch(id)
    // Fire the load immediately — do NOT gate it on cdp.attach(). Awaiting attach
    // first (a slow/contended CDP round-trip) could leave the first document
    // uncommitted, so the view stayed blank and wc.getURL() empty; the URL bar then
    // submitted that empty value and every navigation bounced to the bare homepage.
    // The init scripts persist via Page.addScriptToEvaluateOnNewDocument, so they
    // still cover every document the tab loads after this first one.
    void wc.loadURL(url).catch((err) => {
      console.warn(`[tab ${id}] load failed:`, (err as Error)?.message ?? err)
    }).finally(() => {
      this.onChange()
    })
    if (!options.background) {
      void cdp.attach().catch((err) => {
        console.error(`[tab ${id}] cdp attach failed during creation:`, err)
      })
    }
    return this.info(tab)
  }

  close(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const idx = this.order.indexOf(id)
    tab.cdp.detach()
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    this.tabs.delete(id)
    this.networkAwareness.delete(id)
    if (idx !== -1) this.order.splice(idx, 1)

    // gladdis always keeps at least one tab open on the homepage.
    if (this.tabs.size === 0) {
      this.activeId = null
      this.create(DEFAULT_URL)
      return
    }

    if (this.activeId === id) {
      // Activate the neighbor — the tab that shifted into this slot, else its
      // left sibling — exactly like Chrome/Firefox.
      const next = this.order[idx] ?? this.order[idx - 1] ?? null
      this.activeId = null
      if (next) this.switch(next)
      else this.onChange()
    } else {
      this.onChange()
    }
  }

  /** Guarantee a homepage tab exists (called once at startup). */
  ensureInitialTab(): void {
    if (this.tabs.size === 0) this.create(DEFAULT_URL)
  }

  /** Move a tab to a new index in the strip (drag-to-reorder). */
  reorder(id: string, toIndex: number): void {
    const from = this.order.indexOf(id)
    if (from === -1) return
    const clamped = Math.max(0, Math.min(toIndex, this.order.length - 1))
    if (from === clamped) return
    this.order.splice(from, 1)
    this.order.splice(clamped, 0, id)
    this.onChange()
  }

  switch(id: string): void {
    if (!this.tabs.has(id)) return
    const prev = this.activeId ? this.tabs.get(this.activeId) : null
    if (this.activeId === id) {
      this.applyBounds()
      this.onChange()
      return
    }
    this.activeId = id
    if (prev) prev.view.setVisible(false)
    this.tabs.get(id)?.view.setVisible(this.browserVisible)
    this.applyBounds()
    this.onChange()
  }

  navigate(
    id: string,
    url: string,
    opts?: { wait?: boolean; timeoutMs?: number; smartAddressBarInput?: boolean }
  ): Promise<void> {
    const tab = this.tabs.get(id)
    if (!tab) return Promise.resolve()
    return navigateTo(tab.view.webContents, url, opts)
  }

  waitForNavigationSettled(id: string, timeoutMs = 10_000): Promise<void> {
    const tab = this.tabs.get(id)
    if (!tab) return Promise.resolve()
    return waitForNavigationSettledImpl(tab.view.webContents, timeoutMs)
  }

  back(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    goBack(tab.view.webContents)
  }

  forward(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    goForward(tab.view.webContents)
  }

  reload(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    reloadPage(tab.view.webContents)
  }

  setBounds(bounds: ViewBounds): void {
    this.bounds = bounds
    this.applyBounds()
  }

  setBrowserVisible(visible: boolean): void {
    this.browserVisible = visible
    const tab = this.activeId ? this.tabs.get(this.activeId) : null
    if (!tab) return
    tab.view.setVisible(visible)
    if (visible) this.applyBounds()
  }

  /**
   * Apply a zoom factor to every open tab and remember it for future tabs.
   * Scales page content inside the existing WebContentsView rectangle — the
   * layout slot itself does not change size, satisfying the "confine to the
   * appropriate space" contract the workspace layout depends on.
   */
  setZoomFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    this.zoomFactor = factor
    for (const tab of this.tabs.values()) {
      const wc = tab.view.webContents
      if (!wc.isDestroyed()) wc.setZoomFactor(factor)
    }
  }

  getZoomFactor(): number {
    return this.zoomFactor
  }

  private applyBounds(): void {
    if (!this.activeId) return
    const tab = this.tabs.get(this.activeId)
    if (!tab) return
    const { x, y, width, height } = this.bounds
    tab.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  }

  async cdpSend(id: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Unknown tab ${id}`)
    return tab.cdp.send(method, params)
  }

  /**
   * PASSIVE network capture. Enables CDP `Network` for a bounded window, buffers
   * XHR/fetch responses the page fires on its own, fetches JSON bodies for the
   * matches, then ALWAYS disables Network again — the quiet attach posture
   * (Network deliberately off, see CDPSession) must be restored or it regresses
   * the bot-protection footprint. This reads the structured data a page is built
   * from instead of its rendered HTML.
   *
   * Phase 1 enhancement: track the request lifecycle (request/response/finish/fail),
   * keep request+response headers and bounded timing metadata, and support more
   * expressive URL filters while preserving the original substring filter.
   */
  async watchNetwork(
    id: string,
    opts: WatchNetworkOptions
  ): Promise<NetworkCaptureResult> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Unknown tab ${id}`)
    const dbg = tab.view.webContents.debugger
    const filter = buildNetworkFilter(opts)
    const recorder = createWatchNetworkRecorder({
      filter,
      includeRequestBody: opts.includeRequestBody,
      redactSensitive: opts.redactSensitive,
      maxBodies: opts.maxBodies,
      maxBodyChars: opts.maxBodyChars,
      getResponseBody: async (requestId) => {
        return (await tab.cdp.send('Network.getResponseBody', { requestId })) as {
          body: string
          base64Encoded: boolean
        }
      },
      getRequestPostData: async (requestId) => {
        return (await tab.cdp.send('Network.getRequestPostData', { requestId })) as {
          postData: string
        }
      }
    })

    const onMessage = (_e: unknown, method: string, params: any): void => {
      recorder.onMessage(method, params)
    }

    dbg.on('message', onMessage)
    try {
      await tab.cdp.send('Network.enable', {})
      await new Promise((resolve) => setTimeout(resolve, opts.windowMs))
      const result = await recorder.finalize()
      this.recordNetworkAwareness(id, { ...result, filter }, opts.windowMs)
      return { ...result, filter }
    } finally {
      dbg.removeListener('message', onMessage)
      try {
        await tab.cdp.send('Network.disable', {})
      } catch {
        /* best effort — detach also clears it */
      }
    }
  }

  armNextNetworkCapture(id: string, opts: WatchNetworkOptions): void {
    if (!this.tabs.has(id)) throw new Error(`Unknown tab ${id}`)
    this.pendingNetworkCapture.set(id, { ...opts })
  }

  takeArmedNetworkCapture(id: string): PendingNetworkCaptureArm | null {
    const armed = this.pendingNetworkCapture.get(id)
    if (!armed) return null
    this.pendingNetworkCapture.delete(id)
    return armed
  }

  peekArmedNetworkCapture(id: string): PendingNetworkCaptureArm | null {
    const armed = this.pendingNetworkCapture.get(id)
    return armed ? { ...armed } : null
  }

  async runWithPendingNetworkCapture<T>(
    id: string,
    action: () => Promise<T> | T
  ): Promise<{ value: T; network: NetworkCaptureResult | null }> {
    const armed = this.takeArmedNetworkCapture(id)
    if (!armed) {
      return { value: await action(), network: null }
    }

    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Unknown tab ${id}`)
    const dbg = tab.view.webContents.debugger
    const filter = buildNetworkFilter(armed)
    const recorder = createWatchNetworkRecorder({
      filter,
      includeRequestBody: armed.includeRequestBody,
      redactSensitive: armed.redactSensitive,
      maxBodies: armed.maxBodies,
      maxBodyChars: armed.maxBodyChars,
      getResponseBody: async (requestId) => {
        return (await tab.cdp.send('Network.getResponseBody', { requestId })) as {
          body: string
          base64Encoded: boolean
        }
      },
      getRequestPostData: async (requestId) => {
        return (await tab.cdp.send('Network.getRequestPostData', { requestId })) as {
          postData: string
        }
      }
    })

    const onMessage = (_e: unknown, method: string, params: any): void => {
      recorder.onMessage(method, params)
    }

    let networkEnabled = false
    dbg.on('message', onMessage)
    try {
      try {
        await tab.cdp.send('Network.enable', {})
        networkEnabled = true
      } catch {
        /* best effort — still run the action even if Network cannot be armed */
      }

      const value = await action()
      if (!networkEnabled) return { value, network: null }

      await new Promise((resolve) => setTimeout(resolve, armed.windowMs))
      const result = await recorder.finalize()
      this.recordNetworkAwareness(id, { ...result, filter }, armed.windowMs)
      return { value, network: { ...result, filter } }
    } finally {
      dbg.removeListener('message', onMessage)
      if (networkEnabled) {
        try {
          await tab.cdp.send('Network.disable', {})
        } catch {
          /* best effort — detach also clears it */
        }
      }
    }
  }

  /**
   * Pre-arm passive Network capture before a visible navigation so we catch the
   * page's first XHR/fetch burst instead of attaching after it settles.
   */
  async navigateWithNetworkCapture(
    id: string,
    url: string,
    opts: NavigationNetworkCaptureOptions
  ): Promise<NetworkCaptureResult> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Unknown tab ${id}`)
    const dbg = tab.view.webContents.debugger
    const filter = buildNetworkFilter(opts)
    const recorder = createWatchNetworkRecorder({
      filter,
      includeRequestBody: opts.includeRequestBody,
      redactSensitive: opts.redactSensitive,
      maxBodies: opts.maxBodies,
      maxBodyChars: opts.maxBodyChars,
      getResponseBody: async (requestId) => {
        return (await tab.cdp.send('Network.getResponseBody', { requestId })) as {
          body: string
          base64Encoded: boolean
        }
      },
      getRequestPostData: async (requestId) => {
        return (await tab.cdp.send('Network.getRequestPostData', { requestId })) as {
          postData: string
        }
      }
    })

    const onMessage = (_e: unknown, method: string, params: any): void => {
      recorder.onMessage(method, params)
    }

    let networkEnabled = false
    dbg.on('message', onMessage)
    try {
      try {
        await tab.cdp.send('Network.enable', {})
        networkEnabled = true
      } catch {
        /* best effort — still navigate even if Network cannot be armed */
      }

      const shouldWaitForNavigation = opts.waitForNavigation !== false
      await navigateTo(tab.view.webContents, url, {
        wait: shouldWaitForNavigation,
        timeoutMs: opts.timeoutMs ?? 10_000,
        smartAddressBarInput: opts.smartAddressBarInput === true
      })
      const quietWindowMs = opts.quietWindowMs ?? (shouldWaitForNavigation ? 750 : 250)
      if (networkEnabled) {
        await waitForNetworkCaptureQuiet(recorder, {
          quietWindowMs,
          idleFallbackMs: shouldWaitForNavigation ? NETWORK_CAPTURE_IDLE_FALLBACK_MS : 75
        })
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(quietWindowMs, NETWORK_CAPTURE_IDLE_FALLBACK_MS))
        )
      }

      const result = networkEnabled
        ? await recorder.finalize()
        : { captured: [], totalSeen: 0, bodies: [] }
      this.recordNetworkAwareness(id, { ...result, filter }, quietWindowMs)
      return { ...result, filter }
    } finally {
      dbg.removeListener('message', onMessage)
      if (networkEnabled) {
        try {
          await tab.cdp.send('Network.disable', {})
        } catch {
          /* best effort — detach also clears it */
        }
      }
    }
  }

  /**
   * Capture a PNG of the tab as a base64 string (no data: prefix) — the agent's
   * visual feed. `fullPage` stitches the whole scrollable page via CDP; the
   * default grabs the visible frame via Electron's capturePage().
   */
  async capturePagePng(id: string, fullPage = false): Promise<string> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Unknown tab ${id}`)
    if (fullPage) {
      const res = (await tab.cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      })) as { data: string }
      return res.data
    }
    const image = await tab.view.webContents.capturePage()
    return image.toPNG().toString('base64')
  }

  /**
   * Run a JS string inside the tab's page (main-world) context. Returns a
   * structured success/error result rather than throwing, so callers (and a
   * model) can reason about failures uniformly. Wrapped in an IIFE so the
   * payload may use `return`, and `userGesture` lets it trigger gated APIs.
   */
  async executeJavaScript(id: string, jsCode: string): Promise<ExecResult> {
    const tab = this.tabs.get(id)
    if (!tab) return { success: false, error: `Unknown tab ${id}` }
    try {
      const result = await tab.view.webContents.executeJavaScript(
        `(async () => { ${jsCode} })()`,
        true // userGesture — allow APIs that require user activation
      )
      return { success: true, result }
    } catch (error) {
      return { success: false, error: (error as Error)?.message ?? String(error) }
    }
  }

  /** The currently active tab id, or null if no tabs exist. */
  get activeTabId(): string | null {
    return this.activeId
  }

  getTabUrl(tabId: string): string {
    const tab = this.tabs.get(tabId)
    if (!tab) return ''
    return tab.view.webContents.getURL()
  }

  getNetworkAwareness(tabId: string): NetworkAwarenessState | null {
    const awareness = this.networkAwareness.get(tabId)
    return awareness ? { ...awareness, candidateApis: awareness.candidateApis.map((item) => ({ ...item })) } : null
  }

  /**
   * Resolve a guaranteed-usable visible tab id, creating one if needed.
   *
   * Guards against stale ids that serialize to the *string* `"null"` /
   * `"undefined"` across the IPC boundary — those are truthy, so a naive
   * `activeTabId || create()` fallback lets them slip through to CDP and
   * produces "Unknown tab null". This always returns an id present in the
   * live tab list, falling back to a freshly created tab.
   */
  liveTabId(requested?: string | null): string {
    const validIds = this.list()
      .map((t) => t.id)
      .filter(isUsableTabId)
    if (isUsableTabId(requested) && validIds.includes(requested)) return requested
    const active = this.activeTabId
    if (isUsableTabId(active) && validIds.includes(active)) return active
    if (validIds.length > 0) return validIds[0]
    return this.create().id
  }

  list(): TabInfo[] {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter((t): t is Tab => !!t)
      .map((t) => this.info(t))
  }

  snapshot(): { tabs: TabInfo[]; activeTabId: string | null } {
    return { tabs: this.list(), activeTabId: this.activeTabId }
  }

  private recordNetworkAwareness(
    tabId: string,
    capture: NetworkCaptureResult,
    observedWindowMs?: number
  ): void {
    const pageUrl = this.getTabUrl(tabId)
    this.networkAwareness.set(
      tabId,
      summarizeDataSourceDiscovery(capture, {
        pageUrl,
        observedWindowMs,
        capturedAt: Date.now()
      })
    )
  }

  private info(tab: Tab): TabInfo {
    const wc = tab.view.webContents
    return {
      id: tab.id,
      url: wc.getURL(),
      title: wc.getTitle() || wc.getURL(),
      favicon: tab.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  static async ensureSession(): Promise<void> {
    await ensureSessionImpl()
  }
}
