/**
 * hiddenSearch — embedded-Chromium SERP discovery.
 *
 * DuckDuckGo (JS-rendered full SERP — includes instant answers, knowledge
 * panels) loaded in a hidden window on the persist:gladdis partition so it
 * shares the visible tabs' cookies/session.
 *
 * (Brave Search was removed: it bot-walls embedded Chromium 100% of the time —
 * every request returns a "Verifying you're not a bot" page with zero results,
 * and there is no API-key path to fix it. It silently contributed nothing.)
 */

import { BrowserWindow, type WebContents } from 'electron'
import { BROWSER_PARTITION } from '../TabManager'

export interface HiddenSearchResult {
  title: string
  url: string
  snippet?: string
  instantAnswer?: string
}

export interface HiddenSearchPage {
  ok: boolean
  url: string
  title: string
  results: HiddenSearchResult[]
  engine?: string
  reason?: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a DuckDuckGo SERP search in a hidden window. Returns ok:false with a
 * concrete reason (timeout / challenge / empty) when nothing usable came back,
 * so callers can tell the model WHY rather than a flat "no results".
 */
export async function runHiddenSearch(
  query: string,
  limit = 20,
  timeoutMs = 10_000
): Promise<HiddenSearchPage> {
  const q = query.trim()
  if (!q) return { ok: false, url: '', title: '', results: [], reason: 'empty query' }

  let page: HiddenSearchPage
  try {
    page = await runDdgSearch(q, limit, timeoutMs)
  } catch (err) {
    return { ok: false, url: '', title: '', results: [], reason: err instanceof Error ? err.message : String(err) }
  }

  if (!page.ok) {
    return { ok: false, url: page.url, title: page.title, results: [], reason: page.reason ?? 'no results' }
  }
  if (page.results.length === 0) {
    return { ok: false, url: page.url, title: page.title, results: [], reason: 'DuckDuckGo returned an empty result set' }
  }

  // Dedup by normalized URL (the same hit can appear twice in one SERP).
  const seen = new Map<string, HiddenSearchResult>()
  for (const r of page.results) {
    const key = normalizeResultUrl(r.url)
    if (!seen.has(key)) seen.set(key, r)
  }

  return {
    ok: true,
    url: page.url,
    title: page.title,
    results: Array.from(seen.values()).slice(0, limit),
    engine: 'ddg'
  }
}

// ── DuckDuckGo (JS-rendered full SERP) ────────────────────────────────────────

async function runDdgSearch(
  query: string,
  limit: number,
  timeoutMs: number
): Promise<HiddenSearchPage> {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`

  return withHiddenWindow(async (wc) => {
    try {
      await loadWithTimeout(wc.loadURL(url), timeoutMs, 'DDG load timed out')
      // Wait for JS-rendered results to appear (DDG renders asynchronously)
      const rendered = await waitForResults(wc, Math.min(timeoutMs - 2_000, 6_000))

      const landed = wc.getURL()
      const title = wc.getTitle()
      const challenge = detectChallenge(landed, title) ?? (await detectBodyChallenge(wc))
      if (challenge) return { ok: false, url: landed, title, results: [], engine: 'ddg', reason: challenge }

      if (!rendered) {
        // No results ever appeared and it isn't a recognized challenge — report
        // the timeout honestly instead of extracting an empty page as "success".
        return { ok: false, url: landed, title, results: [], engine: 'ddg', reason: 'DDG results did not render (timed out)' }
      }

      const results = await loadWithTimeout(
        wc.executeJavaScript(ddgExtractExpression(limit), true),
        3_000,
        'DDG parse timed out'
      )
      return {
        ok: true,
        url: landed,
        title,
        engine: 'ddg',
        results: Array.isArray(results) ? results.filter(isHiddenSearchResult) : []
      }
    } catch (err) {
      return {
        ok: false,
        url: wc.isDestroyed() ? '' : wc.getURL(),
        title: wc.isDestroyed() ? '' : wc.getTitle(),
        results: [],
        engine: 'ddg',
        reason: err instanceof Error ? err.message : String(err)
      }
    }
  })
}

/**
 * Multi-strategy DDG result extractor.
 * Tries selectors for the JS-rendered SERP first, falls back to the plain-HTML
 * a.result__a selectors so the same expression works regardless of which DDG
 * variant is rendered.
 */
function ddgExtractExpression(limit: number): string {
  const safeLimit = Math.max(1, Math.min(16, Math.floor(limit)))
  return `
    (() => {
      const out = [];
      const seen = new Set();
      const LIM = ${safeLimit};

      function cleanUrl(href) {
        if (!href) return null;
        try {
          const u = new URL(href, location.href);
          // DDG wraps destination in ?uddg= param
          const uddg = u.searchParams.get('uddg') || u.searchParams.get('u');
          if (uddg) return decodeURIComponent(uddg);
          if (!/^https?:\\/\\//.test(u.href)) return null;
          if (u.host.includes('duckduckgo.com')) return null;
          return u.href;
        } catch { return null; }
      }

      // Pick the real result link from a container. A single querySelector with
      // a comma-list returns the FIRST match in DOCUMENT ORDER (not by selector
      // priority), and DDG puts "site search" helper anchors before the title
      // link — so we must try each selector separately, in priority order, and
      // never fall back to a bare a[href] (that's the helper link).
      function pickResultUrl(scope) {
        const sels = [
          'a[data-testid="result-title-a"]',
          'h2 a[href]',
          'a[data-testid="result-extras-url-link"]'
        ];
        for (const sel of sels) {
          const el = scope.querySelector(sel);
          const url = cleanUrl(el?.href);
          if (url) return url;
        }
        // Last resort: first anchor in the scope whose cleaned URL is off-DDG.
        for (const a of scope.querySelectorAll('a[href]')) {
          const url = cleanUrl(a.href);
          if (url) return url;
        }
        return null;
      }

      function addResult(title, url, snippet, ia) {
        if (!url || seen.has(url) || out.length >= LIM) return;
        seen.add(url);
        const r = { title: (title || '').replace(/\\s+/g, ' ').trim(), url };
        if (snippet) r.snippet = snippet.replace(/\\s+/g, ' ').trim().slice(0, 350);
        if (ia) r.instantAnswer = ia.replace(/\\s+/g, ' ').trim().slice(0, 400);
        out.push(r);
      }

      // Strategy 1: JS-rendered articles (data-testid="result").
      for (const art of document.querySelectorAll('article[data-testid="result"]')) {
        const url = pickResultUrl(art);
        const title = art.querySelector('h2')?.textContent || '';
        const snip = art.querySelector('[data-result="snippet"], [data-testid="result-snippet"]')?.textContent || '';
        addResult(title, url, snip);
        if (out.length >= LIM) break;
      }

      // Strategy 2: data-nrn="result" blocks
      if (out.length < 3) {
        for (const el of document.querySelectorAll('[data-nrn="result"]')) {
          const url = pickResultUrl(el);
          const title = el.querySelector('h2, h3')?.textContent || '';
          const snip = el.querySelector('[class*="snippet"], [class*="description"]')?.textContent || '';
          addResult(title, url, snip);
        }
      }

      // Strategy 3: li[data-layout="organic"] (yet another DDG variant)
      if (out.length < 3) {
        for (const li of document.querySelectorAll('li[data-layout="organic"]')) {
          const url = pickResultUrl(li);
          const title = li.querySelector('h2')?.textContent || '';
          const snip = li.querySelector('[class*="snippet"]')?.textContent || '';
          addResult(title, url, snip);
        }
      }

      // Strategy 4: plain-HTML fallback (a.result__a) — old endpoint or fallback render
      if (out.length < 3) {
        for (const a of document.querySelectorAll('a.result__a')) {
          const url = cleanUrl(a.href) || (() => {
            let h = a.href || '';
            try { const u = new URL(h, location.href); h = u.searchParams.get('uddg') ? decodeURIComponent(u.searchParams.get('uddg')) : h; } catch {}
            return /^https?:\\/\\//.test(h) && !/duckduckgo\\.com/.test(h) ? h : null;
          })();
          const block = a.closest('.result') || a.parentElement;
          const snip = block?.querySelector('.result__snippet')?.textContent || '';
          addResult(a.textContent || '', url, snip);
        }
      }

      // Instant answer panel (knowledge card, zero-click info box)
      const ia = (
        document.querySelector('.zci__result') ||
        document.querySelector('[data-testid="zeroclick-result"]') ||
        document.querySelector('.ia-answer') ||
        document.querySelector('[data-result="instant-answer"]')
      )?.innerText?.trim();
      if (ia && out.length > 0) {
        out[0].instantAnswer = ia.slice(0, 400);
      }

      return out;
    })()
  `
}

/** Poll until result elements appear in the DDG JS SERP (max timeoutMs). */
async function waitForResults(wc: WebContents, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const check = `!!(
    document.querySelector('article[data-testid="result"]') ||
    document.querySelector('[data-nrn="result"]') ||
    document.querySelector('li[data-layout="organic"]') ||
    document.querySelectorAll('a.result__a').length > 0
  )`
  while (Date.now() < deadline) {
    try {
      const found = await wc.executeJavaScript(check, true)
      if (found) return true
    } catch { /* page still navigating */ }
    await sleep(250)
  }
  return false
}

// ── Shared hidden window infrastructure ───────────────────────────────────────

async function withHiddenWindow<T>(
  task: (wc: WebContents) => Promise<T>
): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
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
  try {
    return await task(win.webContents)
  } finally {
    if (!win.isDestroyed()) {
      win.webContents.stop()
      win.destroy()
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function detectChallenge(url: string, title: string): string | null {
  const u = url.toLowerCase()
  const t = title.toLowerCase()
  if (
    u.includes('/sorry/') ||
    u.includes('/cdn-cgi/challenge') ||
    u.includes('challenges.cloudflare.com')
  ) return 'search challenge page'
  if (
    /just a moment|please wait|verifying you are human|checking your browser|unusual traffic/.test(t)
  ) return `search challenge title "${title}"`
  return null
}

/**
 * Some bot walls return 200-OK with a normal URL and title, putting the
 * challenge text only in the body (e.g. "Verifying you're not a bot"). The
 * URL/title check above can't see those, so sniff a short body sample too.
 */
async function detectBodyChallenge(wc: WebContents): Promise<string | null> {
  try {
    const sample = await wc.executeJavaScript(
      `document.body ? document.body.innerText.slice(0, 400) : ''`,
      true
    )
    if (typeof sample === 'string' && /not a bot|verify you are human|verifying you|are you a human|bot detection/i.test(sample)) {
      return 'search bot-challenge page'
    }
  } catch { /* page still navigating */ }
  return null
}

function isHiddenSearchResult(value: unknown): value is HiddenSearchResult {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : null
  return typeof r?.title === 'string' && typeof r?.url === 'string' && r.url.startsWith('http')
}

function normalizeResultUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s.toLowerCase()
  } catch {
    return raw.trim().toLowerCase()
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
