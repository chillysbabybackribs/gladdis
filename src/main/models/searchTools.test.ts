import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

vi.mock('./unifiedSearch', () => ({
  runUnifiedSearch: vi.fn(async (_deps, options: { query: string }) => ({
    ok: true,
    text: [
      `SEARCH "${options.query}" | 1 hits | 1 pass | 1 live`,
      '',
      'INDEX (fetch_page url for deeper read):',
      '*90 First hit | https://example.com/a | best match',
      '',
      'EVIDENCE (query-scored excerpts from live tab; * = probed):',
      '',
      '* 90 Example A | https://example.com/a',
      '• the page body'
    ].join('\n'),
    results: [{ title: 'First hit', url: 'https://example.com/a', snippet: 'best match', originQuery: 'q', relevanceScore: 0.9 }],
    digests: [{ url: 'https://example.com/a', title: 'Example A', relevanceScore: 0.9, digest: 'the page body' }]
  }))
}))

import { BrowserTools } from './browserTools'
import { runUnifiedSearch } from './unifiedSearch'

function makeTools(options?: {
  readinessSequence?: Array<{ url: string; readyState: string }>
}) {
  let currentUrl = 'https://start.test/'
  const readinessSequence = [...(options?.readinessSequence ?? [])]
  const navigate = vi.fn((_id: string, url: string) => {
    currentUrl = url
    return Promise.resolve()
  })
  const navigateWithNetworkCapture = vi.fn(async (_id: string, url: string) => {
    currentUrl = url
    return { totalSeen: 0, captured: [], bodies: [], filter: undefined }
  })
  const tabs = {
    activeTabId: 'tab-1',
    navigate,
    navigateWithNetworkCapture,
    waitForNavigationSettled: vi.fn(async () => undefined),
    takeArmedNetworkCapture: vi.fn(() => null),
    cdpSend: vi.fn(async () => ({
      result: {
        value:
          readinessSequence.shift() ??
          {
            url: currentUrl,
            readyState: 'complete'
          }
      }
    })),
    list: () => [{ id: 'tab-1', url: currentUrl, loading: false }],
    create: vi.fn(() => ({ id: 'tab-new' }))
  }
  const extractor = {
    run: vi.fn(async () => ({
      url: 'https://example.com/a',
      title: 'Example A',
      capturedAt: 0,
      tookMs: 1,
      content: { title: 'Example A', byline: null, text: 'the page body', markdown: 'the page body', headings: [], wordCount: 3 },
      data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
      actions: [],
      dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 }
    }))
  }
  const tools = new BrowserTools(tabs as any, extractor as any, {} as any)
  return { tools, tabs, extractor, navigate, navigateWithNetworkCapture }
}

