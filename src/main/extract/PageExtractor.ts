import type { PageCapture } from '../../../shared/types'
import type { TabManager } from '../TabManager'
import { extractionScript } from './pageScript'
import { overlayScript } from './overlayScript'

/**
 * Deterministic, CDP-driven deep page extraction. Runs the heavy DOM walk
 * inside the page (Runtime.evaluate in an isolated world), so the capture is
 * grounded in what Chromium itself renders — not page-cooperative JS we can be
 * lied to by.
 *
 * This is the perception layer the LLM/agent integration sits on top of.
 */
export class PageExtractor {
  constructor(private readonly tabs: TabManager) {}

  async run(tabId: string): Promise<PageCapture> {
    const started = Date.now()

    // 1. Page-side structured extraction (content / data / actions / dom).
    const evald = (await this.tabs.cdpSend(tabId, 'Runtime.evaluate', {
      expression: extractionScript(),
      returnByValue: true,
      awaitPromise: true,
      // Isolated world keeps our walk from tripping page globals / being hooked.
      includeCommandLineAPI: false
    })) as { result?: { value?: any }; exceptionDetails?: unknown }

    if (evald.exceptionDetails) {
      throw new Error('page extraction threw: ' + JSON.stringify(evald.exceptionDetails).slice(0, 300))
    }
    const page = evald.result?.value
    if (!page) throw new Error('page extraction returned nothing')

    const tookMs = Date.now() - started
    return {
      url: page.url ?? '',
      title: page.title ?? '',
      capturedAt: started,
      tookMs,
      content: page.content,
      data: page.data,
      actions: page.actions ?? [],
      dom: page.dom
    }
  }

  /** Toggle the on-page overlay; returns the number of boxes drawn. */
  async overlay(tabId: string, on: boolean): Promise<number> {
    const res = (await this.tabs.cdpSend(tabId, 'Runtime.evaluate', {
      expression: overlayScript(on),
      returnByValue: true
    })) as { result?: { value?: number } }
    return res.result?.value ?? 0
  }
}
