import type { TabManager } from '../../TabManager'
import type { PageExtractor } from '../../extract/PageExtractor'
import type { ToolOutcome } from '../browserTools'
import { digestPage } from '../PageDigest'
import { captureAxSnapshotForTab, digestAxSnapshot } from '../../extract/axTree'
import { buildPageWireframe, formatPageWireframe } from '../../extract/pageWireframe'
import type { PageCapture } from '../../../../shared/extraction'
import type { SavedPage } from '../../extract/pageStore'
import { waitForTextStable } from './toolUtils'
import type { CapturedNetworkBody, CapturedNetworkRequest } from '../../network/watchNetworkRecorder'
import type { NetworkFilterSpec } from '../../network/watchNetworkRecorder'
import {
  formatDataSourceDiscovery,
  summarizeDataSourceDiscovery,
  type NetworkAwarenessState
} from '../../network/dataSourceDiscovery'

export interface ReadPageCacheEntry {
  pageUrl: string
  digest: string
  capturedAt: number
}

export interface ReadA11yCacheEntry {
  pageUrl: string
  digest: string
  snapshot: import('../../extract/axTree').AxSnapshot
  capturedAt: number
}

export interface ReadPageCacheStats {
  hits: number
  misses: number
  expired: number
  evictions: number
  size: number
  limit: number
  ttlMs: number
}

export interface PerceiveToolsDeps {
  tabs: TabManager
  extractor: PageExtractor
  /** Read-through digest cache, keyed by `${tabId}:${focus}:${viewportOnly}`. */
  pageCache: Map<string, ReadPageCacheEntry>
  pageCacheLimit: number
  pageCacheTtlMs: number
  /** Read-through digest cache for read_a11y. */
  a11yCache: Map<string, ReadA11yCacheEntry>
  a11yCacheLimit: number
  a11yCacheTtlMs: number
  /** Latest read_a11y snapshot per tab for @aN ref resolution in action tools. */
  setAxRefStore: (tabId: string, entry: ReadA11yCacheEntry) => void
  appCapture: (() => Promise<string>) | null
  getPageCacheStats: () => ReadPageCacheStats
  getA11yCacheStats: () => ReadPageCacheStats
  recordPageCacheEvent: (event: 'hit' | 'miss' | 'expired' | 'evicted') => void
  recordA11yCacheEvent: (event: 'hit' | 'miss' | 'expired' | 'evicted') => void
  /** Persist a re-captured page after wait_for_load, mirroring navigate's save. */
  savePage?: (cap: PageCapture, conversationId: string | null | undefined) => Promise<SavedPage>
}

const DISCOVER_DATA_SOURCES_CACHE_TTL_MS = 30_000

export async function runReadPage(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  const cacheKey = `${tabId}:${args.focus ?? ''}:${args.viewportOnly === true}`
  const now = Date.now()
  const currentUrl = normalizePageUrl(deps.tabs.getTabUrl(tabId))
  const cached = deps.pageCache.get(cacheKey)

  if (cached) {
    if (cached.pageUrl === currentUrl && now - cached.capturedAt <= deps.pageCacheTtlMs) {
      deps.recordPageCacheEvent('hit')
      return {
        ok: true,
        text: appendReadPageCacheMetrics(cached.digest, deps.getPageCacheStats()),
        structuredContent: {
          pageUrl: cached.pageUrl,
          focus: typeof args.focus === 'string' ? args.focus : undefined,
          viewportOnly: args.viewportOnly === true,
          digest: cached.digest,
          cache: {
            status: 'hit',
            capturedAt: cached.capturedAt,
            ...deps.getPageCacheStats()
          }
        }
      }
    }
    if (cached.pageUrl === currentUrl) {
      deps.recordPageCacheEvent('expired')
    }
    if (deps.pageCache.delete(cacheKey)) {
      deps.recordPageCacheEvent('evicted')
    }
    deps.recordPageCacheEvent('miss')
  } else {
    deps.recordPageCacheEvent('miss')
  }

  const capData = await deps.extractor.run(tabId)
  const resolvedUrl = normalizePageUrl(typeof capData.url === 'string' ? capData.url : currentUrl)
  const digest = digestPage(capData, {
    focus: args.focus ? String(args.focus) : undefined,
    viewportOnly: args.viewportOnly === true
  })
  const nowCaptured = Date.now()

  if (deps.pageCache.size >= deps.pageCacheLimit) {
    const first = deps.pageCache.keys().next().value
    if (first !== undefined) deps.pageCache.delete(first)
    deps.recordPageCacheEvent('evicted')
  }
  deps.pageCache.set(cacheKey, { pageUrl: resolvedUrl, digest, capturedAt: nowCaptured })
  return {
    ok: true,
    text: appendReadPageCacheMetrics(digest, deps.getPageCacheStats()),
    structuredContent: {
      pageUrl: resolvedUrl,
      focus: typeof args.focus === 'string' ? args.focus : undefined,
      viewportOnly: args.viewportOnly === true,
      digest,
      cache: {
        status: 'miss',
        capturedAt: nowCaptured,
        ...deps.getPageCacheStats()
      }
    }
  }
}

/**
 * wait_for_load — content-stabilize, then re-capture.
 *
 * navigate captures at readyState:complete, which for a client-rendered SPA
 * (Google Maps, etc.) is the empty "Loading" shell — the real content renders
 * seconds later. When a capture looks thin/loading, the model calls this: it
 * polls document.body.innerText.length until it STOPS GROWING across a few
 * samples (or a max timeout), then re-runs the extractor and returns a fresh
 * document-order wireframe + re-saves the page. Static pages return almost
 * immediately (text is already stable); SPAs get the extra second they need.
 */
export async function runWaitForLoad(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string,
  conversationId?: string | null
): Promise<ToolOutcome> {
  const maxMs = Math.min(Math.max(Number(args.timeout_ms) || 6_000, 1_000), 15_000)
  const { stabilized, textLen: finalLen } = await waitForTextStable(
    (code) => deps.tabs.executeJavaScript(tabId, code),
    maxMs
  )
  // Re-capture the now-settled page (fresh wireframe + re-save to disk).
  let wireframe: ReturnType<typeof buildPageWireframe> | null = null
  let saved: SavedPage | null = null
  try {
    const cap: PageCapture = await deps.extractor.run(tabId)
    wireframe = buildPageWireframe(cap)
    if (deps.savePage) {
      try {
        saved = await deps.savePage(cap, conversationId)
      } catch {
        saved = null
      }
    }
  } catch {
    wireframe = null
  }

  const status = stabilized
    ? `Content settled (~${finalLen.toLocaleString()} chars).`
    : finalLen > 0
      ? `Content did not fully stabilize before ${maxMs}ms, but the page now has ~${finalLen.toLocaleString()} chars — re-captured its current state.`
      : `Page still appears empty after ${maxMs}ms; it may require interaction, be blocked, or genuinely have no text content.`
  const savedText = saved
    ? `\nSaved full page: ${saved.markdownPath} · ${saved.actionsPath} (read/grep locally).`
    : ''
  const wireframeText = wireframe ? `\n${formatPageWireframe(wireframe)}` : ''

  return {
    ok: true,
    text: `${status}${savedText}${wireframeText}`,
    structuredContent: {
      stabilized,
      bodyTextChars: finalLen,
      timeoutMs: maxMs,
      ...(saved ? { savedMarkdownPath: saved.markdownPath, savedActionsPath: saved.actionsPath } : {}),
      ...(wireframe ? { wireframe } : {})
    }
  }
}

