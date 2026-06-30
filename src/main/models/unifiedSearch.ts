/**
 * unifiedSearch — orchestrates the search pipeline.
 *
 *  • Searches the model's query as-is via a hidden DuckDuckGo window (no
 *    manufactured query variants — the model rephrases if it wants to)
 *  • Parallel multi-tab probing: top-N results probed simultaneously in
 *    background tabs that don't steal focus from the user's active tab
 *  • CDP network-quiet wait before extraction (catches SPA lazy-load content)
 *  • DOM-based wall detection (paywall / cookie consent / login / blank)
 *  • Domain diversity enforcement: no more than 2 results per domain
 */

import type { TabManager } from '../TabManager'
import { isUsableTabId } from '../TabManager'
import type { PageExtractor } from '../extract/PageExtractor'
import type { WatchNetworkOptions } from '../network/watchNetworkRecorder'
import type { CapturedNetworkBody, CapturedNetworkRequest, NetworkFilterSpec } from '../network/watchNetworkRecorder'
import { briefPageForSearch } from './searchBrief'
import { runHiddenSearch, type HiddenSearchResult } from './hiddenSearch'

const VISIBLE_NAVIGATION_CAPTURE = {
  resourceTypes: ['xhr', 'fetch'],
  statusMin: 200,
  statusMax: 399,
  mimeIncludes: ['json', 'javascript', 'text/plain'],
  maxBodies: 2,
  maxBodyChars: 3_000,
  timeoutMs: 10_000,
  quietWindowMs: 350
}

const BACKGROUND_PROBE_SPA_GRACE_MS = 250

export interface RankedSearchResult extends HiddenSearchResult {
  originQuery: string
  relevanceScore: number
}

export interface LivePageDigest {
  url: string
  title: string
  relevanceScore: number
  digest: string
  wallDetected?: string
}

export interface UnifiedSearchDeps {
  tabs: TabManager
  extractor: PageExtractor
}

export interface UnifiedSearchOptions {
  query: string
  tabId: string
  /** Max SERP hits collected per query variant. Default 5. */
  limitPerQuery?: number
  /** Top ranked hits to open for live extraction. Default 2. */
  digestTop?: number
  focus?: string
  /** Whether to navigate the active visible tab to the best hit. Default false. */
  navigateVisible?: boolean
  /** Optional one-shot watch config armed by watch_network for the visible navigation. */
  visibleNavigationCapture?: WatchNetworkOptions
}

export interface UnifiedSearchOutcome {
  ok: boolean
  text: string
  results: RankedSearchResult[]
  digests: LivePageDigest[]
  visibleNavigationNetwork?: {
    totalSeen: number
    captured: CapturedNetworkRequest[]
    bodies: CapturedNetworkBody[]
    filter?: NetworkFilterSpec
  }
  reason?: string
}

/** Total char budget for the tool result returned to the model (~2400 tokens). */
const OUTPUT_CHAR_BUDGET = 9_600
const MAX_HIT_LINES = 8
/** Evidence budget per probed page — scales by probe count. */
const EVIDENCE_PER_PAGE: Record<number, number> = { 1: 3_200, 2: 2_000, 3: 1_400 }
const EVIDENCE_DEFAULT = 1_200

// ── Tab resolution ────────────────────────────────────────────────────────────

/**
 * Resolve a usable visible tab id, creating one if needed.
 * Prefers {@link TabManager.liveTabId} when available; otherwise applies the
 * same {@link isUsableTabId} guard inline (so duck-typed mocks still work).
 */
export function resolveVisibleTabId(tabs: TabManager, requested?: string): string {
  if (typeof tabs.liveTabId === 'function') return tabs.liveTabId(requested)
  const validIds = tabs
    .list()
    .map((t) => t.id)
    .filter(isUsableTabId)
  if (isUsableTabId(requested) && validIds.includes(requested)) return requested
  const active = tabs.activeTabId
  if (isUsableTabId(active) && validIds.includes(active)) return active
  if (validIds.length > 0) return validIds[0]
  return tabs.create().id
}

