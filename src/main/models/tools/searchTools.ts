import type { TabManager } from '../../TabManager'
import type { PageExtractor } from '../../extract/PageExtractor'
import type { KeyStore } from '../KeyStore'
import type { ToolContext, ToolOutcome } from '../browserTools'
import { digestPage } from '../PageDigest'
import { runDeepSearch } from '../deepSearch'
import { runUnifiedSearch } from '../unifiedSearch'
import { cap, clampInt, normalizeUrl, sleep } from './toolUtils'
import { summarizeNetworkCapture } from './perceiveTools'

const PRE_NAVIGATION_CAPTURE = {
  resourceTypes: ['xhr', 'fetch'],
  statusMin: 200,
  statusMax: 399,
  mimeIncludes: ['json', 'javascript', 'text/plain'],
  maxBodies: 3,
  maxBodyChars: 4_000,
  timeoutMs: 10_000,
  quietWindowMs: 350
}

export interface SearchToolsDeps {
  tabs: TabManager
  extractor: PageExtractor
  keys?: KeyStore
  /** Per-task scope helpers from the BrowserTools façade. */
  taskScope: (ctx: ToolContext) => Map<string, string>
  rememberDone: (ctx: ToolContext, key: string, summary: string) => void
}

/**
 * Unified web search: hidden embedded-Chromium SERP discovery, ranked
 * aggregation, then top hits opened in the visible tab for live CDP
 * extraction. Repeats of the same query within one task return the cached
 * result so the model can't burn loops on the same SERP.
 */
export async function runSearchTool(
  deps: SearchToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const query = String(args.query ?? '').trim()
  if (!query) return { ok: false, text: 'search: "query" is required.' }
  const memKey = `search:${query.toLowerCase()}`
  const prior = deps.taskScope(ctx).get(memKey)
  if (prior) {
    return { ok: true, text: `(already searched this query this task — reusing prior results)\n${prior}` }
  }
  const outcome = await runUnifiedSearch(
    { tabs: deps.tabs, extractor: deps.extractor },
    {
      query,
      tabId: ctx.tabId,
      limitPerQuery: clampInt(args.limit, 1, 8, 4),
      digestTop: clampInt(args.digest_top, 0, 3, 2),
      focus: args.focus ? String(args.focus) : undefined,
      navigateVisible: resolveSearchNavigationMode(args, ctx),
      visibleNavigationCapture: deps.tabs.takeArmedNetworkCapture(ctx.tabId) ?? undefined
    }
  )
  if (!outcome.ok) return { ok: false, text: outcome.text }
  const visibleNavigationSummary = outcome.visibleNavigationNetwork
    ? summarizeNetworkCapture(outcome.visibleNavigationNetwork, { label: 'PRE-NAV NETWORK' })
    : null
  const outputText = visibleNavigationSummary ? `${outcome.text}\n${visibleNavigationSummary.text}` : outcome.text
  deps.rememberDone(ctx, memKey, outputText)
  return {
    ok: true,
    text: outputText,
    structuredContent: {
      query,
      navigateVisible: resolveSearchNavigationMode(args, ctx),
      limit: clampInt(args.limit, 1, 8, 4),
      digestTop: clampInt(args.digest_top, 0, 3, 2),
      results: outcome.results,
      digests: outcome.digests,
      ...(visibleNavigationSummary ? { preNavigationNetwork: visibleNavigationSummary.structuredContent } : {})
    }
  }
}

export async function runSearchOpenTool(
  deps: SearchToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const query = String(args.query ?? '').trim()
  if (!query) return { ok: false, text: 'search_open: "query" is required.' }

  const rawUrl = String(args.url ?? '').trim()
  if (!rawUrl) return { ok: false, text: 'search_open: "url" is required.' }

  let normalizedUrl: string
  try {
    normalizedUrl = new URL(rawUrl).toString()
  } catch {
    return { ok: false, text: `search_open: invalid URL "${rawUrl}".` }
  }

  const memKey = `search_open:${query.toLowerCase()}|${normalizeUrl(normalizedUrl)}`
  const prior = deps.taskScope(ctx).get(memKey)
  if (prior) {
    return { ok: true, text: `(already ran this parallel search/open step this task — reusing prior results)\n${prior}` }
  }

  const [searchOutcome, fetchOutcome] = await Promise.all([
    runUnifiedSearch(
      { tabs: deps.tabs, extractor: deps.extractor },
      {
        query,
        tabId: ctx.tabId,
        limitPerQuery: clampInt(args.limit, 1, 8, 4),
        digestTop: clampInt(args.digest_top, 0, 3, 2),
        focus: args.focus ? String(args.focus) : undefined,
        navigateVisible: false
      }
    ),
    runFetchPage(
      deps,
      {
        url: normalizedUrl,
        focus: args.focus,
        viewportOnly: args.viewportOnly
      },
      ctx
    )
  ])

  const ok = searchOutcome.ok || fetchOutcome.ok
  const summary = [
    `SEARCH_OPEN "${query}" + ${normalizedUrl}`,
    '',
    'DIRECT PAGE:',
    fetchOutcome.text,
    '',
    'WEB SEARCH:',
    searchOutcome.text
  ].join('\n')

  deps.rememberDone(ctx, memKey, summary)
  return {
    ok,
    text: summary,
    structuredContent:
      searchOutcome.ok && fetchOutcome.structuredContent
        ? {
            query,
            url: normalizedUrl,
            search: {
              query,
              navigateVisible: false,
              limit: clampInt(args.limit, 1, 8, 4),
              digestTop: clampInt(args.digest_top, 0, 3, 2),
              results: searchOutcome.results,
              digests: searchOutcome.digests
            },
            page: fetchOutcome.structuredContent
          }
        : undefined
  }
}

