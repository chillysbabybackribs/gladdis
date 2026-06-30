import { describe, expect, it, vi } from 'vitest'

vi.mock('./hiddenSearch', () => ({
  runHiddenSearch: vi.fn(async (query: string) => ({
    ok: true,
    url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    title: 'Results',
    engine: 'ddg',
    results: query.includes('stackoverflow')
      ? [{ title: 'StackOverflow hit', url: 'https://stackoverflow.com/q/1', snippet: 'answer' }]
      : [
          { title: 'Official docs', url: 'https://electronjs.org/docs', snippet: 'electron guide' },
          { title: 'GitHub issue', url: 'https://github.com/electron/electron/issues/1', snippet: 'bug report' }
        ]
  }))
}))

import {
  rankSearchResults,
  runUnifiedSearch,
  type RankedSearchResult
} from './unifiedSearch'
import { runHiddenSearch } from './hiddenSearch'

function makeDeps() {
  const navigate = vi.fn(async () => undefined)
  const navigateWithNetworkCapture = vi.fn(async () => ({
    totalSeen: 0,
    captured: [],
    bodies: [],
    filter: undefined
  }))
  const tabs = {
    activeTabId: 'tab-1',
    list: () => [{ id: 'tab-1', url: 'https://start.test/', loading: false }],
    navigate,
    navigateWithNetworkCapture,
    waitForNavigationSettled: vi.fn(async () => undefined),
    create: vi.fn(() => ({ id: 'tab-new' })),
    close: vi.fn(),
    switch: vi.fn(),
    cdpSend: vi.fn(async () => undefined),
    executeJavaScript: vi.fn(async () => ({ success: true, result: null }))
  }
  const extractor = {
    run: vi.fn(async () => ({
      url: 'https://electronjs.org/docs',
      title: 'Electron Docs',
      capturedAt: 0,
      tookMs: 1,
      content: {
        title: 'Electron Docs',
        byline: null,
        text: 'WebContentsView documentation body',
        markdown: 'WebContentsView documentation body',
        headings: [],
        wordCount: 3
      },
      data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
      actions: [],
      dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 }
    }))
  }
  return { tabs, extractor, navigate, navigateWithNetworkCapture }
}

describe('unifiedSearch', () => {
  it('searches the query exactly once, as-is (no manufactured variants)', async () => {
    const { tabs, extractor } = makeDeps()
    vi.mocked(runHiddenSearch).mockClear()

    await runUnifiedSearch(
      { tabs: tabs as any, extractor: extractor as any },
      { query: 'react vs vue comparison', tabId: 'tab-1', digestTop: 0 }
    )

    expect(vi.mocked(runHiddenSearch).mock.calls.length).toBe(1)
    expect(vi.mocked(runHiddenSearch).mock.calls[0][0]).toBe('react vs vue comparison')
  })

  it('surfaces the engine failure reason instead of a flat "no results"', async () => {
    const { tabs, extractor } = makeDeps()
    vi.mocked(runHiddenSearch).mockResolvedValueOnce({
      ok: false, url: '', title: '', results: [], reason: 'search bot-challenge page'
    } as any)

    const outcome = await runUnifiedSearch(
      { tabs: tabs as any, extractor: extractor as any },
      { query: 'anything', tabId: 'tab-1' }
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('search bot-challenge page')
    expect(outcome.text).toContain('bot-challenge')
  })

  it('boosts authoritative domains when ranking', () => {
    const flat: RankedSearchResult[] = [
      { title: 'Blog', url: 'https://random.blog/electron', snippet: 'electron', originQuery: 'q', relevanceScore: 0.5 },
      { title: 'Docs', url: 'https://electronjs.org/docs', snippet: 'electron', originQuery: 'q', relevanceScore: 0.5 }
    ]
    const ranked = rankSearchResults(flat, 'electron docs', ['electronjs.org'])
    expect(ranked[0].url).toContain('electronjs.org')
  })

  it('runs hidden SERP then opens top hits in the visible tab', async () => {
    const { tabs, extractor, navigateWithNetworkCapture } = makeDeps()
    vi.mocked(runHiddenSearch).mockClear()

    const outcome = await runUnifiedSearch(
      { tabs: tabs as any, extractor: extractor as any },
      { query: 'electron WebContentsView', tabId: 'tab-1', digestTop: 1, navigateVisible: true }
    )

    expect(outcome.ok).toBe(true)
    expect(vi.mocked(runHiddenSearch).mock.calls.length).toBeGreaterThan(0)
    expect(navigateWithNetworkCapture).toHaveBeenCalled()
    expect(extractor.run).toHaveBeenCalled()
    expect(outcome.text).toContain('INDEX')
    expect(outcome.text).toContain('EVIDENCE')
    expect(outcome.text.length).toBeLessThanOrEqual(9_603) // OUTPUT_CHAR_BUDGET + ellipsis
  })
})
