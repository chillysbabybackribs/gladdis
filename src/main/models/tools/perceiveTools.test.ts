import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeWatchNetworkArgs, runReadPage, runWatchNetwork, type PerceiveToolsDeps } from './perceiveTools'

function mockPerceiveDeps(overrides: Partial<PerceiveToolsDeps> & Pick<PerceiveToolsDeps, 'tabs'>): PerceiveToolsDeps {
  return {
    extractor: {} as any,
    pageCache: new Map(),
    pageCacheLimit: 0,
    pageCacheTtlMs: 0,
    a11yCache: new Map(),
    a11yCacheLimit: 0,
    a11yCacheTtlMs: 0,
    setAxRefStore: () => {},
    appCapture: null,
    getPageCacheStats: () => ({ hits: 0, misses: 0, expired: 0, evictions: 0, size: 0, limit: 0, ttlMs: 0 }),
    getA11yCacheStats: () => ({ hits: 0, misses: 0, expired: 0, evictions: 0, size: 0, limit: 0, ttlMs: 0 }),
    recordPageCacheEvent: () => {},
    recordA11yCacheEvent: () => {},
    ...overrides
  }
}

describe('normalizeWatchNetworkArgs', () => {
  it('applies defaults', () => {
    expect(normalizeWatchNetworkArgs({})).toEqual({
      urlFilter: undefined,
      urlFilters: undefined,
      urlRegex: undefined,
      resourceTypes: undefined,
      statusCodes: undefined,
      statusMin: undefined,
      statusMax: undefined,
      mimeIncludes: undefined,
      mode: 'next_action',
      includeRequestBody: false,
      redactSensitive: true,
      filterLabel: undefined,
      windowMs: 4_000,
      maxBodies: 3,
      maxBodyChars: 4_000
    })
  })

  it('supports camelCase aliases and richer filter args', () => {
    expect(
      normalizeWatchNetworkArgs({
        urlFilter: 'graphql',
        urlFilters: [' api ', '', 'search'],
        urlRegex: 'graph(q|ql)',
        resourceTypes: [' fetch ', 'xhr', ''],
        statusCodes: [200, '204', 999],
        statusMin: 200,
        statusMax: 299,
        mimeIncludes: [' json ', 'javascript', ''],
        includeRequestBody: true,
        redactSensitive: false,
        windowMs: 1_500,
        maxBodies: 8,
        maxBodyChars: 12_000
      })
    ).toEqual({
      urlFilter: 'graphql',
      urlFilters: ['api', 'search'],
      urlRegex: 'graph(q|ql)',
      resourceTypes: ['fetch', 'xhr'],
      statusCodes: [200, 204],
      statusMin: 200,
      statusMax: 299,
      mimeIncludes: ['json', 'javascript'],
      mode: 'next_action',
      includeRequestBody: true,
      redactSensitive: false,
      filterLabel: 'url~/graph(q|ql)/i; types:fetch,xhr; statuses:200,204; status>=200; status<=299; mime:json,javascript',
      windowMs: 1_500,
      maxBodies: 8,
      maxBodyChars: 12_000
    })
  })

  it('falls back cleanly for malformed text-only values', () => {
    expect(normalizeWatchNetworkArgs({
      url_filter: 123,
      url_regex: { nope: true }
    })).toEqual({
      urlFilter: undefined,
      urlFilters: undefined,
      urlRegex: undefined,
      resourceTypes: undefined,
      statusCodes: undefined,
      statusMin: undefined,
      statusMax: undefined,
      mimeIncludes: undefined,
      mode: 'next_action',
      includeRequestBody: false,
      redactSensitive: true,
      filterLabel: undefined,
      windowMs: 4_000,
      maxBodies: 3,
      maxBodyChars: 4_000
    })
  })

  it('returns explicit failures for numeric inputs', () => {
    expect(() => normalizeWatchNetworkArgs({ window_ms: 'not-a-number' })).toThrowError(
      'watch_network arg "window_ms" must be a finite number'
    )
    expect(() => normalizeWatchNetworkArgs({ max_bodies: -1 })).toThrowError(
      'between 1 and 10'
    )
    expect(() => normalizeWatchNetworkArgs({ max_body_chars: 0 })).toThrowError(
      'between 500 and 20000'
    )
    expect(() => normalizeWatchNetworkArgs({ status_min: 'bad' })).toThrowError(
      'watch_network arg "status_min" must be a finite number'
    )
    expect(() => normalizeWatchNetworkArgs({ status_max: 700 })).toThrowError(
      'between 100 and 599'
    )
    expect(() => normalizeWatchNetworkArgs({ status_min: 500, status_max: 400 })).toThrowError(
      'status_min" cannot be greater than "status_max'
    )
  })

  it('reports conflicts when both snake_case and camelCase values are provided', () => {
    expect(() =>
      normalizeWatchNetworkArgs({ window_ms: 1_000, windowMs: 1_500 })
    ).toThrowError('args conflict')
    expect(() =>
      normalizeWatchNetworkArgs({
        url_filter: '/api',
        urlFilter: '/graph'
      })
    ).toThrowError('args conflict')
    expect(() =>
      normalizeWatchNetworkArgs({
        url_filters: ['api', 'search'],
        urlFilters: ['search']
      })
    ).toThrowError('args conflict')
    expect(() =>
      normalizeWatchNetworkArgs({
        status_codes: [200, 201],
        statusCodes: [200]
      })
    ).toThrowError('args conflict')
  })
})

