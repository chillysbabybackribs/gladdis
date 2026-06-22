import { app, BaseWindow, shell, WebContentsView } from 'electron'
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
import type { CdpEventPayload, ExecResult, TabInfo, ViewBounds } from '../../shared/types'

interface Tab {
  id: string
  view: WebContentsView
  cdp: CDPSession
  favicon: string | null
}

/**
 * A tab id is usable only if it is a non-empty string that is not the literal
 * `"null"` / `"undefined"` produced when a null id is serialized across IPC.
 * Acts as a type guard so callers narrow `string | null` to `string`.
 */
export function isUsableTabId(id: string | null | undefined): id is string {
  return !!id && id !== 'null' && id !== 'undefined'
}

export { BROWSER_PARTITION } from './tabs/constants'

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
  private seq = 0

  constructor(
    private readonly win: BaseWindow,
    private readonly onChange: () => void,
    private readonly onCdpEvent: (e: CdpEventPayload) => void
  ) {}

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

    const wc = view.webContents
    // Hand the stealth patch script to the CDP session so it registers it in the
    // attach sequence (after Page.enable), guaranteeing it runs before the first
    // page script — no race, and one seam instead of a separate inject call.
    const cdp = new CDPSession(wc, id, this.onCdpEvent, [STEALTH_INIT_SCRIPT])

    const tab: Tab = { id, view, cdp, favicon: null }

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
        this.onChange()
      }
    })
    wc.on('did-start-loading', emit)
    wc.on('did-stop-loading', emit)
    wc.on('did-navigate', emit)
    wc.on('did-navigate-in-page', emit)
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
    void cdp.attach().catch((err) => {
      console.error(`[tab ${id}] cdp attach failed during creation:`, err)
    })
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
    this.tabs.get(id)?.view.setVisible(true)
    this.applyBounds()
    this.onChange()
  }

  navigate(id: string, url: string, opts?: { wait?: boolean }): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    navigateTo(tab.view.webContents, url, opts)
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