describe('unified search tool', () => {
  it('search runs the unified pipeline and returns ranked + live digests', async () => {
    const { tools } = makeTools()
    const out = await tools.run('search', { query: 'electron webcontentsview' }, { tabId: 'tab-1' })

    expect(runUnifiedSearch).toHaveBeenCalled()
    expect(out.ok).toBe(true)
    expect(out.text).toContain('INDEX')
    expect(out.text).toContain('EVIDENCE')
    expect(out.text).toContain('the page body')
    expect(out.structuredContent).toEqual(
      expect.objectContaining({
        query: 'electron webcontentsview',
        results: [expect.objectContaining({ url: 'https://example.com/a' })],
        digests: [expect.objectContaining({ url: 'https://example.com/a' })]
      })
    )
  })

  it('auto-navigates search results for browser-oriented tasks when the flag is omitted', async () => {
    const { tools } = makeTools()
    vi.mocked(runUnifiedSearch).mockClear()

    await tools.run(
      'search',
      { query: 'open the electron docs' },
      { tabId: 'tab-1', latestUserText: 'search the web for the Electron docs and open the best result' }
    )

    expect(vi.mocked(runUnifiedSearch).mock.calls[0]?.[1]).toMatchObject({
      navigateVisible: true
    })
  })

  it('keeps search background-only for research tasks when the flag is omitted', async () => {
    const { tools } = makeTools()
    vi.mocked(runUnifiedSearch).mockClear()

    await tools.run(
      'search',
      { query: 'latest Electron architecture articles' },
      { tabId: 'tab-1', latestUserText: 'search the web for recent Electron architecture articles and summarize the findings' }
    )

    expect(vi.mocked(runUnifiedSearch).mock.calls[0]?.[1]).toMatchObject({
      navigateVisible: false
    })
  })

  it('fetch_page opens the URL in the visible tab and returns a digest', async () => {
    const { tools, navigateWithNetworkCapture, extractor } = makeTools()
    const out = await tools.run('fetch_page', { url: 'https://example.com/a' }, { tabId: 'tab-1' })

    expect(navigateWithNetworkCapture).toHaveBeenCalledWith(
      'tab-1',
      'https://example.com/a',
      expect.objectContaining({ timeoutMs: 10000, quietWindowMs: 350 })
    )
    expect(extractor.run).toHaveBeenCalledWith('tab-1')
    expect(out.ok).toBe(true)
    expect(out.text).toContain('the page body')
    expect(out.structuredContent).toEqual(
      expect.objectContaining({
        requestedUrl: 'https://example.com/a',
        finalUrl: 'https://example.com/a',
        pageUrl: 'https://example.com/a'
      })
    )
  })

  it('search_open runs web search and direct page fetch together', async () => {
    const { tools, navigateWithNetworkCapture, extractor } = makeTools()
    vi.mocked(runUnifiedSearch).mockClear()

    const out = await tools.run(
      'search_open',
      { query: 'electron docs', url: 'https://electronjs.org/docs/latest/' },
      { tabId: 'tab-1' }
    )

    expect(vi.mocked(runUnifiedSearch).mock.calls[0]?.[1]).toMatchObject({
      query: 'electron docs',
      navigateVisible: false
    })
    expect(navigateWithNetworkCapture).toHaveBeenCalledWith(
      'tab-1',
      'https://electronjs.org/docs/latest/',
      expect.objectContaining({ timeoutMs: 10000, quietWindowMs: 350 })
    )
    expect(extractor.run).toHaveBeenCalledWith('tab-1')
    expect(out.ok).toBe(true)
    expect(out.text).toContain('DIRECT PAGE:')
    expect(out.text).toContain('WEB SEARCH:')
    expect(out.structuredContent).toEqual(
      expect.objectContaining({
        query: 'electron docs',
        url: 'https://electronjs.org/docs/latest/',
        search: expect.objectContaining({
          results: [expect.objectContaining({ url: 'https://example.com/a' })]
        }),
        page: expect.objectContaining({
          requestedUrl: 'https://electronjs.org/docs/latest/'
        })
      })
    )
  })

  it('rejects empty/invalid input cleanly without throwing', async () => {
    const { tools } = makeTools()
    expect((await tools.run('search', {}, { tabId: 'tab-1' })).ok).toBe(false)
    expect((await tools.run('search_open', { query: 'x' }, { tabId: 'tab-1' })).ok).toBe(false)
    expect((await tools.run('fetch_page', { url: 'not-a-url' }, { tabId: 'tab-1' })).ok).toBe(false)
  })

  it('does not re-run an identical search within the same task — reuses results', async () => {
    const { tools } = makeTools()
    vi.mocked(runUnifiedSearch).mockClear()
    const ctx = { tabId: 'tab-1', conversationId: 'conv-1' }

    const first = await tools.run('search', { query: 'electron docs' }, ctx)
    const second = await tools.run('search', { query: 'electron docs' }, ctx)

    expect(vi.mocked(runUnifiedSearch)).toHaveBeenCalledTimes(1)
    expect(first.text).toContain('First hit')
    expect(second.text).toMatch(/already searched/i)
  })

  it('does not re-navigate/re-extract a URL already opened this task', async () => {
    const { tools, navigateWithNetworkCapture, extractor } = makeTools()
    const ctx = { tabId: 'tab-1', conversationId: 'conv-1' }

    await tools.run('fetch_page', { url: 'https://example.com/a' }, ctx)
    await tools.run('fetch_page', { url: 'https://example.com/a/' }, ctx)

    expect(navigateWithNetworkCapture).toHaveBeenCalledTimes(1)
    expect(extractor.run).toHaveBeenCalledTimes(1)
  })

  it('keeps per-task memory separate across different conversations', async () => {
    const { tools } = makeTools()
    vi.mocked(runUnifiedSearch).mockClear()

    await tools.run('search', { query: 'shared query' }, { tabId: 'tab-1', conversationId: 'conv-A' })
    await tools.run('search', { query: 'shared query' }, { tabId: 'tab-1', conversationId: 'conv-B' })

    expect(vi.mocked(runUnifiedSearch)).toHaveBeenCalledTimes(2)
  })

  it('fetch_page does not fall back to an extra settle wait after navigation already looks readable', async () => {
    const { tools, tabs } = makeTools({
      readinessSequence: [{ url: 'https://example.com/a', readyState: 'complete' }]
    })

    await tools.run('fetch_page', { url: 'https://example.com/a' }, { tabId: 'tab-1' })

    expect(tabs.waitForNavigationSettled).not.toHaveBeenCalled()
  })
})