/**
 * Decide whether `search` should also navigate the active visible tab to the
 * best probed hit when the model omits `navigate_visible`.
 *
 * Previously this also short-circuited on `shouldUseDirectBrowserTools`, which
 * fires on the bare word "tab", "browser", "url", etc. and on any http(s)
 * URL in the user's text. That treated every "talk about the browser" turn
 * as authorization to abruptly redirect the visible tab — too broad, and the
 * source of the "the search result keeps showing up in my tab" complaint. We
 * now require an explicit "open/navigate/visit/load/go to ..." verb phrase.
 */
function resolveSearchNavigationMode(args: Record<string, any>, ctx: ToolContext): boolean {
  if (typeof args.navigate_visible === 'boolean') return args.navigate_visible
  const latestUserText = ctx.latestUserText ?? ''
  return (
    /\b(?:open|navigate|visit|load|go to)\b.{0,80}\b(?:result|page|site|tab|link|url|browser)\b/i.test(latestUserText) ||
    /\b(?:open|navigate|visit|load|go to)\s+(?:it|them|that|those|the best result|the first result)\b/i.test(latestUserText)
  )
}

/**
 * Deep multi-page web research. Phased: Decompose -> Plan -> Execute ->
 * Synthesize -> Critique. Uses Gemini for the synthesis pass when a key is
 * available.
 */
export async function runDeepSearchTool(
  deps: SearchToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const query = String(args.query ?? '').trim()
  if (!query) return { ok: false, text: 'deep_search: "query" is required.' }

  const depth = typeof args.depth === 'number' ? args.depth : 2
  const maxPages = typeof args.max_pages === 'number' ? args.max_pages : 5

  const memKey = `deep_search:${query.toLowerCase()}`
  const prior = deps.taskScope(ctx).get(memKey)
  if (prior) {
    return { ok: true, text: prior }
  }

  const apiKey = deps.keys?.get('google') || process.env.GEMINI_API_KEY

  const outcome = await runDeepSearch(
    { tabs: deps.tabs, extractor: deps.extractor },
    {
      query,
      depth,
      maxPages,
      apiKey,
      onProgress: (msg) => {
        console.log(`[Deep Search] ${msg}`)
      }
    }
  )

  if (outcome.ok) {
    deps.rememberDone(ctx, memKey, outcome.text)
  }

  return outcome.ok
    ? {
        ok: true,
        text: outcome.text,
        structuredContent: {
          query,
          depth,
          maxPages,
          queriesRun: outcome.queriesRun,
          sourcesVisited: outcome.sourcesVisited
        }
      }
    : outcome
}

/**
 * Visible-tab page fetch. Deliberate handoff from hidden/off-screen search
 * breadth to something the user can see and the model can read.
 */