describe('runWatchNetwork', () => {
  afterEach(() => vi.restoreAllMocks())

  it('arms the next browser action by default', async () => {
    const armNextNetworkCapture = vi.fn()
    const watchNetwork = vi.fn(async () => ({
      totalSeen: 0,
      captured: [],
      bodies: []
    }))
    const outcome = await runWatchNetwork(mockPerceiveDeps({
      tabs: { watchNetwork, armNextNetworkCapture } as any
    }),
    {
      url_filter: '/api/',
      window_ms: 7_000,
      max_bodies: 2,
      max_body_chars: 9000
    },
    'tab-1'
    )

    expect(armNextNetworkCapture).toHaveBeenCalledWith('tab-1', {
      urlFilter: '/api/',
      urlFilters: undefined,
      urlRegex: undefined,
      resourceTypes: undefined,
      statusCodes: undefined,
      statusMin: undefined,
      statusMax: undefined,
      mimeIncludes: undefined,
      includeRequestBody: false,
      redactSensitive: true,
      windowMs: 7_000,
      maxBodies: 2,
      maxBodyChars: 9_000
    })
    expect(watchNetwork).not.toHaveBeenCalled()
    expect(outcome.ok).toBe(true)
    expect(outcome.structuredContent).toMatchObject({
      mode: 'next_action',
      armed: true,
      urlFilter: '/api/',
      windowMs: 7_000
    })
  })

  it('passes normalized args through to TabManager.watchNetwork in passive mode', async () => {
    const watchNetwork = vi.fn(async () => ({
      totalSeen: 1,
      captured: [
        {
          requestId: 'req-1',
          url: 'https://example.com/api/items',
          method: 'GET',
          status: 200,
          mimeType: 'application/json',
          type: 'fetch',
          success: true,
          durationMs: 123,
          encodedDataLength: 456
        }
      ],
      bodies: []
    }))
    const outcome = await runWatchNetwork(mockPerceiveDeps({
      tabs: { watchNetwork, armNextNetworkCapture: vi.fn() } as any
    }),
    {
      mode: 'passive',
      url_filter: '/api/',
      url_filters: ['graphql', 'search'],
      url_regex: 'items',
      resource_types: ['fetch', 'xhr'],
      status_codes: [200, 204],
      status_min: 200,
      status_max: 299,
      mime_includes: ['json'],
      include_request_body: true,
      redact_sensitive: false,
      window_ms: 7_000,
      max_bodies: 2,
      max_body_chars: 9000
    },
    'tab-1'
    )

    expect(watchNetwork).toHaveBeenCalledWith('tab-1', {
      urlFilter: '/api/',
      urlFilters: ['graphql', 'search'],
      urlRegex: 'items',
      resourceTypes: ['fetch', 'xhr'],
      statusCodes: [200, 204],
      statusMin: 200,
      statusMax: 299,
      mimeIncludes: ['json'],
      includeRequestBody: true,
      redactSensitive: false,
      windowMs: 7_000,
      maxBodies: 2,
      maxBodyChars: 9_000
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.structuredContent).toMatchObject({
      mode: 'passive',
      urlFilter: '/api/',
      urlFilters: ['graphql', 'search'],
      urlRegex: 'items',
      resourceTypes: ['fetch', 'xhr'],
      statusCodes: [200, 204],
      statusMin: 200,
      statusMax: 299,
      mimeIncludes: ['json'],
      includeRequestBody: true,
      redactSensitive: false,
      windowMs: 7_000,
      maxBodies: 2,
      maxBodyChars: 9_000,
      totalSeen: 1,
      captured: expect.any(Array)
    })
  })

  it('returns a tool error result when watcher execution fails', async () => {
    const watchNetwork = vi.fn(async () => {
      throw new Error('network unavailable')
    })

    const outcome = await runWatchNetwork(
      mockPerceiveDeps({
        tabs: { watchNetwork, armNextNetworkCapture: vi.fn() } as any
      }),
      { mode: 'passive' },
      'tab-1'
    )

    expect(watchNetwork).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ ok: false, text: 'watch_network error: network unavailable' })
  })

  it('returns a tool error result when args are invalid instead of dropping tool_result', async () => {
    const watchNetwork = vi.fn(async () => ({ totalSeen: 0, captured: [], bodies: [] }))

    const outcome = await runWatchNetwork(
      mockPerceiveDeps({
        tabs: { watchNetwork, armNextNetworkCapture: vi.fn() } as any
      }),
      {
        window_ms: 'not-a-number'
      },
      'tab-1'
    )

    expect(watchNetwork).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      ok: false,
      text: 'watch_network error: watch_network arg "window_ms" must be a finite number'
    })
  })
})

