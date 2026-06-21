import { describe, expect, it } from 'vitest'
import type { PageCapture } from '../../../shared/types'
import {
  briefPageForSearch,
  harvestStructuredSignals,
  queryTerms,
  scoreText,
  selectQueryExcerpts
} from './searchBrief'

function makeCap(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    url: 'https://example.com/docs',
    title: 'Example Docs',
    capturedAt: 0,
    tookMs: 1,
    content: {
      title: 'Example Docs',
      byline: null,
      text: '',
      markdown: '',
      headings: [],
      wordCount: 0
    },
    data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
    actions: [],
    dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 },
    ...overrides
  }
}

describe('searchBrief', () => {
  it('scores text by query term overlap', () => {
    expect(scoreText('WebContentsView embeds Chromium in Electron', queryTerms('electron WebContentsView'))).toBeGreaterThanOrEqual(2)
    expect(scoreText('unrelated cooking recipe', queryTerms('electron'))).toBe(0)
  })

  it('selects only query-relevant excerpts', () => {
    const body = [
      'Welcome to our site. Sign in for cookies.',
      '',
      'WebContentsView is the modern way to embed Chromium inside Electron apps.',
      '',
      'Unrelated footer about newsletter subscriptions every week.'
    ].join('\n')
    const excerpts = selectQueryExcerpts(body, queryTerms('WebContentsView Electron'), 500)
    expect(excerpts.some((e) => /WebContentsView/i.test(e))).toBe(true)
    expect(excerpts.some((e) => /newsletter/i.test(e))).toBe(false)
  })

  it('harvests JSON-LD descriptions before reading body', () => {
    const cap = makeCap({
      data: {
        meta: {},
        openGraph: {},
        jsonLd: [{ '@type': 'TechArticle', description: 'How WebContentsView replaces BrowserView in Electron 30+' }],
        canonical: null,
        feeds: [],
        lang: 'en'
      }
    })
    const signal = harvestStructuredSignals(cap, queryTerms('WebContentsView Electron'), 200)
    expect(signal).toContain('WebContentsView')
  })

  it('keeps brief output under budget without action tables', () => {
    const cap = makeCap({
      content: {
        title: 'Electron',
        byline: null,
        text: 'x'.repeat(10_000),
        markdown: `# WebContentsView\n\nWebContentsView embeds native Chromium views.\n\n${'noise '.repeat(400)}`,
        headings: [{ level: 2, text: 'WebContentsView' }],
        wordCount: 5000
      },
      actions: Array.from({ length: 50 }, (_, i) => ({
        idx: i + 1,
        role: 'link',
        name: `Link ${i}`,
        tag: 'a',
        selector: `a:nth(${i})`,
        rect: { x: 0, y: 0, w: 10, h: 10 },
        inViewport: true
      }))
    })
    const brief = briefPageForSearch(cap, { query: 'WebContentsView Electron', maxChars: 750 })
    expect(brief.length).toBeLessThanOrEqual(753)
    expect(brief).toContain('WebContentsView')
    expect(brief).not.toContain('ACTIONS')
    expect(brief).not.toContain('Link 49')
  })
})
