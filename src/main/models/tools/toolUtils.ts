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