function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function appendReadPageCacheMetrics(digest: string, stats: ReadPageCacheStats): string {
  return `${digest}\n[read_page cache] size=${stats.size}/${stats.limit}, ttl=${stats.ttlMs}ms, hits=${stats.hits}, misses=${stats.misses}, expired=${stats.expired}, evictions=${stats.evictions}`
}

function appendA11yCacheMetrics(digest: string, stats: ReadPageCacheStats): string {
  return `${digest}\n[read_a11y cache] size=${stats.size}/${stats.limit}, ttl=${stats.ttlMs}ms, hits=${stats.hits}, misses=${stats.misses}, expired=${stats.expired}, evictions=${stats.evictions}`
}

function a11yCacheKey(tabId: string, args: Record<string, any>): string {
  return `${tabId}:${args.focus ?? ''}:${args.viewportOnly === true}:${args.interactiveOnly !== false}`
}

function storeAxRefs(deps: PerceiveToolsDeps, tabId: string, entry: ReadA11yCacheEntry): void {
  deps.setAxRefStore(tabId, entry)
}

export async function runReadA11y(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  try {
    const focus = typeof args.focus === 'string' ? args.focus : undefined
    const viewportOnly = args.viewportOnly === true
    const interactiveOnly = args.interactiveOnly !== false
    const cacheKey = a11yCacheKey(tabId, args)
    const now = Date.now()
    const currentUrl = normalizePageUrl(deps.tabs.getTabUrl(tabId))
    const cached = deps.a11yCache.get(cacheKey)

    if (cached) {
      if (cached.pageUrl === currentUrl && now - cached.capturedAt <= deps.a11yCacheTtlMs) {
        deps.recordA11yCacheEvent('hit')
        storeAxRefs(deps, tabId, cached)
        return {
          ok: true,
          text: appendA11yCacheMetrics(cached.digest, deps.getA11yCacheStats()),
          structuredContent: {
            pageUrl: cached.pageUrl,
            title: cached.snapshot.title,
            focus,
            viewportOnly,
            interactiveOnly,
            totalSeen: cached.snapshot.totalSeen,
            truncated: cached.snapshot.truncated,
            cache: {
              status: 'hit',
              capturedAt: cached.capturedAt,
              ...deps.getA11yCacheStats()
            },
            nodes: cached.snapshot.nodes.map((node) => ({
              ref: node.ref,
              role: node.role,
              name: node.name,
              value: node.value,
              states: node.states,
              inViewport: node.inViewport,
              ...(node.bounds ? { bounds: node.bounds } : {}),
              ...(node.frameLabel ? { frameLabel: node.frameLabel } : {})
            }))
          }
        }
      }
      if (cached.pageUrl === currentUrl) {
        deps.recordA11yCacheEvent('expired')
      }
      if (deps.a11yCache.delete(cacheKey)) {
        deps.recordA11yCacheEvent('evicted')
      }
      deps.recordA11yCacheEvent('miss')
    } else {
      deps.recordA11yCacheEvent('miss')
    }

    const snapshot = await captureAxSnapshotForTab(deps.tabs, tabId, {
      focus,
      viewportOnly,
      interactiveOnly
    })
    const digest = digestAxSnapshot(snapshot, { focus, viewportOnly, interactiveOnly })
    const nowCaptured = Date.now()
    const resolvedUrl = normalizePageUrl(snapshot.url || currentUrl)
    const entry: ReadA11yCacheEntry = {
      pageUrl: resolvedUrl,
      digest,
      snapshot,
      capturedAt: nowCaptured
    }

    if (deps.a11yCache.size >= deps.a11yCacheLimit) {
      const first = deps.a11yCache.keys().next().value
      if (first !== undefined) deps.a11yCache.delete(first)
      deps.recordA11yCacheEvent('evicted')
    }
    deps.a11yCache.set(cacheKey, entry)
    storeAxRefs(deps, tabId, entry)

    return {
      ok: true,
      text: appendA11yCacheMetrics(digest, deps.getA11yCacheStats()),
      structuredContent: {
        pageUrl: resolvedUrl,
        title: snapshot.title,
        focus,
        viewportOnly,
        interactiveOnly,
        totalSeen: snapshot.totalSeen,
        truncated: snapshot.truncated,
        cache: {
          status: 'miss',
          capturedAt: nowCaptured,
          ...deps.getA11yCacheStats()
        },
        nodes: snapshot.nodes.map((node) => ({
          ref: node.ref,
          role: node.role,
          name: node.name,
          value: node.value,
          states: node.states,
          inViewport: node.inViewport,
          ...(node.bounds ? { bounds: node.bounds } : {}),
          ...(node.frameLabel ? { frameLabel: node.frameLabel } : {})
        }))
      }
    }
  } catch (err: any) {
    return { ok: false, text: `read_a11y error: ${err?.message ?? err}` }
  }
}

export async function runScreenshot(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  const fullPage = args.fullPage === true
  const imageBase64 = await deps.tabs.capturePagePng(tabId, fullPage)
  return {
    ok: true,
    text: `${fullPage ? 'Full-page' : 'Visible viewport'} screenshot of the active tab captured.`,
    imageBase64,
    structuredContent: {
      target: 'active_tab',
      fullPage,
      mimeType: 'image/png'
    }
  }
}

export async function runScreenshotApp(deps: PerceiveToolsDeps): Promise<ToolOutcome> {
  if (!deps.appCapture) {
    return { ok: false, text: 'screenshot_app: app capture not available.' }
  }
  const dataUrl = await deps.appCapture()
  // appCapture returns a data: URL; strip the prefix for the image field.
  const imageBase64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  if (!imageBase64) {
    return { ok: false, text: 'screenshot_app: could not capture the app window.' }
  }
  return {
    ok: true,
    text: 'Screenshot of the entire Gladdis app window captured.',
    imageBase64,
    structuredContent: {
      target: 'app_window',
      mimeType: 'image/png'
    }
  }
}

export interface GrepMatch {
  type: 'text_match' | 'text_lead' | 'selector_match' | 'error'
  message?: string
  matchedLine?: string
  lineIndex?: number
  context?: string
  selector?: string | null
  coordinates?: { x: number; y: number; width: number; height: number; top: number; left: number } | null
  visible?: boolean
  tagName?: string | null
  outerHTML?: string
  innerText?: string
  leadScore?: number
  overlapTerms?: string[]
}

