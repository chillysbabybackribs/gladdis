import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithRetry } from './retry'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function res(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: { cancel: async () => {} }
  } as unknown as Response
}

/** Run a promise to completion while advancing fake timers so backoff sleeps resolve. */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const p = run()
  // Flush microtasks + advance timers repeatedly until the chain settles.
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(20_000)
  }
  return p
}

describe('fetchWithRetry', () => {
  it('returns immediately on a 2xx without retrying', async () => {
    const fetchSpy = vi.fn(async () => res(200))
    vi.stubGlobal('fetch', fetchSpy)

    const out = await fetchWithRetry('https://x', { method: 'POST' })

    expect(out.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 and returns the eventual success', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200))
    vi.stubGlobal('fetch', fetchSpy)

    const out = await withFakeTimers(() => fetchWithRetry('https://x', { method: 'POST' }))

    expect(out.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('gives up after maxRetries and returns the last failing response', async () => {
    const fetchSpy = vi.fn(async () => res(429))
    vi.stubGlobal('fetch', fetchSpy)

    const out = await withFakeTimers(() =>
      fetchWithRetry('https://x', { method: 'POST' }, { maxRetries: 2 })
    )

    expect(out.status).toBe(429)
    // original attempt + 2 retries
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('does not retry a non-retryable 4xx', async () => {
    const fetchSpy = vi.fn(async () => res(400))
    vi.stubGlobal('fetch', fetchSpy)

    const out = await fetchWithRetry('https://x', { method: 'POST' })

    expect(out.status).toBe(400)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('honors a numeric Retry-After header', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(res(429, { 'retry-after': '2' })).mockResolvedValueOnce(res(200))
    vi.stubGlobal('fetch', fetchSpy)

    vi.useFakeTimers()
    const p = fetchWithRetry('https://x', { method: 'POST' })
    // Not yet retried before the 2s window elapses.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_500)
    const out = await p

    expect(out.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once the abort signal fires', async () => {
    const controller = new AbortController()
    const fetchSpy = vi.fn(async () => res(429))
    vi.stubGlobal('fetch', fetchSpy)

    vi.useFakeTimers()
    const p = fetchWithRetry('https://x', { method: 'POST' }, { signal: controller.signal })
    controller.abort()

    await expect(p).rejects.toBeDefined()
  })
})
