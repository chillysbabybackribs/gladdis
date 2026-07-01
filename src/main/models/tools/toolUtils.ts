/**
 * Shared helpers for the per-domain tool modules. Lives outside any one
 * domain because every domain ends up wanting `cap` (output truncation),
 * `safeJson`, `optNum`, `clampInt`, etc.
 */

/** Truncate `s` to at most `n` characters with a clear marker. */
export function cap(s: string, n = 24_000): string {
  return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s
}

/** Best-effort pretty-print for unknown values shipped back to the model. */
export function safeJson(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Coerce an optional numeric arg; undefined / NaN -> undefined. */
export function optNum(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Clamp + floor a numeric arg with a fallback for invalid values. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** Parse a tool-supplied `timeout_ms` arg, clamped to a sane range. */
export function parseTimeoutMs(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 600_000
  return Math.min(600_000, Math.max(250, Math.floor(parsed)))
}

/** Sleep helper used by retry / poll loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll document.body.innerText length until it stops growing across a few
 * consecutive reads (allowing tiny jitter), or the deadline passes. The shared
 * settle primitive: wait_for_load uses it to rescue a still-rendering page, and
 * act's `navigate` mode uses it as the "wait in between" so the chained action
 * resolves against a settled page instead of a half-rendered SPA shell.
 *
 * Takes an injected `runJs` (a tab's executeJavaScript) rather than a tabs
 * handle, so this stays a dependency-free utility. Returns whether it
 * stabilized and the final text length.
 */
export async function waitForTextStable(
  runJs: (code: string) => Promise<{ success: boolean; result?: unknown }>,
  maxMs: number
): Promise<{ stabilized: boolean; textLen: number }> {
  const deadline = Date.now() + maxMs
  const readTextLen = async (): Promise<number> => {
    try {
      const res = await runJs(
        'return (document.body && document.body.innerText) ? document.body.innerText.length : 0'
      )
      return res.success && typeof res.result === 'number' ? res.result : 0
    } catch {
      return 0
    }
  }

  const STABLE_SAMPLES = 3
  const JITTER = 8
  let last = await readTextLen()
  let stableCount = 0
  let stabilized = false
  while (Date.now() < deadline) {
    await sleep(300)
    const now = await readTextLen()
    if (Math.abs(now - last) <= JITTER) {
      stableCount += 1
      if (stableCount >= STABLE_SAMPLES && now > 0) {
        stabilized = true
        break
      }
    } else {
      stableCount = 0
    }
    last = now
  }
  return { stabilized, textLen: last }
}

/**
 * Canonicalize a URL for per-task dedup: lowercase host, drop trailing
 * slash + fragment. Falls back to a best-effort string normalization on
 * obviously-malformed URLs so the dedup key still works.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s.toLowerCase()
  } catch {
    return raw.trim().replace(/[/#]+$/, '').toLowerCase()
  }
}