export async function executeGrepInTab(
  tabs: TabManager,
  tabId: string,
  query: string,
  type: 'text' | 'regex' | 'selector' = 'text',
  caseSensitive: boolean = false,
  contextLines: number = 2
): Promise<{ success: boolean; result?: any[]; totalMatches?: number; qualifiedLeads?: any[]; error?: string }> {
  const jsPayload = `
    const query = ${JSON.stringify(query)};
    const type = ${JSON.stringify(type)};
    const contextLines = ${contextLines};
    const caseSensitive = ${caseSensitive};

    function isElementVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function getElementCoords(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left)
      };
    }

    function getCssSelector(el) {
      if (!(el instanceof Element)) return '';
      const path = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.nodeName.toLowerCase();
        if (current.id) {
          selector += '#' + current.id;
          path.unshift(selector);
          break;
        } else {
          let sib = current;
          let sibIndex = 1;
          while (sib = sib.previousElementSibling) {
            if (sib.nodeName.toLowerCase() === current.nodeName.toLowerCase()) {
              sibIndex++;
            }
          }
          selector += ':nth-of-type(' + sibIndex + ')';
        }
        path.unshift(selector);
        current = current.parentNode;
      }
      return path.join(' > ');
    }

    function findBestElementForText(textStr) {
      if (!textStr || textStr.length < 2) return null;
      const elements = document.querySelectorAll('p, span, a, button, h1, h2, h3, h4, h5, h6, li, td, th, label, div, input, textarea');
      let bestEl = null;
      let bestDepth = -1;
      const wantWs = normalizeWs(textStr);

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.innerText && normalizeWs(el.innerText).includes(wantWs) && isElementVisible(el)) {
          let depth = 0;
          let parent = el.parentNode;
          while (parent) {
            depth++;
            parent = parent.parentNode;
          }
          if (depth > bestDepth) {
            bestDepth = depth;
            bestEl = el;
          }
        }
      }
      return bestEl;
    }

    // Same 300-char budget the selector branch uses for outerHTML/innerText, so
    // text matches can't ship full paragraphs. Centers the window on the actual
    // hit (not the paragraph start) so a broad term returns a usable snippet per
    // place it appears instead of the whole block — the map stays, the bulk goes.
    const SNIPPET_CHARS = 300;
    function snippetAround(str, re) {
      if (!str || str.length <= SNIPPET_CHARS) return str;
      re.lastIndex = 0;
      const m = re.exec(str);
      const hit = m ? m.index : 0;
      const half = Math.floor(SNIPPET_CHARS / 2);
      let start = Math.max(0, hit - half);
      let end = Math.min(str.length, start + SNIPPET_CHARS);
      start = Math.max(0, end - SNIPPET_CHARS);
      return (start > 0 ? '…' : '') + str.slice(start, end) + (end < str.length ? '…' : '');
    }

    // Collapse every run of whitespace (incl. non-breaking space \\u00a0, which
    // HN/Wikipedia use between a count and its label like "436\\u00a0comments")
    // to a single regular space. Applied to BOTH the page text and a literal
    // query so "436 comments" matches "436\\u00a0comments" instead of silently
    // missing — the most common real-page text-match failure.
    function normalizeWs(s) {
      return (s || '').replace(/[\\s\\u00a0]+/g, ' ');
    }

    // Form controls carry their name in aria-label / placeholder / name / an
    // associated <label>, not in innerText — so a plain innerText grep for
    // "Departure" or "Where to?" finds nothing even though the field is right
    // there, visible and named. This pass matches interactive controls by their
    // ACCESSIBLE LABEL so set_field / submit / act / grep_page can target
    // "fill the Departure field" the obvious way. Exact-label hits rank ahead of
    // startsWith ahead of substring; ties break by document order.
    function findControlMatchesByLabel(pattern) {
      const want = normalizeWs(pattern).trim().toLowerCase();
      if (!want) return [];
      const controls = Array.from(document.querySelectorAll(
        'input:not([type=hidden]), textarea, select, [role="combobox"], [role="textbox"], [role="searchbox"], [role="spinbutton"], [contenteditable="true"]'
      ));
      const scored = [];
      for (const el of controls) {
        if (!isElementVisible(el)) continue;
        const labels = [];
        const al = el.getAttribute('aria-label');
        const ph = el.getAttribute('placeholder');
        const nm = el.getAttribute('name');
        if (al) labels.push(al);
        if (ph) labels.push(ph);
        if (nm) labels.push(nm);
        if (el.id) {
          try {
            const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
            if (lab && lab.innerText) labels.push(lab.innerText);
          } catch (e) { /* invalid id for selector — skip */ }
        }
        let best = -1;
        for (const raw of labels) {
          const lab = normalizeWs(raw).trim().toLowerCase();
          if (!lab) continue;
          if (lab === want) { best = 3; break; }
          if (lab.startsWith(want)) best = Math.max(best, 2);
          else if (lab.includes(want)) best = Math.max(best, 1);
        }
        if (best < 0) continue;
        const coords = getElementCoords(el);
        if (!coords) continue;
        scored.push({
          rank: best,
          match: {
            type: 'control_match',
            tagName: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            label: normalizeWs(labels[0] || '').trim().slice(0, 80),
            outerHTML: el.outerHTML.slice(0, 300),
            innerText: '',
            selector: getCssSelector(el),
            coordinates: coords,
            visible: true
          }
        });
      }
      scored.sort((a, b) => b.rank - a.rank);
      return scored.slice(0, 8).map((s) => s.match);
    }

    function tokenizeText(s) {
      const cleaned = normalizeWs(String(s || ''))
        .toLowerCase()
        .replace(/(\\d),(\\d)/g, '$1$2');
      return cleaned.match(/[a-z0-9]+(?:\\.[0-9]+)?/g) || [];
    }

    function canonicalizeToken(token) {
      const t = String(token || '').toLowerCase();
      if (!t) return '';
      if (/^\\d+(?:\\.\\d+)?$/.test(t)) return t;
      const synonyms = {
        height: 'height',
        tall: 'height',
        taller: 'height',
        metre: 'metre',
        metres: 'metre',
        meter: 'metre',
        meters: 'metre',
        foot: 'foot',
        feet: 'foot',
        ft: 'foot',
        complete: 'complete',
        completed: 'complete',
        completion: 'complete',
        finish: 'complete',
        finished: 'complete',
        year: 'year',
        years: 'year',
        design: 'design',
        designed: 'design',
        designer: 'design'
      };
      return synonyms[t] || t;
    }

    function isInformativeToken(token) {
      return /^\\d/.test(token) || token.length >= 3;
    }

    function queryTokenProfile(pattern) {
      const stopwords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'have', 'what', 'when', 'where']);
      return Array.from(new Set(
        tokenizeText(pattern)
          .map(canonicalizeToken)
          .filter((token) => token && isInformativeToken(token) && !stopwords.has(token))
      ));
    }

    function findQualifiedTextLeads(pattern, contextLines) {
      const text = document.body ? (document.body.innerText || "") : "";
      const lines = text.split('\\n');
      const queryTokens = queryTokenProfile(pattern);
      if (queryTokens.length < 2) return [];

      const unitTokens = new Set(['metre', 'foot', 'year']);
      const leads = [];

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const lineTokens = Array.from(new Set(
          tokenizeText(trimmed)
            .map(canonicalizeToken)
            .filter((token) => token && isInformativeToken(token))
        ));
        const overlapTerms = queryTokens.filter((token) => lineTokens.includes(token));
        if (overlapTerms.length < 2) return;

        const nonUnitOverlap = overlapTerms.filter((token) => !unitTokens.has(token) && !/^\\d/.test(token));
        const score = overlapTerms.length / queryTokens.length;
        if (score < 0.5 && nonUnitOverlap.length === 0) return;

        const startLine = Math.max(0, index - contextLines);
        const endLine = Math.min(lines.length - 1, index + contextLines);
        const context = lines.slice(startLine, endLine + 1).join('\\n');
        const element = findBestElementForText(trimmed);
        const coords = element ? getElementCoords(element) : null;
        const selector = element ? getCssSelector(element) : null;
        const isVisible = element ? isElementVisible(element) : false;

        leads.push({
          type: 'text_lead',
          matchedLine: trimmed,
          lineIndex: index + 1,
          context,
          selector,
          coordinates: coords,
          visible: isVisible,
          tagName: element ? element.tagName.toLowerCase() : null,
          leadScore: Number(score.toFixed(3)),
          overlapTerms
        });
      });

      leads.sort((a, b) => {
        if ((b.leadScore || 0) !== (a.leadScore || 0)) return (b.leadScore || 0) - (a.leadScore || 0);
        return (a.lineIndex || 0) - (b.lineIndex || 0);
      });
      return leads.slice(0, 5);
    }

    function findTextMatches(pattern, isRegex, caseSensitive, contextLines) {
      const results = [];
      const text = document.body ? (document.body.innerText || "") : "";
      const lines = text.split('\\n');
      const matchedIndices = [];

      let regex;
      if (isRegex) {
        try {
          regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
        } catch (e) {
          const escaped = normalizeWs(pattern).replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
          regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
        }
      } else {
        // Literal query: whitespace-normalize the needle and match it against the
        // whitespace-normalized line, so spacing/nbsp differences never miss.
        const escaped = normalizeWs(pattern).replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&').replace(/ /g, '\\\\s+');
        regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
      }

      lines.forEach((line, index) => {
        regex.lastIndex = 0;
        if (regex.test(normalizeWs(line))) {
          matchedIndices.push(index);
        }
      });

      matchedIndices.forEach(index => {
        const line = lines[index];
        const startLine = Math.max(0, index - contextLines);
        const endLine = Math.min(lines.length - 1, index + contextLines);
        const context = lines.slice(startLine, endLine + 1).join('\\n');

        const element = findBestElementForText(line.trim());
        const coords = element ? getElementCoords(element) : null;
        const selector = element ? getCssSelector(element) : null;
        const isVisible = element ? isElementVisible(element) : false;

        results.push({
          type: 'text_match',
          matchedLine: snippetAround(line.trim(), regex),
          lineIndex: index + 1,
          context: snippetAround(context, regex),
          selector,
          coordinates: coords,
          visible: isVisible,
          tagName: element ? element.tagName.toLowerCase() : null
        });
      });

      return results;
    }

    function findSelectorMatches(sel) {
      const results = [];
      try {
        let elements = [];
        if (sel.startsWith('/') || sel.startsWith('(') || sel.startsWith('./')) {
          const xpathResult = document.evaluate(sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < xpathResult.snapshotLength; i++) {
            elements.push(xpathResult.snapshotItem(i));
          }
        } else {
          elements = Array.from(document.querySelectorAll(sel));
        }

        elements.forEach(el => {
          if (el && el.nodeType === Node.ELEMENT_NODE) {
            const coords = getElementCoords(el);
            results.push({
              type: 'selector_match',
              tagName: el.tagName.toLowerCase(),
              outerHTML: el.outerHTML.slice(0, 300),
              innerText: (el.innerText || "").slice(0, 300),
              selector: getCssSelector(el),
              coordinates: coords,
              visible: isElementVisible(el)
            });
          }
        });
      } catch (err) {
        results.push({
          type: 'error',
          message: 'Invalid CSS or XPath selector: ' + err.message
        });
      }
      return results;
    }

    if (!document || !document.body) {
      return [];
    }

    let textResults = [];
    let selectorResults = [];

    if (type === 'selector') {
      selectorResults = findSelectorMatches(query);
    }

    let controlResults = [];
    if (type === 'text' || type === 'regex') {
      const isRegex = (type === 'regex');
      textResults = findTextMatches(query, isRegex, caseSensitive, contextLines);
    }
    // Label-match form controls for literal text queries. Controls named only by
    // aria-label/placeholder are invisible to innerText grep, so without this a
    // set_field/act query like "Departure" resolves to nothing. Regex queries
    // are excluded — a label pattern is meant for prose, not control names.
    if (type === 'text') {
      controlResults = findControlMatchesByLabel(query);
    }

    // Controls first: when a query names a form field, acting on the field beats
    // acting on a stray text node that happens to share the word.
    const combined = [...controlResults, ...selectorResults, ...textResults];
    const qualifiedLeads = type === 'text' && combined.length === 0
      ? findQualifiedTextLeads(query, contextLines)
      : [];
    // Return the pre-slice total so the caller can honestly report truncation
    // instead of a flat 50 that hides "there were far more".
    return { matches: combined.slice(0, 50), totalMatches: combined.length, qualifiedLeads };
  `;

  const runResult = await tabs.executeJavaScript(tabId, jsPayload)
  if (!runResult.success) {
    return { success: false, error: runResult.error }
  }
  const payload = runResult.result as { matches?: any[]; totalMatches?: number; qualifiedLeads?: any[] } | any[]
  // Tolerate both the new {matches,totalMatches} shape and a bare array.
  const matches = Array.isArray(payload) ? payload : (payload?.matches ?? [])
  const totalMatches = Array.isArray(payload) ? payload.length : (payload?.totalMatches ?? matches.length)
  const qualifiedLeads = Array.isArray(payload) ? [] : (payload?.qualifiedLeads ?? [])
  return { success: true, result: matches, totalMatches, qualifiedLeads }
}

