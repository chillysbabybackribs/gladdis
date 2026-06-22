import type { TabManager } from '../../TabManager'
import type { PageExtractor } from '../../extract/PageExtractor'
import type { ToolOutcome } from '../browserTools'
import { digestPage } from '../PageDigest'

export interface PerceiveToolsDeps {
  tabs: TabManager
  extractor: PageExtractor
  /** Read-through digest cache, keyed by `${tabId}:${focus}:${viewportOnly}`. */
  pageCache: Map<string, string>
  pageCacheLimit: number
  appCapture: (() => Promise<string>) | null
}

export async function runReadPage(
  deps: PerceiveToolsDeps,
  args: Record<string, any>,
  tabId: string
): Promise<ToolOutcome> {
  const cacheKey = `${tabId}:${args.focus ?? ''}:${args.viewportOnly === true}`
  const cached = deps.pageCache.get(cacheKey)
  if (cached) return { ok: true, text: cached }

  const capData = await deps.extractor.run(tabId)
  const digest = digestPage(capData, {
    focus: args.focus ? String(args.focus) : undefined,
    viewportOnly: args.viewportOnly === true
  })

  if (deps.pageCache.size >= deps.pageCacheLimit) {
    const first = deps.pageCache.keys().next().value
    if (first !== undefined) deps.pageCache.delete(first)
  }
  deps.pageCache.set(cacheKey, digest)
  return { ok: true, text: digest }
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
    imageBase64
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
  return { ok: true, text: 'Screenshot of the entire Gladdis app window captured.', imageBase64 }
}
