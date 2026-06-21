import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

// The off-screen SERP plumbing — the one piece of the old search stack that survives.
vi.mock('./hiddenSearch', () => ({
  runHiddenSearch: vi.fn(async (query: string) => ({
    ok: true,
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    title: 'Results',
    results: [
      { title: 'First hit', url: 'https://example.com/a', snippet: 'best match' },
      { title: 'Second hit', url: 'https://example.com/b', snippet: 'also relevant' }
    ]
  }))
}))

import { BrowserTools } from './browserTools'
import { runHiddenSearch } from './hiddenSearch'

function makeTools() {
  let currentUrl = 'https://start.test/'
  const navigate = vi.fn((_id: string, url: string) => {
    currentUrl = url // reflect the navigation so waitForVisibleNavigation resolves immediately
  })
  const cdpSend = vi.fn(async (_id: string, method: string) => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: { url: currentUrl, readyState: 'interactive' } } }
    }
    return {}
  })
  const tabs = {
    activeTabId: 'tab-1',
    navigate,
    cdpSend,
    waitForNavigationSettled: vi.fn(async () => undefined),
    list: () => [{ id: 'tab-1', url: currentUrl, loading: false }]
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
  return { tools, tabs, extractor, navigate, cdpSend }
}

describe('model-driven search tools', () => {
  it('search keeps the SERP HIDDEN (no visible nav) and returns ranked URLs', async () => {
    const { tools, navigate } = makeTools()
    const out = await tools.run('search', { query: 'electron webcontentsview' }, { tabId: 'tab-1' })

    // Only the initial results lookup is hidden: search must NOT move the visible tab.
    // The user sees real pages only when the model opens a result with fetch_page/navigate.
    expect(navigate).not.toHaveBeenCalled()
    expect(out.ok).toBe(true)
    expect(out.text).toContain('First hit')
    expect(out.text).toContain('https://example.com/a')
    // No leftover scoring / status / timing vocabulary from the old engine.
    expect(out.text).not.toMatch(/STATUS:|TIMINGS:|coverage|EVIDENCE:/)
  })

  it('fetch_page opens the URL in the VISIBLE tab and returns a digest', async () => {
    const { tools, navigate, extractor, tabs } = makeTools()
    const out = await tools.run('fetch_page', { url: 'https://example.com/a' }, { tabId: 'tab-1' })

    expect(navigate).toHaveBeenCalledWith('tab-1', 'https://example.com/a')
    expect(tabs.waitForNavigationSettled).not.toHaveBeenCalled()
    expect(extractor.run).toHaveBeenCalledWith('tab-1')
    expect(out.ok).toBe(true)
    expect(out.text).toMatch(/^FETCH TIMINGS: .*readable=\d+ms.*extract=\d+ms/)
    expect(out.text).toContain('REQUESTED URL: https://example.com/a')
    expect(out.text).toContain('the page body')
    // It's a page digest, not a scored candidate record.
    expect(out.text).not.toMatch(/status=|score=|coverage/)
  })

  it('background_web_search returns results but does NOT touch the visible tab', async () => {
    const { tools, navigate } = makeTools()
    const out = await tools.run('background_web_search', { query: 'broad survey' }, { tabId: 'tab-1' })

    expect(navigate).not.toHaveBeenCalled()
    expect(out.ok).toBe(true)
    expect(out.text).toContain('off-screen')
    expect(out.text).toContain('First hit')
  })

  it('rejects empty/invalid input cleanly without throwing', async () => {
    const { tools } = makeTools()
    expect((await tools.run('search', {}, { tabId: 'tab-1' })).ok).toBe(false)
    expect((await tools.run('fetch_page', { url: 'not-a-url' }, { tabId: 'tab-1' })).ok).toBe(false)
    expect((await tools.run('background_web_search', {}, { tabId: 'tab-1' })).ok).toBe(false)
  })

  // ── Per-task memory: don't redo work already done this task ──────────────────

  it('does not re-run an identical search within the same task — reuses results', async () => {
    const { tools } = makeTools()
    vi.mocked(runHiddenSearch).mockClear()
    const ctx = { tabId: 'tab-1', conversationId: 'conv-1' }

    const first = await tools.run('search', { query: 'electron docs' }, ctx)
    const second = await tools.run('search', { query: 'electron docs' }, ctx)

    // The off-screen SERP lookup ran ONCE; the repeat reused it.
    expect(vi.mocked(runHiddenSearch)).toHaveBeenCalledTimes(1)
    expect(first.text).toContain('First hit')
    expect(second.text).toMatch(/already searched/i)
    expect(second.text).toContain('First hit')
  })

  it('does not re-navigate/re-extract a URL already opened this task', async () => {
    const { tools, navigate, extractor } = makeTools()
    const ctx = { tabId: 'tab-1', conversationId: 'conv-1' }

    await tools.run('fetch_page', { url: 'https://example.com/a' }, ctx)
    await tools.run('fetch_page', { url: 'https://example.com/a/' }, ctx) // trailing slash → same

    // Navigated + extracted ONCE; the repeat (even with trailing slash) reused the digest.
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(extractor.run).toHaveBeenCalledTimes(1)
  })

  it('reuses a fetched digest by the final extracted URL after redirects', async () => {
    const { tools, navigate, extractor } = makeTools()
    const ctx = { tabId: 'tab-1', conversationId: 'conv-1' }

    const first = await tools.run('fetch_page', { url: 'https://platform.example.com/docs/old' }, ctx)
    const second = await tools.run('fetch_page', { url: 'https://example.com/a' }, ctx)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(extractor.run).toHaveBeenCalledTimes(1)
    expect(first.text).toContain('the page body')
    expect(second.text).toMatch(/already fetched/i)
    expect(second.text).toContain('the page body')
  })

  it('keeps per-task memory separate across different conversations', async () => {
    const { tools } = makeTools()
    vi.mocked(runHiddenSearch).mockClear()

    await tools.run('search', { query: 'shared query' }, { tabId: 'tab-1', conversationId: 'conv-A' })
    await tools.run('search', { query: 'shared query' }, { tabId: 'tab-1', conversationId: 'conv-B' })

    // Different tasks → the search runs again for the second conversation.
    expect(vi.mocked(runHiddenSearch)).toHaveBeenCalledTimes(2)
  })
})