export async function runGrepPage(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  const query = args.query
  if (typeof query !== 'string' || !query.trim()) {
    return { ok: false, text: 'grep_page: query must be a non-empty string.' }
  }

  const type = args.type || 'text'
  if (type !== 'text' && type !== 'regex' && type !== 'selector') {
    return { ok: false, text: 'grep_page: type must be "text", "regex", or "selector".' }
  }
  const contextLines = typeof args.contextLines === 'number' ? args.contextLines : 2
  const caseSensitive = !!args.caseSensitive

  try {
    const runResult = await executeGrepInTab(deps.tabs, tabId, query, type, caseSensitive, contextLines)
    if (!runResult.success) {
      return { ok: false, text: `grep_page: failed to execute hybrid search in page: ${runResult.error}` }
    }

    const matches = runResult.result as any[]
    const qualifiedLeads = Array.isArray(runResult.qualifiedLeads) ? runResult.qualifiedLeads : []
    const totalMatches = runResult.totalMatches ?? (Array.isArray(matches) ? matches.length : 0)
    if (!Array.isArray(matches) || matches.length === 0) {
      if (type === 'text' && qualifiedLeads.length > 0) {
        let output = `No exact matches found for query "${query}" on the page, but ${qualifiedLeads.length} qualified lead(s) were found nearby:\n\n`
        qualifiedLeads.forEach((m, idx) => {
          output += `--- Lead #${idx + 1} (${m.type}) ---\n`
          output += `Matched Line (Line ${m.lineIndex}): "${m.matchedLine}"\n`
          if (Array.isArray(m.overlapTerms) && m.overlapTerms.length > 0) {
            output += `Overlapping terms: ${m.overlapTerms.join(', ')}\n`
          }
          if (typeof m.leadScore === 'number') {
            output += `Lead score: ${m.leadScore}\n`
          }
          if (m.tagName) {
            output += `Associated Tag: <${m.tagName}>\n`
          }
          if (m.selector) {
            output += `Associated CSS Selector: ${m.selector}\n`
          }
          if (m.coordinates) {
            output += `Coordinates (center x,y): (${m.coordinates.x}, ${m.coordinates.y})\n`
          }
          output += `Context (grep -C ${contextLines}):\n\`\`\`\n${m.context}\n\`\`\`\n\n`
        })

        return {
          ok: true,
          text: output.trim(),
          structuredContent: {
            query,
            type,
            caseSensitive,
            contextLines,
            matches: [],
            qualifiedLeads: qualifiedLeads.filter((lead) => lead && typeof lead === 'object'),
            totalMatches: 0,
            truncated: false
          }
        }
      }
      return {
        ok: true,
        text: `No matches found for query "${query}" on the page.`,
        structuredContent: {
          query,
          type,
          caseSensitive,
          contextLines,
          matches: [],
          qualifiedLeads: [],
          totalMatches: 0,
          truncated: false
        }
      }
    }

    const truncated = totalMatches > matches.length
    const textMatchCount = matches.filter((m) => m && m.type === 'text_match').length
    // A single common word is the wrong text query — it floods with noise and the
    // answer to the user's actual need is in a phrase, not a keyword. Steer toward
    // sentences/distinctive phrases when a bare word floods. (A distinctive single
    // word like a rare proper noun stays fine — it won't flood, so it won't trip this.)
    const isSingleWord = /^\s*\S+\s*$/.test(query)
    const floodedOnSingleWord =
      isSingleWord && textMatchCount > 0 && (truncated || textMatchCount >= 8)

    let banner = ''
    if (floodedOnSingleWord) {
      banner =
        `⚠ Broad query: the single word "${query.trim()}" matched ${totalMatches}${truncated ? '+ (truncated to ' + matches.length + ')' : ''} places — ` +
        `this is too broad to answer a question. Extract the subject from the user's request and re-grep with 1-3 tight multi-word phrase variations, ` +
        `not the whole prompt. If the same terms appear close together or in the same section, review that returned section.\n\n`
    } else if (truncated) {
      banner =
        `⚠ ${totalMatches} matches found, showing first ${matches.length} — results are a SAMPLE, not all of them. Narrow the query for full coverage.\n\n`
    }

    let output = banner + `Hybrid Grep/CDP search completed on page. Found ${matches.length} match(es)${truncated ? ' of ' + totalMatches : ''}:\n\n`
    matches.forEach((m, idx) => {
      output += `--- Match #${idx + 1} (${m.type}) ---\n`
      if (m.type === 'error') {
        output += `Error: ${m.message}\n`
      } else if (m.type === 'selector_match') {
        output += `Tag: <${m.tagName}>\n`
        output += `CSS Selector: ${m.selector}\n`
        output += `Visible: ${m.visible}\n`
        if (m.coordinates) {
          output += `Coordinates (center x,y): (${m.coordinates.x}, ${m.coordinates.y}) (width: ${m.coordinates.width}, height: ${m.coordinates.height})\n`
        }
        if (m.innerText.trim()) {
          output += `Text Content: "${m.innerText.trim()}"\n`
        }
        output += `HTML snippet: ${m.outerHTML}\n`
      } else if (m.type === 'text_match') {
        output += `Matched Line (Line ${m.lineIndex}): "${m.matchedLine}"\n`
        if (m.tagName) {
          output += `Associated Tag: <${m.tagName}>\n`
        }
        if (m.selector) {
          output += `Associated CSS Selector: ${m.selector}\n`
        }
        if (m.coordinates) {
          output += `Coordinates (center x,y): (${m.coordinates.x}, ${m.coordinates.y})\n`
        }
        output += `Context (grep -C ${contextLines}):\n\`\`\`\n${m.context}\n\`\`\`\n`
      }
      output += `\n`
    })

    return {
      ok: true,
      text: output.trim(),
      structuredContent: {
        query,
        type,
        caseSensitive,
        contextLines,
        matches: matches.filter((match) => match && typeof match === 'object'),
        qualifiedLeads: [],
        totalMatches,
        truncated
      }
    }
  } catch (err: any) {
    return { ok: false, text: `grep_page error: ${err.message}` }
  }
}

