import type { TabManager } from '../../TabManager'
import type { PageExtractor } from '../../extract/PageExtractor'
import type { KeyStore } from '../KeyStore'
import type { ToolContext, ToolOutcome } from '../browserTools'
import { shouldUseDirectBrowserTools } from '../../../../shared/types'
import { digestPage } from '../PageDigest'
import { runDeepSearch } from '../deepSearch'
import { runUnifiedSearch } from '../unifiedSearch'
import { cap, clampInt, normalizeUrl, sleep } from './toolUtils'

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
      navigateVisible: resolveSearchNavigationMode(args, ctx)
    }
  )
  if (!outcome.ok) return { ok: false, text: outcome.text }
  deps.rememberDone(ctx, memKey, outcome.text)
  return { ok: true, text: outcome.text }
}

function resolveSearchNavigationMode(args: Record<string, any>, ctx: ToolContext): boolean {
  if (typeof args.navigate_visible === 'boolean') return args.navigate_visible
  const latestUserText = ctx.latestUserText ?? ''
  return (
    shouldUseDirectBrowserTools(latestUserText) ||
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

  return outcome
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
  const beforeNav = await currentPageReadiness(deps.tabs, ctx.tabId)
  const beforeNavigateMs = Date.now() - started
  const navigateStarted = Date.now()
  deps.tabs.navigate(ctx.tabId, url)
  const navigateDispatchMs = Date.now() - navigateStarted
  const readableStarted = Date.now()
  await waitForVisibleNavigationReadable(deps.tabs, ctx.tabId, url, beforeNav.url)
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
  const timedDigest = [
    `FETCH TIMINGS: preflight=${beforeNavigateMs}ms dispatch=${navigateDispatchMs}ms readable=${readableMs}ms extract=${extractMs}ms digest=${digestMs}ms total=${Date.now() - started}ms`,
    `REQUESTED URL: ${url}`,
    finalUrl && finalUrl !== normalizeUrl(url) ? `FINAL URL: ${capData.url}` : null,
    '',
    digest
  ].filter((line): line is string => line !== null).join('\n')
  deps.rememberDone(ctx, memKey, timedDigest)
  if (finalUrl && finalUrl !== memKey.slice('fetch:'.length)) {
    deps.rememberDone(ctx, `fetch:${finalUrl}`, timedDigest)
  }
  // cap is exposed for symmetry with other tool outcomes if callers later
  // post-process; the digest is already bounded by digestPage internally.
  return { ok: true, text: cap(timedDigest, 60_000) }
}

async function waitForVisibleNavigationReadable(
  tabs: TabManager,
  tabId: string,
  expectedUrl: string,
  previousUrl: string | null = null,
  timeoutMs = 4_000
): Promise<void> {
  const expected = normalizeUrl(expectedUrl)
  const previous = previousUrl ? normalizeUrl(previousUrl) : null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await currentPageReadiness(tabs, tabId)
    const current = state.url ? normalizeUrl(state.url) : null
    const readable = state.readyState !== 'loading'
    if (current && readable && (current === expected || (previous !== null && current !== previous))) return
    await sleep(100)
  }
  await tabs.waitForNavigationSettled(tabId, 750)
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
