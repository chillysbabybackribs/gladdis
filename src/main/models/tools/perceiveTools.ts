import type { TabManager } from '../../TabManager'
import type { PageExtractor } from '../../extract/PageExtractor'
import type { ToolOutcome } from '../browserTools'
import { digestPage } from '../PageDigest'

export interface ReadPageCacheEntry {
  pageUrl: string
  digest: string
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
  appCapture: (() => Promise<string>) | null
  getPageCacheStats: () => ReadPageCacheStats
  recordPageCacheEvent: (event: 'hit' | 'miss' | 'expired' | 'evicted') => void
}

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
      cache: {
        status: 'miss',
        capturedAt: nowCaptured,
        ...deps.getPageCacheStats()
      }
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
  type: 'text_match' | 'selector_match' | 'error'
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
}

export async function executeGrepInTab(
  tabs: TabManager,
  tabId: string,
  query: string,
  type: 'auto' | 'text' | 'regex' | 'selector' = 'auto',
  caseSensitive: boolean = false,
  contextLines: number = 2
): Promise<{ success: boolean; result?: any[]; error?: string }> {
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

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.innerText && el.innerText.includes(textStr) && isElementVisible(el)) {
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
          const escaped = pattern.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
          regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
        }
      } else {
        const escaped = pattern.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
        regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
      }

      lines.forEach((line, index) => {
        regex.lastIndex = 0;
        if (regex.test(line)) {
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
          matchedLine: line.trim(),
          lineIndex: index + 1,
          context,
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

    const isXPath = query.startsWith('/') || query.startsWith('(') || query.startsWith('./');
    const looksLikeSelector = isXPath || query.startsWith('.') || query.startsWith('#') || query.includes('[') || query.includes('>') || query.includes(' ');

    if (type === 'selector' || (type === 'auto' && looksLikeSelector)) {
      selectorResults = findSelectorMatches(query);
    }

    if (type === 'text' || type === 'regex' || (type === 'auto' && selectorResults.length === 0)) {
      const isRegex = (type === 'regex');
      textResults = findTextMatches(query, isRegex, caseSensitive, contextLines);
    }

    const allResults = [...selectorResults, ...textResults].slice(0, 50);
    return allResults;
  `;

  const runResult = await tabs.executeJavaScript(tabId, jsPayload)
  if (!runResult.success) {
    return { success: false, error: runResult.error }
  }
  return { success: true, result: runResult.result as any[] }
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

  const type = args.type || 'auto'
  const contextLines = typeof args.contextLines === 'number' ? args.contextLines : 2
  const caseSensitive = !!args.caseSensitive

  try {
    const runResult = await executeGrepInTab(deps.tabs, tabId, query, type, caseSensitive, contextLines)
    if (!runResult.success) {
      return { ok: false, text: `grep_page: failed to execute hybrid search in page: ${runResult.error}` }
    }

    const matches = runResult.result as any[]
    if (!Array.isArray(matches) || matches.length === 0) {
      return { ok: true, text: `No matches found for query "${query}" on the page.` }
    }

    let output = `Hybrid Grep/CDP search completed on page. Found ${matches.length} match(es):\n\n`
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

    return { ok: true, text: output.trim() }
  } catch (err: any) {
    return { ok: false, text: `grep_page error: ${err.message}` }
  }
}