type StructuredFieldMode = 'text' | 'attr' | 'html' | 'exists'

interface StructuredFieldSpec {
  selector?: string
  xpath?: string
  scope?: 'item' | 'page'
  mode?: StructuredFieldMode
  attr?: string
}

function isStructuredFieldSpec(value: unknown): value is StructuredFieldSpec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateStructuredFieldSpec(name: string, value: unknown): string | null {
  if (!isStructuredFieldSpec(value)) {
    return `extract_structured: field "${name}" must be an object.`
  }
  if (value.selector !== undefined && typeof value.selector !== 'string') {
    return `extract_structured: field "${name}".selector must be a string.`
  }
  if (value.xpath !== undefined && typeof value.xpath !== 'string') {
    return `extract_structured: field "${name}".xpath must be a string.`
  }
  if (value.selector && value.xpath) {
    return `extract_structured: field "${name}" cannot set both selector and xpath.`
  }
  if (value.scope !== undefined && value.scope !== 'item' && value.scope !== 'page') {
    return `extract_structured: field "${name}".scope must be "item" or "page".`
  }
  const mode = value.mode ?? 'text'
  if (mode !== 'text' && mode !== 'attr' && mode !== 'html' && mode !== 'exists') {
    return `extract_structured: field "${name}".mode must be "text", "attr", "html", or "exists".`
  }
  if (mode === 'attr' && (typeof value.attr !== 'string' || !value.attr.trim())) {
    return `extract_structured: field "${name}" with mode "attr" must include a non-empty attr.`
  }
  if (value.attr !== undefined && typeof value.attr !== 'string') {
    return `extract_structured: field "${name}".attr must be a string.`
  }
  return null
}

async function executeStructuredExtractInTab(
  tabs: TabManager,
  tabId: string,
  args: {
    itemSelector?: string
    itemXpath?: string
    fields: Record<string, StructuredFieldSpec>
    limit: number
    includeInvisible: boolean
    textLimit: number
    htmlLimit: number
  }
): Promise<
  | { success: true; result: { records: Array<Record<string, unknown>>; totalMatches: number } }
  | { success: false; error: string }
> {
  const jsPayload = `
    const args = ${JSON.stringify(args)};
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const clamp = (value, n) => {
      const s = String(value ?? '');
      return s.length > n ? s.slice(0, n) + '…' : s;
    };
    const isVisible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
    };
    const xpathAll = (root, xpath) => {
      const doc = root && root.ownerDocument ? root.ownerDocument : document;
      const out = [];
      const snap = doc.evaluate(
        xpath,
        root || doc,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < snap.snapshotLength; i += 1) {
        const node = snap.snapshotItem(i);
        if (node) out.push(node);
      }
      return out;
    };
    const xpathFirst = (root, xpath) => {
      const doc = root && root.ownerDocument ? root.ownerDocument : document;
      const result = doc.evaluate(
        xpath,
        root || doc,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue;
    };
    const resolveMany = () => {
      if (args.itemSelector) return Array.from(document.querySelectorAll(args.itemSelector));
      return xpathAll(document, args.itemXpath || '');
    };
    const resolveOne = (root, spec) => {
      const scopeRoot = spec.scope === 'page' ? document : root;
      if (spec.selector) return scopeRoot.querySelector(spec.selector);
      if (spec.xpath) return xpathFirst(scopeRoot, spec.xpath);
      return scopeRoot;
    };
    const readValue = (root, spec) => {
      const target = resolveOne(root, spec);
      const mode = spec.mode || 'text';
      if (mode === 'exists') return Boolean(target);
      if (!target) return null;
      if (mode === 'attr') {
        if (target instanceof Element) {
          const attrName = spec.attr || '';
          if (attrName in target && typeof target[attrName] !== 'function') {
            const prop = target[attrName];
            return prop == null ? null : clamp(prop, args.textLimit);
          }
          const attrValue = target.getAttribute(attrName);
          return attrValue == null ? null : clamp(attrValue, args.textLimit);
        }
        return null;
      }
      if (mode === 'html') {
        return target instanceof Element
          ? clamp(target.outerHTML || '', args.htmlLimit)
          : clamp(target.textContent || '', args.htmlLimit);
      }
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return clamp(norm(target.value || target.textContent || ''), args.textLimit);
      }
      return clamp(norm(target.textContent || ''), args.textLimit);
    };
    const matches = resolveMany().filter((node) => node instanceof Element);
    const filtered = args.includeInvisible ? matches : matches.filter((node) => isVisible(node));
    const records = [];
    for (const node of filtered.slice(0, args.limit)) {
      const record = {};
      for (const [name, spec] of Object.entries(args.fields)) {
        record[name] = readValue(node, spec);
      }
      records.push(record);
    }
    return { records, totalMatches: filtered.length };
  `

  const runResult = await tabs.executeJavaScript(tabId, jsPayload)
  if (!runResult.success) {
    return { success: false, error: runResult.error }
  }
  const payload = runResult.result as { records?: Array<Record<string, unknown>>; totalMatches?: number } | undefined
  return {
    success: true,
    result: {
      records: Array.isArray(payload?.records) ? payload!.records : [],
      totalMatches: typeof payload?.totalMatches === 'number' ? payload.totalMatches : 0
    }
  }
}