export async function runFetchPage(
  deps: SearchToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const rawUrl = String(args.url ?? '').trim()
  if (!rawUrl) return { ok: false, text: 'fetch_page: "url" is required.' }

  let url: string
  try {
    url = new URL(rawUrl).toString()
  } catch {
    return { ok: false, text: `fetch_page: invalid URL "${rawUrl}".` }
  }

  const memKey = `fetch:${normalizeUrl(url)}`
  const prior = deps.taskScope(ctx).get(memKey)
  if (prior) {
    return { ok: true, text: `(already fetched this URL this task — reusing prior digest)\n${prior}` }
  }

  const started = Date.now()
  const beforeNavUrl = currentVisibleTabUrl(deps.tabs, ctx.tabId)
  const beforeNavigateMs = Date.now() - started
  const navigateStarted = Date.now()
  const navigationCapture = deps.tabs.takeArmedNetworkCapture(ctx.tabId) ?? PRE_NAVIGATION_CAPTURE
  const preNavigationNetwork = await deps.tabs.navigateWithNetworkCapture(ctx.tabId, url, {
    ...navigationCapture,
    timeoutMs: 'timeoutMs' in navigationCapture ? navigationCapture.timeoutMs : PRE_NAVIGATION_CAPTURE.timeoutMs,
    quietWindowMs:
      'quietWindowMs' in navigationCapture
        ? navigationCapture.quietWindowMs
        : PRE_NAVIGATION_CAPTURE.quietWindowMs
  })
  const navigateCaptureMs = Date.now() - navigateStarted
  const readableStarted = Date.now()
  await waitForVisibleNavigationReadable(deps.tabs, ctx.tabId, url, beforeNavUrl)
  const readableMs = Date.now() - readableStarted
  const extractStarted = Date.now()
  const capData = await deps.extractor.run(ctx.tabId)
  const extractMs = Date.now() - extractStarted
  const digestStarted = Date.now()
  const digest = digestPage(capData, {
    focus: args.focus ? String(args.focus) : undefined,
    viewportOnly: args.viewportOnly === true
  })
  const digestMs = Date.now() - digestStarted
  const finalUrl = typeof capData.url === 'string' ? normalizeUrl(capData.url) : null
  const pageUrl = finalUrl ?? normalizeUrl(url)
  const structuredContent = {
    requestedUrl: url,
    finalUrl: typeof capData.url === 'string' ? capData.url : url,
    pageUrl,
    ...(typeof args.focus === 'string' ? { focus: args.focus } : {}),
    viewportOnly: args.viewportOnly === true,
    preNavigationNetwork: {
      totalSeen: preNavigationNetwork.totalSeen,
      capturedCount: preNavigationNetwork.captured.length,
      bodyCount: preNavigationNetwork.bodies.length,
      filter: preNavigationNetwork.filter,
      captured: preNavigationNetwork.captured,
      bodies: preNavigationNetwork.bodies
    },
    timings: {
      preflightMs: beforeNavigateMs,
      navigateCaptureMs,
      readableMs,
      extractMs,
      digestMs,
      totalMs: Date.now() - started
    }
  }
  const timedDigest = [
    `FETCH TIMINGS: preflight=${structuredContent.timings.preflightMs}ms navigateCapture=${structuredContent.timings.navigateCaptureMs}ms readable=${structuredContent.timings.readableMs}ms extract=${structuredContent.timings.extractMs}ms digest=${structuredContent.timings.digestMs}ms total=${structuredContent.timings.totalMs}ms`,
    `REQUESTED URL: ${url}`,
    finalUrl && finalUrl !== normalizeUrl(url) ? `FINAL URL: ${capData.url}` : null,
    `PRE-NAV NETWORK: ${preNavigationNetwork.totalSeen} request(s), ${preNavigationNetwork.bodies.length} bod${preNavigationNetwork.bodies.length === 1 ? 'y' : 'ies'} captured`,
    '',
    digest
  ].filter((line): line is string => line !== null).join('\n')
  const networkSummary = summarizeNetworkCapture(preNavigationNetwork, { label: 'PRE-NAV NETWORK' })
  deps.rememberDone(ctx, memKey, timedDigest)
  if (finalUrl && finalUrl !== memKey.slice('fetch:'.length)) {
    deps.rememberDone(ctx, `fetch:${finalUrl}`, timedDigest)
  }
  // cap is exposed for symmetry with other tool outcomes if callers later
  // post-process; the digest is already bounded by digestPage internally.
  return {
    ok: true,
    text: cap(`${timedDigest}\n${networkSummary.text}`, 60_000),
    structuredContent: {
      ...structuredContent,
      preNavigationNetwork: networkSummary.structuredContent
    }
  }
}

async function waitForVisibleNavigationReadable(
  tabs: TabManager,
  tabId: string,
  expectedUrl: string,
  previousUrl: string | null = null,
  timeoutMs = 1_200
): Promise<void> {
  const expected = normalizeUrl(expectedUrl)
  const previous = previousUrl ? normalizeUrl(previousUrl) : null
  const initial = await currentPageReadiness(tabs, tabId)
  if (isReadableNavigationState(initial, expected, previous)) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await currentPageReadiness(tabs, tabId)
    if (isReadableNavigationState(state, expected, previous)) return
    await sleep(50)
  }
}

async function currentPageReadiness(
  tabs: TabManager,
  tabId: string
): Promise<{ url: string | null; readyState: string | null }> {
  try {
    const res = (await tabs.cdpSend(tabId, 'Runtime.evaluate', {
      expression: `({ url: location.href, readyState: document.readyState })`,
      returnByValue: true
    })) as { result?: { value?: { url?: string; readyState?: string } } }
    return {
      url: typeof res.result?.value?.url === 'string' ? res.result.value.url : null,
      readyState: typeof res.result?.value?.readyState === 'string' ? res.result.value.readyState : null
    }
  } catch {
    return { url: null, readyState: null }
  }
}

function isReadableNavigationState(
  state: { url: string | null; readyState: string | null },
  expected: string,
  previous: string | null
): boolean {
  const current = state.url ? normalizeUrl(state.url) : null
  const readable = state.readyState === 'interactive' || state.readyState === 'complete'
  return !!current && readable && (current === expected || (previous !== null && current !== previous))
}

function currentVisibleTabUrl(tabs: TabManager, tabId: string): string | null {
  try {
    const match = tabs.list().find((tab) => tab.id === tabId)
    return typeof match?.url === 'string' ? match.url : null
  } catch {
    return null
  }
}
