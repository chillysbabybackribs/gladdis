import crypto from 'node:crypto'

const MAX_SUMMARY_CHARS = 320
const MAX_LINES = 4
const MAX_LINE_CHARS = 180
const MAX_JSON_FRAGMENTS = 6
const SUMMARY_ID_CACHE_LIMIT = 256
const SUMMARY_HASH_CACHE_LIMIT = 256

const summaryByToolCallId = new Map<string, string>()
const summaryByContentHash = new Map<string, string>()
const renderedStubByToolCallId = new Map<string, string>()
let summaryComputeCount = 0
let renderedStubComputeCount = 0

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

function summarizeTrimmedToolResultUncached(text: string): string {
  summaryComputeCount += 1
  return summarizeJson(text) ?? summarizeText(text)
}

function contentHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex')
}

function rememberBounded<K>(map: Map<K, string>, key: K, value: string, limit: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > limit) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) map.delete(oldestKey)
  }
}

export function summarizeTrimmedToolResult(text: string, toolCallId?: string): string {
  const cleanToolCallId = toolCallId?.trim()
  if (cleanToolCallId) {
    const cachedById = summaryByToolCallId.get(cleanToolCallId)
    if (cachedById) return cachedById
  }

  const hash = contentHash(text)
  const cachedByHash = summaryByContentHash.get(hash)
  if (cachedByHash) {
    if (cleanToolCallId) rememberBounded(summaryByToolCallId, cleanToolCallId, cachedByHash, SUMMARY_ID_CACHE_LIMIT)
    return cachedByHash
  }

  const summary = summarizeTrimmedToolResultUncached(text)
  rememberBounded(summaryByContentHash, hash, summary, SUMMARY_HASH_CACHE_LIMIT)
  if (cleanToolCallId) rememberBounded(summaryByToolCallId, cleanToolCallId, summary, SUMMARY_ID_CACHE_LIMIT)
  return summary
}

type TrimmedToolStubArgs = {
  prefix: string
  toolCallId?: string
  lead: string
  text: string
}

export function renderTrimmedToolResultStub(args: TrimmedToolStubArgs): string {
  const cleanToolCallId = args.toolCallId?.trim()
  if (cleanToolCallId) {
    const cachedStub = renderedStubByToolCallId.get(cleanToolCallId)
    if (cachedStub) return cachedStub
  }

  const summary = summarizeTrimmedToolResult(args.text, cleanToolCallId)
  renderedStubComputeCount += 1
  const stub =
    `${args.prefix} (id ${cleanToolCallId ?? 'unknown'}) — ${args.lead}\n` +
    `${summary}\n` +
    `Call recall_history with tool_call_id "${cleanToolCallId ?? 'unknown'}" to read it in full.`

  if (cleanToolCallId) rememberBounded(renderedStubByToolCallId, cleanToolCallId, stub, SUMMARY_ID_CACHE_LIMIT)
  return stub
}

export const __testInternals = {
  resetSummaryCaches(): void {
    summaryByToolCallId.clear()
    summaryByContentHash.clear()
    renderedStubByToolCallId.clear()
    summaryComputeCount = 0
    renderedStubComputeCount = 0
  },
  getSummaryCacheState(): {
    idEntries: number
    hashEntries: number
    computeCount: number
    renderedStubEntries: number
    renderedStubComputeCount: number
  } {
    return {
      idEntries: summaryByToolCallId.size,
      hashEntries: summaryByContentHash.size,
      computeCount: summaryComputeCount,
      renderedStubEntries: renderedStubByToolCallId.size,
      renderedStubComputeCount
    }
  }
}