export async function runExtractStructured(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  const itemSelector = typeof args.item_selector === 'string' && args.item_selector.trim()
    ? args.item_selector.trim()
    : undefined
  const itemXpath = typeof args.item_xpath === 'string' && args.item_xpath.trim()
    ? args.item_xpath.trim()
    : undefined
  if (!itemSelector && !itemXpath) {
    return { ok: false, text: 'extract_structured: provide item_selector or item_xpath.' }
  }
  if (itemSelector && itemXpath) {
    return { ok: false, text: 'extract_structured: pass only one of item_selector or item_xpath.' }
  }

  const rawFields = args.fields
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    return { ok: false, text: 'extract_structured: fields must be an object mapping field names to extraction specs.' }
  }
  const fieldEntries = Object.entries(rawFields)
  if (fieldEntries.length === 0) {
    return { ok: false, text: 'extract_structured: fields must define at least one field.' }
  }
  if (fieldEntries.length > 12) {
    return { ok: false, text: 'extract_structured: keep fields small and purpose-built (max 12 fields).' }
  }

  const fields: Record<string, StructuredFieldSpec> = {}
  for (const [name, spec] of fieldEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, text: `extract_structured: invalid field name "${name}". Use simple identifier-style names.` }
    }
    const error = validateStructuredFieldSpec(name, spec)
    if (error) return { ok: false, text: error }
    fields[name] = spec as StructuredFieldSpec
  }

  const limitInput = typeof args.limit === 'number' ? args.limit : Number(args.limit)
  const limit = Number.isFinite(limitInput) ? Math.max(1, Math.min(100, Math.floor(limitInput))) : 20
  const textLimitInput = typeof args.text_limit === 'number' ? args.text_limit : Number(args.text_limit)
  const textLimit = Number.isFinite(textLimitInput) ? Math.max(40, Math.min(4000, Math.floor(textLimitInput))) : 500
  const htmlLimitInput = typeof args.html_limit === 'number' ? args.html_limit : Number(args.html_limit)
  const htmlLimit = Number.isFinite(htmlLimitInput) ? Math.max(100, Math.min(12000, Math.floor(htmlLimitInput))) : 2000
  const includeInvisible = args.include_invisible === true

  try {
    const runResult = await executeStructuredExtractInTab(deps.tabs, tabId, {
      itemSelector,
      itemXpath,
      fields,
      limit,
      includeInvisible,
      textLimit,
      htmlLimit
    })
    if (!runResult.success) {
      return { ok: false, text: `extract_structured: failed to execute in page: ${runResult.error}` }
    }

    const { records, totalMatches } = runResult.result
    const truncated = totalMatches > records.length
    const selectorLabel = itemSelector ? `selector "${itemSelector}"` : `XPath "${itemXpath}"`
    const text =
      `Structured extraction completed for ${selectorLabel}. Returned ${records.length} record(s)` +
      `${truncated ? ` of ${totalMatches}` : ''}.\n\n` +
      JSON.stringify(records, null, 2)

    return {
      ok: true,
      text,
      structuredContent: {
        itemSelector,
        itemXpath,
        limit,
        includeInvisible,
        textLimit,
        htmlLimit,
        totalMatches,
        returned: records.length,
        truncated,
        fields,
        records
      }
    }
  } catch (err: any) {
    return { ok: false, text: `extract_structured error: ${err?.message ?? err}` }
  }
}

export async function runWatchNetwork(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  try {
    const watchArgs = normalizeWatchNetworkArgs(args)
    if (watchArgs.mode === 'next_action') {
      deps.tabs.armNextNetworkCapture(tabId, {
        urlFilter: watchArgs.urlFilter,
        urlFilters: watchArgs.urlFilters,
        urlRegex: watchArgs.urlRegex,
        resourceTypes: watchArgs.resourceTypes,
        statusCodes: watchArgs.statusCodes,
        statusMin: watchArgs.statusMin,
        statusMax: watchArgs.statusMax,
        mimeIncludes: watchArgs.mimeIncludes,
        includeRequestBody: watchArgs.includeRequestBody,
        redactSensitive: watchArgs.redactSensitive,
        windowMs: watchArgs.windowMs,
        maxBodies: watchArgs.maxBodies,
        maxBodyChars: watchArgs.maxBodyChars
      })
      return {
        ok: true,
        text:
          `Armed network capture for the next browser action on this tab.` +
          (watchArgs.filterLabel ? ` Filter: ${watchArgs.filterLabel}.` : '') +
          ` The next browser-driving tool will start watching before it acts and include the captured traffic in its result.`,
        structuredContent: {
          mode: watchArgs.mode,
          armed: true,
          urlFilter: watchArgs.urlFilter,
          urlFilters: watchArgs.urlFilters,
          urlRegex: watchArgs.urlRegex,
          resourceTypes: watchArgs.resourceTypes,
          statusCodes: watchArgs.statusCodes,
          statusMin: watchArgs.statusMin,
          statusMax: watchArgs.statusMax,
          mimeIncludes: watchArgs.mimeIncludes,
          includeRequestBody: watchArgs.includeRequestBody,
          redactSensitive: watchArgs.redactSensitive,
          windowMs: watchArgs.windowMs,
          maxBodies: watchArgs.maxBodies,
          maxBodyChars: watchArgs.maxBodyChars
        }
      }
    }

    const result = await deps.tabs.watchNetwork(tabId, {
      urlFilter: watchArgs.urlFilter,
      urlFilters: watchArgs.urlFilters,
      urlRegex: watchArgs.urlRegex,
      resourceTypes: watchArgs.resourceTypes,
      statusCodes: watchArgs.statusCodes,
      statusMin: watchArgs.statusMin,
      statusMax: watchArgs.statusMax,
      mimeIncludes: watchArgs.mimeIncludes,
      includeRequestBody: watchArgs.includeRequestBody,
      redactSensitive: watchArgs.redactSensitive,
      windowMs: watchArgs.windowMs,
      maxBodies: watchArgs.maxBodies,
      maxBodyChars: watchArgs.maxBodyChars
    })

    if (result.totalSeen === 0) {
      return {
        ok: true,
        text:
          `No network requests captured in ${watchArgs.windowMs}ms` +
          (watchArgs.filterLabel ? ` matching ${watchArgs.filterLabel}` : '') +
          `. The page may be idle (passive capture only sees traffic the page fires itself) — ` +
          `trigger the data load first (scroll, click, navigate) then watch again.`,
        structuredContent: {
          mode: watchArgs.mode,
          urlFilter: watchArgs.urlFilter,
          urlFilters: watchArgs.urlFilters,
          urlRegex: watchArgs.urlRegex,
          resourceTypes: watchArgs.resourceTypes,
          statusCodes: watchArgs.statusCodes,
          statusMin: watchArgs.statusMin,
          statusMax: watchArgs.statusMax,
          mimeIncludes: watchArgs.mimeIncludes,
          includeRequestBody: watchArgs.includeRequestBody,
          redactSensitive: watchArgs.redactSensitive,
          windowMs: watchArgs.windowMs,
          maxBodies: watchArgs.maxBodies,
          maxBodyChars: watchArgs.maxBodyChars,
          totalSeen: 0,
          captured: [],
          bodies: []
        }
      }
    }

    let output =
      `Captured ${result.totalSeen} request(s)` +
      (watchArgs.filterLabel ? ` matching ${watchArgs.filterLabel}` : '') +
      ` in ${watchArgs.windowMs}ms. Showing ${result.bodies.length} response bod${result.bodies.length === 1 ? 'y' : 'ies'}`
    if (watchArgs.includeRequestBody) output += ' and request payload previews'
    if (watchArgs.redactSensitive) output += ' with sensitive values redacted'
    output += ':\n\n'

    const failed = result.captured.filter((item) => !item.success)
    if (failed.length > 0) {
      output += 'Failed requests:\n'
      for (const item of failed.slice(0, 5)) {
        output += `  [${item.status}] ${item.method} ${item.url} ${item.errorText ?? 'failed'}\n`
      }
      output += '\n'
    }

    const slowest = [...result.captured]
      .filter((item) => typeof item.durationMs === 'number')
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 3)
    if (slowest.length > 0) {
      output += 'Slowest requests:\n'
      for (const item of slowest) {
        output += `  ${Math.round(item.durationMs ?? 0)}ms ${item.method} ${item.url}\n`
      }
      output += '\n'
    }

    output += 'Endpoints seen:\n'
    for (const c of result.captured.slice(0, 25)) {
      const timing = typeof c.durationMs === 'number' ? ` ${Math.round(c.durationMs)}ms` : ''
      const size = typeof c.encodedDataLength === 'number' ? ` ${c.encodedDataLength}B` : ''
      const outcome = c.success ? 'ok' : (c.errorText ? `failed:${c.errorText}` : 'pending')
      output += `  [${c.status}] ${c.method} ${c.type} ${c.mimeType}${timing}${size} ${outcome}  ${c.url}\n`
      if (watchArgs.includeRequestBody && c.requestBody) {
        output += `    request body${c.requestBodyTruncated ? ' [truncated]' : ''}: ${c.requestBody}\n`
      }
    }
    if (result.captured.length > 25) output += `  …and ${result.captured.length - 25} more\n`
    output += '\n'

    for (const b of result.bodies) {
      output += `--- ${b.url} (${b.status}, ${b.mimeType})${b.truncated ? ' [truncated]' : ''} ---\n`
      output += '```json\n' + b.body + '\n```\n\n'
    }

    return {
      ok: true,
      text: output.trim(),
      structuredContent: {
        mode: watchArgs.mode,
        urlFilter: watchArgs.urlFilter,
        urlFilters: watchArgs.urlFilters,
        urlRegex: watchArgs.urlRegex,
        resourceTypes: watchArgs.resourceTypes,
        statusCodes: watchArgs.statusCodes,
        statusMin: watchArgs.statusMin,
        statusMax: watchArgs.statusMax,
        mimeIncludes: watchArgs.mimeIncludes,
        includeRequestBody: watchArgs.includeRequestBody,
        redactSensitive: watchArgs.redactSensitive,
        windowMs: watchArgs.windowMs,
        maxBodies: watchArgs.maxBodies,
        maxBodyChars: watchArgs.maxBodyChars,
        totalSeen: result.totalSeen,
        captured: result.captured,
        bodies: result.bodies
      }
    }
  } catch (err: any) {
    return { ok: false, text: `watch_network error: ${err?.message ?? err}` }
  }
}

