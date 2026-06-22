import type { ToolActivity } from '../chatTypes'

/**
 * Shallow array compare — element references must match. Used by `memo`
 * comparators so an array prop rebuilt with the same content (immutable
 * spread + appended new tail) skips re-rendering the heavy children whose
 * internals haven't changed.
 */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Compact human duration: 845ms / 1.4s / 23s / 4.2min. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 1000 * 60) return `${Math.round(ms / 1000)}s`
  return `${(ms / 1000 / 60).toFixed(1)}min`
}

/** Show a URL host+path compactly, falling back to the raw string on parse failure. */
export function normalizeDisplayUrl(url: string, maxLength = 80): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 1 ? parsed.pathname : ''
    const display = `${parsed.hostname}${path}${parsed.search}${parsed.hash}`
    return display.length > maxLength ? `${display.slice(0, maxLength - 1)}…` : display
  } catch {
    return url
  }
}

/** Strip the optional `gladdis.` prefix some Codex-routed tools carry. */
export function baseToolName(tool: string): string {
  return tool.startsWith('gladdis.') ? tool.slice('gladdis.'.length) : tool
}

export function isEditTool(tool: string): boolean {
  const name = baseToolName(tool)
  return name === 'edit_file' || name === 'write_file'
}

/** Truncate noisy tool args before they leak into trace JSON copies. */
export function sanitizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args
  const sanitized = { ...args } as Record<string, unknown>
  if ('text' in sanitized && typeof sanitized.text === 'string' && sanitized.text.length > 200) {
    sanitized.text = `${sanitized.text.slice(0, 200)}…`
  }
  return sanitized
}

/**
 * Pull the "Final URL" line out of a fetch_page preview so we can dedup on
 * the post-redirect URL rather than the originally requested one.
 */
export function extractDigestUrl(preview: string | null | undefined): string | null {
  if (!preview) return null
  const match = preview.match(/(?:Final URL|URL): (https?:\/\/[^\s]+)/)
  return match ? normalizeDisplayUrl(match[1]) : null
}

export function resolvedDurationMs(tool: ToolActivity): number | null {
  if (tool.durationMs != null) return tool.durationMs
  if (tool.startedAt && tool.endedAt) {
    try {
      return new Date(tool.endedAt).getTime() - new Date(tool.startedAt).getTime()
    } catch {
      return null
    }
  }
  return null
}
