import { describe, expect, it, vi } from 'vitest'
import { runWaitForLoad } from './perceiveTools'
import type { PageCapture } from '../../../../shared/extraction'

function cap(text: string): PageCapture {
  return {
    url: 'https://maps.example.com/search',
    title: 'Results',
    capturedAt: 1,
    tookMs: 1,
    content: { title: 'Results', byline: null, text, markdown: text, headings: [], wordCount: 3 },
    data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
    actions: [{ idx: 1, role: 'link', name: 'Pâtisserie de la Tour Eiffel', tag: 'a', value: 'x', selector: 's1', rect: { x: 0, y: 0, w: 10, h: 10 }, inViewport: true }],
    dom: { nodeCount: 10, htmlBytes: 100, frameCount: 1 }
  }
}

function makeDeps(textSamples: number[], captured: PageCapture) {
  let i = 0
  const tabs = {
    async executeJavaScript() {
      // Return the next text-length sample; hold the last once exhausted.
      const v = textSamples[Math.min(i, textSamples.length - 1)]
      i += 1
      return { success: true, result: v }
    }
  }
  const extractor = { run: vi.fn(async () => captured) }
  const savePage = vi.fn(async () => ({ markdownPath: '/tmp/x.md', actionsPath: '/tmp/x.actions.json', slug: 'x' }))
  return { tabs, extractor, savePage, deps: { tabs, extractor, savePage } as any }
}

describe('wait_for_load (content-stabilize)', () => {
  it('waits while text is still growing, then re-captures once it stabilizes', async () => {
    // Text grows (0 → 50 → 4000) then holds stable at 4000 for several samples.
    const samples = [0, 50, 4000, 4000, 4000, 4000]
    const { deps, extractor } = makeDeps(samples, cap('the loaded results content'))

    const result = await runWaitForLoad(deps, { timeout_ms: 8000 }, 'tab-1', 'conv-1')

    expect(result.ok).toBe(true)
    expect(result.structuredContent).toMatchObject({ stabilized: true, bodyTextChars: 4000 })
    // It re-ran the extractor to get the settled page.
    expect(extractor.run).toHaveBeenCalledWith('tab-1')
    // The fresh wireframe reflects the loaded content.
    const wire = result.structuredContent?.wireframe as { lines: Array<any> }
    expect(wire.lines[0]).toMatchObject({ name: 'Pâtisserie de la Tour Eiffel' })
    expect(result.text).toContain('Content settled')
  })

  it('re-saves the settled page to disk', async () => {
    const { deps, savePage } = makeDeps([100, 100, 100, 100], cap('body'))
    const result = await runWaitForLoad(deps, { timeout_ms: 4000 }, 'tab-1', 'conv-9')
    expect(savePage).toHaveBeenCalled()
    expect(result.structuredContent?.savedMarkdownPath).toBe('/tmp/x.md')
  })

  it('reports honestly when the page never gains content (empty shell)', async () => {
    // Text stays at 0 the whole time → stable-but-empty.
    const { deps } = makeDeps([0, 0, 0, 0, 0], cap(''))
    const result = await runWaitForLoad(deps, { timeout_ms: 2000 }, 'tab-1', 'conv-2')
    expect(result.ok).toBe(true)
    expect(result.structuredContent?.bodyTextChars).toBe(0)
    expect(result.text).toContain('still appears empty')
  })
})