export async function runDiscoverDataSources(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  try {
    const refresh = args.refresh === true
    const maxCandidatesInput = typeof args.max_candidates === 'number' ? args.max_candidates : Number(args.max_candidates)
    const maxCandidates = Number.isFinite(maxCandidatesInput)
      ? Math.max(1, Math.min(8, Math.floor(maxCandidatesInput)))
      : 5

    const currentUrl = normalizePageUrl(deps.tabs.getTabUrl(tabId))
    const cached = !refresh && typeof deps.tabs.getNetworkAwareness === 'function'
      ? deps.tabs.getNetworkAwareness(tabId)
      : null
    if (
      cached &&
      normalizePageUrl(cached.pageUrl) === currentUrl &&
      Date.now() - cached.capturedAt <= DISCOVER_DATA_SOURCES_CACHE_TTL_MS
    ) {
      return networkDiscoveryOutcome(cached, { cached: true })
    }

    const watchArgs = normalizeWatchNetworkArgs({
      ...args,
      mode: 'passive',
      max_bodies: Math.min(maxCandidates, 3)
    })
    const result = await deps.tabs.watchNetwork(tabId, {
      urlFilter: watchArgs.urlFilter,
      urlFilters: watchArgs.urlFilters,
      urlRegex: watchArgs.urlRegex,
      resourceTypes: watchArgs.resourceTypes,
      statusCodes: watchArgs.statusCodes,
      statusMin: watchArgs.statusMin,
      statusMax: watchArgs.statusMax,
      mimeIncludes: watchArgs.mimeIncludes,
      includeRequestBody: watchArgs.includeRequestBody,
      redactSensitive: watchArgs.redactSensitive,
      windowMs: watchArgs.windowMs,
      maxBodies: Math.min(watchArgs.maxBodies, Math.min(maxCandidates, 3)),
      maxBodyChars: watchArgs.maxBodyChars
    })
    const summary = summarizeDataSourceDiscovery(result, {
      pageUrl: currentUrl,
      observedWindowMs: watchArgs.windowMs,
      maxCandidates,
      capturedAt: Date.now()
    })
    return networkDiscoveryOutcome(summary, { cached: false })
  } catch (err: any) {
    return { ok: false, text: `discover_data_sources error: ${err?.message ?? err}` }
  }
}

type WatchNetworkArgSource = Record<string, any>

