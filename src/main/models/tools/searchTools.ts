import type { TabManager } from '../../TabManager'
import type { PageExtractor } from '../../extract/PageExtractor'
import type { KeyStore } from '../KeyStore'
import type { ToolContext, ToolOutcome } from '../browserTools'
import { runUnifiedSearch } from '../unifiedSearch'
import { clampInt } from './toolUtils'
import { summarizeNetworkCapture } from './perceiveTools'

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