// ── Result ranking ────────────────────────────────────────────────────────────
//
// The query the model gives us is searched as-is. We do NOT manufacture query
// variants here — the model already knows the user's intent and rephrases far
// better than a regex switch-case ever could (the old expandSearchQueries
// produced junk like '"x" OR "y" (a OR b)'). If the model wants variations it
// issues multiple search() calls. rankSearchResults only dedups/orders the hits
// DDG actually returned; it invents nothing.

export function rankSearchResults(
  flat: RankedSearchResult[],
  refinedIntent: string,
  prioritizedDomains: string[]
): RankedSearchResult[] {
  const uniqueMap = new Map<string, RankedSearchResult>()
  for (const res of flat) {
    const key = normalizeUrl(res.url)
    const existing = uniqueMap.get(key)
    if (existing) {
      // Cross-engine boost: appeared in multiple query passes or engines
      existing.relevanceScore += 0.25
    } else {
      uniqueMap.set(key, { ...res })
    }
  }

  const keywords = refinedIntent.toLowerCase().split(/\s+/).filter((w) => w.length > 3)

  // Domain diversity: track hits per domain, penalize beyond 2
  const domainCount = new Map<string, number>()

  return Array.from(uniqueMap.values())
    .map((item) => {
      let score = item.relevanceScore
      const lowerUrl = item.url.toLowerCase()

      if (prioritizedDomains.some((d) => lowerUrl.includes(d.toLowerCase()))) score += 0.3
      if (lowerUrl.includes('github.com') || lowerUrl.includes('stackoverflow.com')) score += 0.1

      const matchText = `${item.title} ${item.snippet ?? ''}`.toLowerCase()
      let keywordHits = 0
      for (const kw of keywords) {
        if (matchText.includes(kw)) keywordHits++
      }
      score += Math.min(keywordHits * 0.05, 0.25)

      // Instant answer present → strong boost
      if (item.instantAnswer) score += 0.4

      item.relevanceScore = Math.max(0, Math.min(1, score))
      return item
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .filter((item) => {
      // Domain diversity: allow max 2 results per domain
      const domain = extractDomain(item.url)
      const count = domainCount.get(domain) ?? 0
      if (count >= 2) return false
      domainCount.set(domain, count + 1)
      return true
    })
}

// ── Page wall detection ───────────────────────────────────────────────────────

/** Detect paywalls, cookie consent walls, login gates, and blank pages. */
async function detectPageWall(tabs: TabManager, tabId: string): Promise<string | null> {
  try {
    const res = await tabs.executeJavaScript(tabId, `
      (() => {
        const q = (s) => document.querySelector(s);
        const qAll = (s) => document.querySelectorAll(s);

        // Blank / minimal page
        if ((document.body?.innerText?.length ?? 0) < 150) return 'empty-page';

        // Paywall (subscription required)
        const paywallSels = ['[class*="paywall"]','[id*="paywall"]','[class*="metered"]','.tp-modal','.piano-modal','[class*="subscriber"]'];
        if (paywallSels.some(s => q(s))) return 'paywall';

        // Cookie consent wall that blocks content (must be visually large)
        const consentSels = ['#onetrust-consent-sdk','#cookiebanner','[id*="cookie-banner"]','[class*="gdpr-"]','.fc-consent-root','[id*="gdpr"]'];
        for (const s of consentSels) {
          const el = q(s);
          if (el && el.getBoundingClientRect().height > 300) return 'cookie-wall';
        }

        // Login gate with no real content
        const hasPasswordField = qAll('input[type="password"]').length > 0;
        const hasContent = !!(q('main article') || q('[role="main"]') || q('.content') || q('[class*="article"]'));
        if (hasPasswordField && !hasContent) return 'login-wall';

        // CAPTCHA / bot challenge
        if (q('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], #cf-challenge-running')) return 'captcha';

        return null;
      })()
    `)
    return res.success && typeof res.result === 'string' ? res.result : null
  } catch {
    return null
  }
}

// ── Parallel background tab probing ──────────────────────────────────────────

/**
 * Probe a single result in a dedicated background tab.
 * The tab is created with background:true so it never displaces the active tab.
 * The tab is always closed in the finally block regardless of outcome.
 */
async function probeInBackground(
  deps: UnifiedSearchDeps,
  hit: RankedSearchResult,
  query: string,
  focus?: string,
  perPageBudget = 1_600
): Promise<LivePageDigest | null> {
  const tabId = deps.tabs.create('about:blank', { background: true }).id
  try {
    await deps.tabs.navigate(tabId, hit.url, { wait: true, timeoutMs: 12_000 })
    await sleep(BACKGROUND_PROBE_SPA_GRACE_MS)

    const wall = await detectPageWall(deps.tabs, tabId)
    if (wall) {
      console.log(`[unifiedSearch] wall detected (${wall}) on ${hit.url}`)
      return { url: hit.url, title: hit.title, relevanceScore: hit.relevanceScore, digest: '', wallDetected: wall }
    }

    const capture = await deps.extractor.run(tabId)
    const digest = briefPageForSearch(capture, {
      query: focus?.trim() || query,
      maxChars: perPageBudget
    })
    return {
      url: capture.url || hit.url,
      title: capture.title || hit.title,
      relevanceScore: hit.relevanceScore,
      digest
    }
  } catch (err) {
    console.warn(`[unifiedSearch] background probe failed for ${hit.url}:`, err)
    return null
  } finally {
    try { deps.tabs.close(tabId) } catch { /* ignore */ }
  }
}

/**
 * Probe the top-N ranked hits in parallel background tabs.
 * Returns digests sorted by relevanceScore descending, filtering out walls
 * and failed probes, then re-navigates the active visible tab to the best hit.
 */
async function probeTopHits(
  deps: UnifiedSearchDeps,
  ranked: RankedSearchResult[],
  visibleTabId: string,
  digestTop: number,
  query: string,
  focus?: string,
  navigateVisible?: boolean,
  visibleNavigationCapture?: WatchNetworkOptions
): Promise<{
  digests: LivePageDigest[]
  visibleNavigationNetwork?: {
    totalSeen: number
    captured: CapturedNetworkRequest[]
    bodies: CapturedNetworkBody[]
    filter?: NetworkFilterSpec
  }
}> {
  const hits = ranked.slice(0, digestTop)
  if (hits.length === 0) return { digests: [] }

  const perPageBudget = EVIDENCE_PER_PAGE[digestTop] ?? EVIDENCE_DEFAULT

  // Run all probes concurrently in background tabs
  const settled = await Promise.allSettled(
    hits.map((hit) => probeInBackground(deps, hit, query, focus, perPageBudget))
  )

  const digests: LivePageDigest[] = settled
    .filter((r): r is PromiseFulfilledResult<LivePageDigest> =>
      r.status === 'fulfilled' && r.value !== null && !!r.value.digest
    )
    .map((r) => r.value)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)

  let visibleNavigationNetwork:
    | {
        totalSeen: number
        captured: CapturedNetworkRequest[]
        bodies: CapturedNetworkBody[]
        filter?: NetworkFilterSpec
      }
    | undefined

  // Navigate the active visible tab to the best successfully-probed hit
  // so the user can see where the answer came from
  if (navigateVisible) {
    const bestUrl = digests[0]?.url ?? ranked[0]?.url
    if (bestUrl) {
      try {
        visibleNavigationNetwork = await deps.tabs.navigateWithNetworkCapture(visibleTabId, bestUrl, {
          ...(visibleNavigationCapture ?? VISIBLE_NAVIGATION_CAPTURE),
          quietWindowMs: VISIBLE_NAVIGATION_CAPTURE.quietWindowMs
        })
      } catch {
        try { await deps.tabs.navigate(visibleTabId, bestUrl) } catch { /* non-fatal */ }
      }
    }
  }

  return { digests, visibleNavigationNetwork }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Search pipeline:
 *  1. Runs the query as-is through a hidden DuckDuckGo window (SERP index)
 *  2. Deduplicates and ranks results
 *  3. Probes top-N results in parallel background tabs (live extraction)
 *  4. Returns a deterministically compressed output with SERP index + evidence
 */
export async function runUnifiedSearch(
  deps: UnifiedSearchDeps,
  options: UnifiedSearchOptions
): Promise<UnifiedSearchOutcome> {
  const query = options.query.trim()
  if (!query) return { ok: false, text: 'search: "query" is required.', results: [], digests: [], reason: 'empty query' }

  const limitPerQuery = clampInt(options.limitPerQuery, 1, 30, 20)
  const digestTop = clampInt(options.digestTop, 0, 3, 2)
  const tabId = resolveVisibleTabId(deps.tabs, options.tabId)

  // ── SERP pass ──────────────────────────────────────────────────────────────
  // Search the model's query as-is — no manufactured variants.
  const page = await runHiddenSearch(query, limitPerQuery)
  const flat: RankedSearchResult[] = page.ok
    ? page.results.map((r) => ({ ...r, originQuery: query, relevanceScore: 0.5 }))
    : []

  if (flat.length === 0) {
    // Surface WHY there were no results (timeout / bot-challenge / genuinely
    // empty) so the model can react instead of blindly rephrasing.
    const why = page.reason ?? 'no results'
    return {
      ok: false,
      text: `search: no results for "${query}" (${why}).`,
      results: [],
      digests: [],
      reason: why
    }
  }

  const ranked = rankSearchResults(flat, query, [])

  // ── Live probe pass (parallel background tabs) ────────────────────────────
  const probeResult = digestTop > 0
    ? await probeTopHits(
        deps,
        ranked,
        tabId,
        digestTop,
        query,
        options.focus,
        options.navigateVisible,
        options.visibleNavigationCapture
      )
    : { digests: [] }
  const digests = probeResult.digests

  const text = formatCompactSearchOutput(query, ranked, digests)
  return {
    ok: ranked.length > 0,
    text,
    results: ranked,
    digests,
    visibleNavigationNetwork: probeResult.visibleNavigationNetwork
  }
}

// ── Output formatter ──────────────────────────────────────────────────────────

function formatCompactSearchOutput(
  query: string,
  ranked: RankedSearchResult[],
  digests: LivePageDigest[]
): string {
  const liveUrls = new Set(digests.map((d) => d.url))
  const walledUrls = new Set(digests.filter((d) => d.wallDetected).map((d) => d.url))

  const lines: string[] = [
    `SEARCH "${query}" | ${ranked.length} hits | ${digests.length} probed`
  ]

  const hitBudget = OUTPUT_CHAR_BUDGET - (digests.length * (EVIDENCE_PER_PAGE[digests.length] ?? EVIDENCE_DEFAULT)) - 200
  lines.push('', 'INDEX (use fetch_page for a deeper read):')
  let hitChars = 0
  let shown = 0
  for (const r of ranked) {
    if (shown >= MAX_HIT_LINES) break
    const pct = Math.round(r.relevanceScore * 100)
    const live = liveUrls.has(r.url) ? (walledUrls.has(r.url) ? '⚠' : '★') : ' '
    const ia = r.instantAnswer ? ` [instant: ${trunc(r.instantAnswer, 80)}]` : ''
    const snip = r.snippet ? trunc(r.snippet, 100) : ''
    const row = `${live}${pct} ${trunc(r.title, 70)} | ${r.url}${snip ? ` | ${snip}` : ''}${ia}`
    if (hitChars + row.length > hitBudget) break
    lines.push(row)
    hitChars += row.length
    shown++
  }
  if (ranked.length > shown) {
    lines.push(`…+${ranked.length - shown} more`)
  }

  const goodDigests = digests.filter((d) => d.digest && !d.wallDetected)
  if (goodDigests.length) {
    lines.push('', 'EVIDENCE (live-extracted, query-scored; ★ = probed):')
    for (const d of goodDigests) {
      lines.push('')
      lines.push(`★ ${Math.round(d.relevanceScore * 100)} ${d.digest}`)
    }
  }
  const walled = digests.filter((d) => d.wallDetected)
  if (walled.length) {
    lines.push('', `BLOCKED PAGES (${walled.map((d) => `${d.url} [${d.wallDetected}]`).join(', ')}): use fetch_page with authenticated session or try next result.`)
  }

  return trunc(lines.join('\n'), OUTPUT_CHAR_BUDGET)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s.toLowerCase()
  } catch {
    return raw.trim().replace(/[/#]+$/, '').toLowerCase()
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