export function normalizeWatchNetworkArgs(args: WatchNetworkArgSource): {
  urlFilter?: string
  urlFilters?: string[]
  urlRegex?: string
  resourceTypes?: string[]
  statusCodes?: number[]
  statusMin?: number
  statusMax?: number
  mimeIncludes?: string[]
  mode: 'next_action' | 'passive'
  includeRequestBody: boolean
  redactSensitive: boolean
  filterLabel?: string
  windowMs: number
  maxBodies: number
  maxBodyChars: number
} {
  const normalizeText = (value: unknown, maxLen = 200): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLen) : undefined

  const normalizeStringArray = (value: unknown, maxLen = 200): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const items = value
      .map((item) => (typeof item === 'string' ? item.trim().slice(0, maxLen) : ''))
      .filter(Boolean)
      .slice(0, 10)
    return items.length > 0 ? items : undefined
  }

  const normalizeNumberArray = (value: unknown): number[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const items = value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
      .map((item) => Math.trunc(item))
      .filter((item) => item >= 100 && item <= 599)
      .slice(0, 20)
    return items.length > 0 ? items : undefined
  }

  const parseNumericArg = (value: unknown, key: string): number | undefined => {
    if (value === undefined) return undefined
    const num = Number(value)
    if (!Number.isFinite(num)) {
      throw new Error(`watch_network arg "${key}" must be a finite number`)
    }
    return Math.round(num)
  }

  const assertRange = (value: number, key: string, min: number, max: number): number => {
    if (value < min || value > max) {
      throw new Error(`watch_network arg "${key}" must be between ${min} and ${max}`)
    }
    return value
  }

  const pickNumericArg = (
    snake: string,
    camel: string,
    fallback: number,
    min: number,
    max: number
  ): number => {
    const snakeValue = parseNumericArg(args[snake], snake)
    const camelValue = parseNumericArg(args[camel], camel)
    if (snakeValue !== undefined && camelValue !== undefined && snakeValue !== camelValue) {
      throw new Error(`watch_network args conflict: "${snake}" and "${camel}" differ`)
    }

    const resolved = snakeValue ?? camelValue ?? fallback
    if (snakeValue === undefined && camelValue === undefined) return resolved
    return assertRange(resolved, snakeValue !== undefined ? snake : camel, min, max)
  }

  const pickTextArg = (snake: string, camel: string, maxLen = 200): string | undefined => {
    const snakeRaw = args[snake]
    const camelRaw = args[camel]
    const snakeValue = normalizeText(snakeRaw, maxLen)
    const camelValue = normalizeText(camelRaw, maxLen)
    if (snakeRaw !== undefined && camelRaw !== undefined && snakeValue !== camelValue) {
      throw new Error(`watch_network args conflict: "${snake}" and "${camel}" differ`)
    }
    return snakeValue ?? camelValue
  }

  const pickArrayArg = (snake: string, camel: string, kind: 'string' | 'number' = 'string'): string[] | number[] | undefined => {
    const snakeRaw = args[snake]
    const camelRaw = args[camel]
    if (snakeRaw !== undefined && !Array.isArray(snakeRaw)) {
      throw new Error(`watch_network arg "${snake}" must be an array of ${kind === 'string' ? 'strings' : 'numbers'}`)
    }
    if (camelRaw !== undefined && !Array.isArray(camelRaw)) {
      throw new Error(`watch_network arg "${camel}" must be an array of ${kind === 'string' ? 'strings' : 'numbers'}`)
    }

    const snakeValue = kind === 'string' ? normalizeStringArray(snakeRaw) : normalizeNumberArray(snakeRaw)
    const camelValue = kind === 'string' ? normalizeStringArray(camelRaw) : normalizeNumberArray(camelRaw)
    if (snakeRaw !== undefined && camelRaw !== undefined && JSON.stringify(snakeValue) !== JSON.stringify(camelValue)) {
      throw new Error(`watch_network args conflict: "${snake}" and "${camel}" differ`)
    }
    return snakeValue ?? camelValue
  }

  const urlRegex = pickTextArg('url_regex', 'urlRegex')
  const urlFilters = pickArrayArg('url_filters', 'urlFilters', 'string') as string[] | undefined
  const urlFilter = pickTextArg('url_filter', 'urlFilter')
  const resourceTypes = pickArrayArg('resource_types', 'resourceTypes', 'string') as string[] | undefined
  const statusCodes = pickArrayArg('status_codes', 'statusCodes', 'number') as number[] | undefined
  const statusMin = parseNumericArg(args.status_min ?? args.statusMin, args.status_min !== undefined ? 'status_min' : 'statusMin')
  const statusMax = parseNumericArg(args.status_max ?? args.statusMax, args.status_max !== undefined ? 'status_max' : 'statusMax')
  const mimeIncludes = pickArrayArg('mime_includes', 'mimeIncludes', 'string') as string[] | undefined
  const modeRaw = pickTextArg('mode', 'mode', 40)?.toLowerCase()
  const mode = modeRaw === 'passive' ? 'passive' : 'next_action'
  const includeRequestBody = args.include_request_body === true || args.includeRequestBody === true
  const redactSensitive = args.redact_sensitive !== false && args.redactSensitive !== false

  if (statusMin !== undefined) assertRange(statusMin, args.status_min !== undefined ? 'status_min' : 'statusMin', 100, 599)
  if (statusMax !== undefined) assertRange(statusMax, args.status_max !== undefined ? 'status_max' : 'statusMax', 100, 599)
  if (statusMin !== undefined && statusMax !== undefined && statusMin > statusMax) {
    throw new Error('watch_network args conflict: "status_min" cannot be greater than "status_max"')
  }

  const filterParts: string[] = []
  if (urlRegex) filterParts.push(`url~/${urlRegex}/i`)
  else if (urlFilters && urlFilters.length > 0) filterParts.push(urlFilters.map((part) => `"${part}"`).join(', '))
  else if (urlFilter) filterParts.push(`"${urlFilter}"`)
  if (resourceTypes && resourceTypes.length > 0) filterParts.push(`types:${resourceTypes.join(',')}`)
  if (statusCodes && statusCodes.length > 0) filterParts.push(`statuses:${statusCodes.join(',')}`)
  if (statusMin !== undefined) filterParts.push(`status>=${statusMin}`)
  if (statusMax !== undefined) filterParts.push(`status<=${statusMax}`)
  if (mimeIncludes && mimeIncludes.length > 0) filterParts.push(`mime:${mimeIncludes.join(',')}`)

  return {
    urlFilter,
    urlFilters,
    urlRegex,
    resourceTypes,
    statusCodes,
    statusMin,
    statusMax,
    mimeIncludes,
    mode,
    includeRequestBody,
    redactSensitive,
    filterLabel: filterParts.length > 0 ? filterParts.join('; ') : undefined,
    windowMs: pickNumericArg('window_ms', 'windowMs', 4_000, 500, 15_000),
    maxBodies: pickNumericArg('max_bodies', 'maxBodies', 3, 1, 10),
    maxBodyChars: pickNumericArg('max_body_chars', 'maxBodyChars', 4_000, 500, 20_000)
  }
}

export function summarizeNetworkCapture(
  capture: {
    totalSeen: number
    captured: CapturedNetworkRequest[]
    bodies: CapturedNetworkBody[]
    filter?: NetworkFilterSpec
  },
  opts?: { label?: string }
): { text: string; structuredContent: Record<string, unknown> } {
  const label = opts?.label ?? 'NETWORK CAPTURE'
  const bodyWord = capture.bodies.length === 1 ? 'body' : 'bodies'
  const summary = `${label}: ${capture.totalSeen} request(s), ${capture.captured.length} matched, ${capture.bodies.length} ${bodyWord} captured`
  const endpointLines = capture.captured
    .slice(0, 5)
    .map((item) => `  [${item.status}] ${item.method} ${item.type} ${item.url}`)
  const bodyLines = capture.bodies
    .slice(0, 2)
    .map((body) => `  body: ${body.url}${body.truncated ? ' [truncated]' : ''}`)
  return {
    text: [summary, ...endpointLines, ...bodyLines].join('\n'),
    structuredContent: {
      totalSeen: capture.totalSeen,
      capturedCount: capture.captured.length,
      bodyCount: capture.bodies.length,
      filter: capture.filter,
      captured: capture.captured,
      bodies: capture.bodies
    }
  }
}

function networkDiscoveryOutcome(
  summary: NetworkAwarenessState,
  opts: { cached: boolean }
): ToolOutcome {
  const text = formatDataSourceDiscovery(summary, {
    label: opts.cached ? 'DATA SOURCE DISCOVERY (cached)' : 'DATA SOURCE DISCOVERY'
  })
  return {
    ok: true,
    text,
    structuredContent: {
      pageUrl: summary.pageUrl,
      capturedAt: summary.capturedAt,
      observedWindowMs: summary.observedWindowMs,
      cache: opts.cached ? 'hit' : 'miss',
      totalSeen: summary.totalSeen,
      matchedCount: summary.matchedCount,
      pageMode: summary.pageMode,
      botProtectionSuspected: summary.botProtectionSuspected,
      recommendation: summary.recommendation,
      filter: summary.filter,
      candidateApis: summary.candidateApis
    }
  }
}
