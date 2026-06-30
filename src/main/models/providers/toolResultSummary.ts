const MAX_SUMMARY_CHARS = 320
const MAX_LINES = 4
const MAX_LINE_CHARS = 180
const MAX_JSON_FRAGMENTS = 6

function cleanInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isUsefulLine(line: string): boolean {
  return /[A-Za-z0-9]/.test(line) && !/^[\[\]{}()",:]+$/.test(line)
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function jsonFragments(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<unknown>()

  const walk = (current: unknown, path: string[]): void => {
    if (out.length >= MAX_JSON_FRAGMENTS) return
    if (current == null) return
    if (typeof current === 'string') {
      const text = cleanInline(current)
      if (!text) return
      const label = path.length > 0 ? `${path.join('.')}: ${text}` : text
      out.push(truncate(label, MAX_LINE_CHARS))
      return
    }
    if (typeof current === 'number' || typeof current === 'boolean') {
      const label = path.length > 0 ? `${path.join('.')}: ${String(current)}` : String(current)
      out.push(label)
      return
    }
    if (typeof current !== 'object') return
    if (seen.has(current)) return
    seen.add(current)

    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item, path)
        if (out.length >= MAX_JSON_FRAGMENTS) return
      }
      return
    }

    const entries = Object.entries(current as Record<string, unknown>)
    entries.sort(([a], [b]) => {
      const rank = (key: string) =>
        /^(error|message|path|file|name|symbol|title|status|count|line|column|url|command|summary|result)$/i.test(key)
          ? 0
          : 1
      return rank(a) - rank(b)
    })
    for (const [key, val] of entries) {
      walk(val, [...path, key])
      if (out.length >= MAX_JSON_FRAGMENTS) return
    }
  }

  walk(value, [])
  return out
}

function summarizeJson(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const parsed = JSON.parse(trimmed)
    const fragments = jsonFragments(parsed)
    if (fragments.length === 0) return null
    return truncate(fragments.join('\n'), MAX_SUMMARY_CHARS)
  } catch {
    return null
  }
}

function summarizeText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => cleanInline(line))
    .filter((line) => line.length > 0)

  const picked: string[] = []
  for (const line of lines) {
    if (!isUsefulLine(line)) continue
    const next = truncate(line, MAX_LINE_CHARS)
    if (picked.includes(next)) continue
    picked.push(next)
    if (picked.length >= MAX_LINES) break
  }

  if (picked.length === 0) {
    return truncate(cleanInline(text), MAX_SUMMARY_CHARS)
  }
  return truncate(picked.join('\n'), MAX_SUMMARY_CHARS)
}

export function summarizeTrimmedToolResult(text: string): string {
  return summarizeJson(text) ?? summarizeText(text)
}
