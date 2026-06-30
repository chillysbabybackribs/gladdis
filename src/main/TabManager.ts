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
import type { CdpEventPayload, ExecResult, TabInfo, ViewBounds } from '../../shared/types'

interface Tab {
  id: string
  view: WebContentsView
  cdp: CDPSession
  favicon: string | null
}

type NetworkFilterSpec = {
  mode: 'substring' | 'regex' | 'any'
  label?: string
  substring?: string
  regex?: string
  patterns?: string[]
  resourceTypes?: string[]
  statusCodes?: number[]
  statusMin?: number
  statusMax?: number
  mimeIncludes?: string[]
}

type CapturedNetworkRequest = {
  requestId: string
  url: string
  method: string
  status: number
  mimeType: string
  type: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  startedAt?: number
  responseReceivedAt?: number
  finishedAt?: number
  durationMs?: number
  encodedDataLength?: number
  success: boolean
  errorText?: string
}

type CapturedNetworkBody = {
  requestId: string
  url: string
  status: number
  mimeType: string
  body: string
  truncated: boolean
}

type CapturedNetworkBodyState = CapturedNetworkBody & {
  claimedAt: number
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
    opts: {
      urlFilter?: string
      urlFilters?: string[]
      urlRegex?: string
      resourceTypes?: string[]
      statusCodes?: number[]
      statusMin?: number
      statusMax?: number
      mimeIncludes?: string[]
      windowMs: number
      maxBodies: number
      maxBodyChars: number
    }
  ): Promise<{
    captured: CapturedNetworkRequest[]
    totalSeen: number
    bodies: CapturedNetworkBody[]
    filter?: NetworkFilterSpec
  }> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Unknown tab ${id}`)
    const dbg = tab.view.webContents.debugger

    const requests = new Map<string, CapturedNetworkRequest>()
    const bodyStates = new Map<string, CapturedNetworkBodyState>()
    const bodyClaimOrder: string[] = []
    const filter = this.buildNetworkFilter(opts)
    const isDataType = (type: string, mime: string): boolean => {
      const t = (type || '').toLowerCase()
      if (t === 'xhr' || t === 'fetch') return true
      return /json|javascript|text\/plain/.test((mime || '').toLowerCase()) && t !== 'script'
    }

    const normalizeHeaderMap = (headers: unknown): Record<string, string> | undefined => {
      if (!headers || typeof headers !== 'object') return undefined
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (value === undefined) continue
        out[String(key)] = typeof value === 'string' ? value : String(value)
      }
      return Object.keys(out).length > 0 ? out : undefined
    }

    const ensureRequest = (requestId: string, seed?: Partial<CapturedNetworkRequest>): CapturedNetworkRequest => {
      const existing = requests.get(requestId)
      if (existing) {
        if (seed) Object.assign(existing, seed)
        return existing
      }
      const created: CapturedNetworkRequest = {
        requestId,
        url: seed?.url ?? '',
        method: seed?.method ?? 'GET',
        status: seed?.status ?? 0,
        mimeType: seed?.mimeType ?? '',
        type: seed?.type ?? '',
        requestHeaders: seed?.requestHeaders,
        responseHeaders: seed?.responseHeaders,
        startedAt: seed?.startedAt,
        responseReceivedAt: seed?.responseReceivedAt,
        finishedAt: seed?.finishedAt,
        durationMs: seed?.durationMs,
        encodedDataLength: seed?.encodedDataLength,
        success: seed?.success ?? false,
        errorText: seed?.errorText
      }
      requests.set(requestId, created)
      return created
    }

    const maybeFinalizeDuration = (record: CapturedNetworkRequest): void => {
      if (record.startedAt !== undefined && record.finishedAt !== undefined) {
        record.durationMs = Math.max(0, record.finishedAt - record.startedAt)
      }
    }

    const matchesMetadataFilter = (record: CapturedNetworkRequest): boolean => {
      const resourceTypes = filter?.resourceTypes ?? []
      if (resourceTypes.length > 0) {
        const recordType = (record.type || '').toLowerCase()
        if (!resourceTypes.includes(recordType)) return false
      }

      const statusCodes = filter?.statusCodes ?? []
      if (statusCodes.length > 0 && !statusCodes.includes(record.status)) {
        return false
      }

      if (typeof filter?.statusMin === 'number' && record.status < filter.statusMin) {
        return false
      }
      if (typeof filter?.statusMax === 'number' && record.status > filter.statusMax) {
        return false
      }

      const mimeIncludes = filter?.mimeIncludes ?? []
      if (mimeIncludes.length > 0) {
        const mime = (record.mimeType || '').toLowerCase()
        if (!mimeIncludes.some((part) => mime.includes(part))) return false
      }

      return true
    }

    const canCaptureBody = (record: CapturedNetworkRequest): boolean =>
      matchesMetadataFilter(record) && isDataType(record.type, record.mimeType) && record.status >= 200 && record.status < 400

    const claimBodySlot = (requestId: string): boolean => {
      if (bodyStates.has(requestId)) return true
      if (bodyClaimOrder.length >= opts.maxBodies) return false
      bodyClaimOrder.push(requestId)
      return true
    }

    const captureResponseBody = async (requestId: string): Promise<void> => {
      if (bodyStates.has(requestId)) return
      const record = requests.get(requestId)
      if (!record || !canCaptureBody(record)) return
      if (!claimBodySlot(requestId)) return
      try {
        const res = (await tab.cdp.send('Network.getResponseBody', { requestId })) as {
          body: string
          base64Encoded: boolean
        }
        let body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body
        const truncated = body.length > opts.maxBodyChars
        if (truncated) body = body.slice(0, opts.maxBodyChars)
        bodyStates.set(requestId, {
          requestId,
          url: record.url,
          status: record.status,
          mimeType: record.mimeType,
          body,
          truncated,
          claimedAt: Date.now()
        })
      } catch {
        // Body may already be gone or unavailable; keep metadata and avoid retry loops.
      }
    }

    const onMessage = (_e: unknown, method: string, params: any): void => {
      try {
        if (method === 'Network.requestWillBeSent') {
          const requestId = String(params?.requestId ?? '')
          const request = params?.request ?? {}
          const url = String(request.url ?? '')
          if (!requestId || !this.matchesNetworkFilter(url, filter)) return
          ensureRequest(requestId, {
            requestId,
            url,
            method: String(request.method ?? 'GET'),
            type: String(params?.type ?? ''),
            startedAt: typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now(),
            requestHeaders: normalizeHeaderMap(request.headers)
          })
          return
        }

        if (method === 'Network.responseReceived') {
          const requestId = String(params?.requestId ?? '')
          const response = params?.response ?? {}
          const url = String(response.url ?? '')
          if (!requestId || !this.matchesNetworkFilter(url, filter)) return
          const record = ensureRequest(requestId, {
            requestId,
            url,
            type: String(params?.type ?? ''),
            status: Number(response.status ?? 0),
            mimeType: String(response.mimeType ?? ''),
            responseReceivedAt: typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now(),
            responseHeaders: normalizeHeaderMap(response.headers)
          })
          if (!record.method || record.method === 'GET') {
            const pseudoMethod = response?.requestHeaders?.[':method'] ?? response?.requestHeaders?.['method']
            if (pseudoMethod) record.method = String(pseudoMethod)
          }
          if (!record.requestHeaders) {
            record.requestHeaders = normalizeHeaderMap(response.requestHeaders)
          }
          return
        }

        if (method === 'Network.loadingFinished') {
          const requestId = String(params?.requestId ?? '')
          const record = requests.get(requestId)
          if (!record) return
          record.finishedAt = typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
          record.encodedDataLength = Number.isFinite(params?.encodedDataLength)
            ? Number(params.encodedDataLength)
            : record.encodedDataLength
          record.success = true
          maybeFinalizeDuration(record)
          void captureResponseBody(requestId)
          return
        }

        if (method === 'Network.loadingFailed') {
          const requestId = String(params?.requestId ?? '')
          const record = requests.get(requestId)
          if (!record) return
          record.finishedAt = typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
          record.success = false
          record.errorText = typeof params?.errorText === 'string' ? params.errorText : 'Network loading failed'
          maybeFinalizeDuration(record)
        }
      } catch {
        /* a single malformed event must not break the capture */
      }
    }

    dbg.on('message', onMessage)
    try {
      await tab.cdp.send('Network.enable', {})
      await new Promise((resolve) => setTimeout(resolve, opts.windowMs))

      const all = [...requests.values()]
      const captured = all.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      const candidates = captured.filter((v) => canCaptureBody(v))
      for (const v of candidates) {
        if (bodyClaimOrder.length >= opts.maxBodies) break
        await captureResponseBody(v.requestId)
      }

      const bodies = bodyClaimOrder
        .map((requestId) => bodyStates.get(requestId))
        .filter((value): value is CapturedNetworkBodyState => Boolean(value))
        .map(({ claimedAt: _claimedAt, ...body }) => body)

      return { captured, totalSeen: captured.length, bodies, filter }
    } finally {
      dbg.removeListener('message', onMessage)
      try {
        await tab.cdp.send('Network.disable', {})
      } catch {
        /* best effort — detach also clears it */
      }
    }
  }

  private buildNetworkFilter(opts: {
    urlFilter?: string
    urlFilters?: string[]
    urlRegex?: string
    resourceTypes?: string[]
    statusCodes?: number[]
    statusMin?: number
    statusMax?: number
    mimeIncludes?: string[]
  }): NetworkFilterSpec | undefined {
    const regex = typeof opts.urlRegex === 'string' ? opts.urlRegex.trim() : ''
    const patterns = Array.isArray(opts.urlFilters)
      ? opts.urlFilters.map((value) => String(value).trim()).filter(Boolean)
      : []
    const substring = typeof opts.urlFilter === 'string' ? opts.urlFilter.trim() : ''
    const resourceTypes = Array.isArray(opts.resourceTypes)
      ? opts.resourceTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : []
    const statusCodes = Array.isArray(opts.statusCodes)
      ? opts.statusCodes
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value >= 100 && value <= 599)
          .map((value) => Math.trunc(value))
      : []
    const statusMin =
      typeof opts.statusMin === 'number' && Number.isFinite(opts.statusMin) ? Math.trunc(opts.statusMin) : undefined
    const statusMax =
      typeof opts.statusMax === 'number' && Number.isFinite(opts.statusMax) ? Math.trunc(opts.statusMax) : undefined
    const mimeIncludes = Array.isArray(opts.mimeIncludes)
      ? opts.mimeIncludes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : []

    const labels: string[] = []
    let mode: NetworkFilterSpec['mode'] = 'substring'
    let hasUrlFilter = false

    if (regex) {
      mode = 'regex'
      hasUrlFilter = true
      labels.push(`url~/${regex}/i`)
    } else if (patterns.length > 0) {
      mode = 'any'
      hasUrlFilter = true
      labels.push(`url contains any(${patterns.join(', ')})`)
    } else if (substring) {
      mode = 'substring'
      hasUrlFilter = true
      labels.push(`url contains ${substring}`)
    }

    if (resourceTypes.length > 0) labels.push(`type in [${resourceTypes.join(', ')}]`)
    if (statusCodes.length > 0) labels.push(`status in [${statusCodes.join(', ')}]`)
    if (statusMin !== undefined) labels.push(`status >= ${statusMin}`)
    if (statusMax !== undefined) labels.push(`status <= ${statusMax}`)
    if (mimeIncludes.length > 0) labels.push(`mime includes any(${mimeIncludes.join(', ')})`)

    if (!hasUrlFilter && resourceTypes.length === 0 && statusCodes.length === 0 && statusMin === undefined && statusMax === undefined && mimeIncludes.length === 0) {
      return undefined
    }

    return {
      mode,
      label: labels.join('; '),
      substring: substring ? substring.toLowerCase() : undefined,
      regex: regex || undefined,
      patterns: patterns.length > 0 ? patterns : undefined,
      resourceTypes: resourceTypes.length > 0 ? resourceTypes : undefined,
      statusCodes: statusCodes.length > 0 ? statusCodes : undefined,
      statusMin,
      statusMax,
      mimeIncludes: mimeIncludes.length > 0 ? mimeIncludes : undefined
    }
  }

  private matchesNetworkFilter(url: string, filter?: NetworkFilterSpec): boolean {
    if (!filter) return true
    const value = String(url ?? '')
    const lower = value.toLowerCase()
    if (filter.mode === 'substring') {
      return !!filter.substring && lower.includes(filter.substring)
    }
    if (filter.mode === 'any') {
      return (filter.patterns ?? []).some((pattern) => lower.includes(pattern.toLowerCase()))
    }
    if (filter.mode === 'regex') {
      try {
        return new RegExp(filter.regex ?? '', 'i').test(value)
      } catch {
        return true
      }
    }
    return true
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
