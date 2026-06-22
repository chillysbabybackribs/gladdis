/**
 * Silent 429/503 retry for the raw-fetch providers (OpenAI, Grok).
 *
 * The Anthropic and Google SDKs already retry rate-limit responses with backoff
 * internally; this gives the two `fetch`-based providers the same safeguard so a
 * transient "too many requests" no longer breaks the chat. On the final failed
 * attempt it returns the Response untouched, so each provider's existing
 * `!res.ok` error path runs exactly as before.
 */

const RETRYABLE_STATUS = new Set([429, 503])
const DEFAULT_MAX_RETRIES = 3
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 15_000

/** Honor `Retry-After` (seconds, or an HTTP date) when present; otherwise back off exponentially with jitter. */
function backoffDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_DELAY_MS)
    }
    const date = Date.parse(header)
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(0, date - currentTime()), MAX_DELAY_MS)
    }
  }
  const exponential = BASE_DELAY_MS * 2 ** attempt
  const jitter = exponential * 0.25 * pseudoJitter(attempt)
  return Math.min(exponential + jitter, MAX_DELAY_MS)
}

// Indirection so this module has a single, easily-stubbed clock for tests.
function currentTime(): number {
  return Date.now()
}

// Deterministic-ish jitter that still varies per attempt, without Math.random
// (which is unavailable in some sandboxes and makes tests flaky).
function pseudoJitter(attempt: number): number {
  return ((attempt * 2_654_435_761) % 1_000) / 1_000
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Like `fetch`, but transparently retries 429/503 responses up to `maxRetries`
 * times. Returns the final Response (success or last failure) so the caller's
 * own error handling is unchanged. A passed `signal` both aborts the in-flight
 * request and cancels any pending backoff.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; signal?: AbortSignal } = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const signal = opts.signal ?? (init.signal as AbortSignal | undefined) ?? undefined

  let res = await fetch(url, init)
  for (let attempt = 0; attempt < maxRetries && RETRYABLE_STATUS.has(res.status); attempt++) {
    // Drain the throwaway body so the connection can be reused.
    await res.body?.cancel().catch(() => {})
    await sleep(backoffDelayMs(res, attempt), signal)
    if (signal?.aborted) break
    res = await fetch(url, init)
  }
  return res
}