describe('runReadPage', () => {
  afterEach(() => vi.restoreAllMocks())

  // Regression guard: the digest must ride in structuredContent, not only text.
  // MCP clients (Claude Code / Cursor) surface structuredContent when an
  // outputSchema is declared, so a digest left only in `text` reads as empty.
  it('mirrors the page digest into structuredContent on a cache miss', async () => {
    const deps = mockPerceiveDeps({
      tabs: { getTabUrl: () => 'https://example.com/' } as any,
      extractor: { run: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example' })) } as any,
      pageCache: new Map(),
      pageCacheLimit: 8,
      pageCacheTtlMs: 60_000
    })

    const outcome = await runReadPage(deps, {}, 'tab-1')

    expect(outcome.ok).toBe(true)
    const sc = outcome.structuredContent as Record<string, unknown>
    expect(typeof sc.digest).toBe('string')
    expect((sc.digest as string).length).toBeGreaterThan(0)
    // and it is the same body surfaced in the text channel
    expect(outcome.text).toContain(sc.digest as string)
    expect((sc.cache as Record<string, unknown>).status).toBe('miss')
  })

  it('mirrors the cached digest into structuredContent on a cache hit', async () => {
    const cache = new Map([
      ['tab-1::false', { pageUrl: 'https://example.com/', digest: 'CACHED DIGEST BODY', capturedAt: Date.now() }]
    ])
    const deps = mockPerceiveDeps({
      tabs: { getTabUrl: () => 'https://example.com/' } as any,
      extractor: { run: vi.fn(async () => { throw new Error('should not extract on hit') }) } as any,
      pageCache: cache,
      pageCacheLimit: 8,
      pageCacheTtlMs: 60_000
    })

    const outcome = await runReadPage(deps, {}, 'tab-1')

    const sc = outcome.structuredContent as Record<string, unknown>
    expect(sc.digest).toBe('CACHED DIGEST BODY')
    expect((sc.cache as Record<string, unknown>).status).toBe('hit')
  })
})
