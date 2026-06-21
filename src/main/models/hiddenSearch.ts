import { BrowserWindow, type WebContents } from 'electron'
import { BROWSER_PARTITION } from '../TabManager'

export interface HiddenSearchResult {
  title: string
  url: string
  snippet?: string
}

export interface HiddenSearchPage {
  ok: boolean
  url: string
  title: string
  results: HiddenSearchResult[]
  reason?: string
}

let hiddenWindow: BrowserWindow | null = null
let hiddenWindowQueue: Promise<void> = Promise.resolve()
let hiddenWindowIdleTimer: ReturnType<typeof setTimeout> | null = null

export async function runHiddenSearch(query: string, limit = 8, timeoutMs = 8_000): Promise<HiddenSearchPage> {
  const q = query.trim()
  if (!q) return { ok: false, url: '', title: '', results: [], reason: 'empty query' }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`

  return withHiddenWindow(async (wc) => {
    try {
      await loadWithTimeout(wc.loadURL(url), timeoutMs, `search load timed out after ${timeoutMs}ms`)
      await waitForIdle(wc, timeoutMs)
      const landed = wc.getURL()
      const title = wc.getTitle()
      const challenge = detectChallenge(landed, title)
      if (challenge) return { ok: false, url: landed, title, results: [], reason: challenge }
      const results = await loadWithTimeout(
        wc.executeJavaScript(ddgResultsExpression(limit), true),
        2_000,
        'search parse timed out'
      )
      return {
        ok: true,
        url: landed,
        title,
        results: Array.isArray(results) ? results.filter(isHiddenSearchResult) : []
      }
    } catch (err) {
      return {
        ok: false,
        url: wc.isDestroyed() ? '' : wc.getURL(),
        title: wc.isDestroyed() ? '' : wc.getTitle(),
        results: [],
        reason: err instanceof Error ? err.message : String(err)
      }
    }
  })
}

function getHiddenWindow(): BrowserWindow {
  if (hiddenWindowIdleTimer) {
    clearTimeout(hiddenWindowIdleTimer)
    hiddenWindowIdleTimer = null
  }
  if (hiddenWindow && !hiddenWindow.isDestroyed()) return hiddenWindow
  hiddenWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  hiddenWindow.on('closed', () => {
    hiddenWindow = null
  })
  return hiddenWindow
}

async function withHiddenWindow<T>(task: (wc: WebContents) => Promise<T>): Promise<T> {
  const run = hiddenWindowQueue.catch(() => {}).then(async () => {
    const win = getHiddenWindow()
    try {
      return await task(win.webContents)
    } finally {
      if (!win.isDestroyed()) win.webContents.stop()
      scheduleHiddenWindowClose()
    }
  })
  hiddenWindowQueue = run.then(() => undefined, () => undefined)
  return run
}

function scheduleHiddenWindowClose(): void {
  if (hiddenWindowIdleTimer) clearTimeout(hiddenWindowIdleTimer)
  hiddenWindowIdleTimer = setTimeout(() => {
    hiddenWindowIdleTimer = null
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.destroy()
      hiddenWindow = null
    }
  }, 60_000)
}

function ddgResultsExpression(limit: number): string {
  return `
    (() => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll("a.result__a")) {
        let href = a.href || "";
        try {
          const u = new URL(href, location.href);
          const uddg = u.searchParams.get("uddg");
          if (uddg) href = decodeURIComponent(uddg);
        } catch (e) {}
        if (!/^https?:\\/\\//.test(href)) continue;
        if (/duckduckgo\\.com/.test(href)) continue;
        if (seen.has(href)) continue;
        const title = (a.textContent || "").replace(/\\s+/g, " ").trim();
        if (!title) continue;
        const block = a.closest(".result") || a.parentElement;
        const sn = block && block.querySelector(".result__snippet");
        let snippet = ((sn && sn.textContent) || "").replace(/\\s+/g, " ").trim();
        if (snippet.length > 300) snippet = snippet.slice(0, 300) + "...";
        seen.add(href);
        out.push({ title, url: href, snippet });
        if (out.length >= ${Math.max(1, Math.min(12, Math.floor(limit)))}) break;
      }
      return out;
    })()
  `
}

function detectChallenge(url: string, title: string): string | null {
  const u = url.toLowerCase()
  const t = title.toLowerCase()
  if (u.includes('/sorry/') || u.includes('/cdn-cgi/challenge') || u.includes('challenges.cloudflare.com')) {
    return 'search challenge page'
  }
  if (/just a moment|please wait|verifying you are human|checking your browser|unusual traffic/.test(t)) {
    return `search challenge title "${title}"`
  }
  return null
}

function isHiddenSearchResult(value: unknown): value is HiddenSearchResult {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : null
  return typeof r?.title === 'string' && typeof r.url === 'string'
}

function loadWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function waitForIdle(wc: WebContents, timeoutMs: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const done = () => {
      clearTimeout(timer)
      wc.off('did-stop-loading', done)
      wc.off('did-fail-load', done)
      resolve()
    }
    timer = setTimeout(done, timeoutMs)
    wc.once('did-stop-loading', done)
    wc.once('did-fail-load', done)
  })
}
