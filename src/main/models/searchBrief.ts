/**
 * Deterministic, query-focused page compression for search tool results.
 *
 * Unlike read_page / fetch_page (which need action tables and broad context),
 * search only needs evidence the model can synthesize from — scored excerpts,
 * matching headings, structured-data nuggets, and relevant code. No LLM.
 */

import type { PageCapture } from '../../../shared/types'

const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our',
  'out', 'get', 'has', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did',
  'let', 'put', 'say', 'she', 'too', 'use', 'with', 'from', 'this', 'that', 'what', 'when', 'where',
  'which', 'will', 'your', 'about', 'into', 'more', 'some', 'than', 'them', 'then', 'these', 'they',
  'have', 'been', 'being', 'would', 'could', 'should', 'also', 'just', 'like', 'make', 'need', 'want'
])

export interface SearchBriefOptions {
  query: string
  /** Per-page char budget. Default 750 (~190 tokens). */
  maxChars?: number
}

export function queryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )]
}

export function scoreText(text: string, terms: string[]): number {
  if (!text.trim() || terms.length === 0) return 0
  const lower = text.toLowerCase()
  let score = 0
  for (const t of terms) {
    if (lower.includes(t)) score += 1
  }
  // Phrase proximity: consecutive query terms appearing near each other
  for (let i = 0; i < terms.length - 1; i++) {
    const pair = `${terms[i]} ${terms[i + 1]}`
    if (lower.includes(pair)) score += 2
  }
  // Penalize boilerplate-y lines
  if (/^(home|menu|skip to|cookie|subscribe|sign in|log in|privacy|terms)\b/i.test(text.trim())) {
    score -= 2
  }
  return score
}

/** Compress a PageCapture into a tight, query-scored evidence card. */
export function briefPageForSearch(cap: PageCapture, opts: SearchBriefOptions): string {
  const maxChars = opts.maxChars ?? 750
  const terms = queryTerms(opts.query)
  const lines: string[] = [`${trunc(cap.title || 'untitled', 80)} | ${cap.url}`]

  const structured = harvestStructuredSignals(cap, terms, 200)
  if (structured) lines.push(structured)

  const headings = (cap.content?.headings ?? [])
    .filter((h) => terms.length === 0 || scoreText(h.text, terms) > 0)
    .slice(0, 3)
    .map((h) => h.text)
  if (headings.length) lines.push(`§ ${headings.join(' · ')}`)

  const body = (cap.content?.markdown ?? cap.content?.text ?? '').trim()
  const excerpts = selectQueryExcerpts(body, terms, Math.min(420, maxChars - lines.join('\n').length - 80))
  for (const ex of excerpts) lines.push(`• ${ex}`)

  const code = extractRelevantCode(body, terms, 280)
  if (code) lines.push(`\`\`\`\n${code}\n\`\`\``)

  return trunc(lines.join('\n'), maxChars)
}

/** Pull pre-authored summaries from JSON-LD / OG before touching body text. */
export function harvestStructuredSignals(cap: PageCapture, terms: string[], maxChars: number): string {
  const bits: string[] = []
  const og = cap.data?.openGraph ?? {}
  for (const key of ['description', 'title'] as const) {
    const v = og[key]
    if (v && scoreText(String(v), terms) > 0) bits.push(String(v))
  }
  const desc = cap.data?.meta?.description
  if (desc && scoreText(desc, terms) > 0) bits.push(desc)

  for (const node of cap.data?.jsonLd ?? []) {
    collectJsonLdText(node, bits, 0)
  }

  const unique = dedupeStrings(bits.map((b) => norm(b)).filter(Boolean))
  const scored = unique
    .map((text) => ({ text, score: scoreText(text, terms) }))
    .filter((x) => x.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) return ''
  return trunc(scored.slice(0, 2).map((x) => x.text).join(' — '), maxChars)
}

function collectJsonLdText(node: unknown, out: string[], depth: number): void {
  if (depth > 4 || out.length > 8) return
  if (typeof node === 'string') {
    if (node.length > 20 && node.length < 800) out.push(node)
    return
  }
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  for (const key of ['description', 'text', 'headline', 'name', 'abstract', 'articleBody'] as const) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 15) out.push(v)
  }
  if (obj.acceptedAnswer && typeof obj.acceptedAnswer === 'object') {
    collectJsonLdText((obj.acceptedAnswer as Record<string, unknown>).text, out, depth + 1)
  }
  if (Array.isArray(obj.mainEntity)) {
    for (const item of obj.mainEntity) collectJsonLdText(item, out, depth + 1)
  }
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdText(item, out, depth + 1)
  }
}

/** Score paragraphs and sentences; return top non-redundant excerpts.
 *  Prefers larger heading-bounded windows when they score well.
 */
export function selectQueryExcerpts(body: string, terms: string[], maxChars: number): string[] {
  if (!body.trim()) return []
  const candidates: Array<{ text: string; score: number }> = []

  // Paragraph + sentence level (kept for fallback)
  const paragraphs = body.split(/\n{2,}/).map((p) => norm(p)).filter((p) => p.length > 40)
  for (const p of paragraphs) {
    const base = scoreText(p, terms)
    if (base > 0) candidates.push({ text: p, score: base + p.length / 800 })
    if (p.length > 180) {
      for (const s of splitSentences(p)) {
        if (s.length < 40) continue
        const sScore = scoreText(s, terms)
        if (sScore > 0) candidates.push({ text: s, score: sScore })
      }
    }
  }

  // Heading-bounded windows — capture larger explanatory blocks when relevant
  for (const m of body.matchAll(/^#{1,4}\s+(.+)$/gm)) {
    const idx = m.index ?? 0
    const rest = body.slice(idx + m[0].length)
    const untilNext = rest.split(/^#{1,4}\s+/m)[0] ?? rest
    const window = norm(`${m[1]}. ${untilNext}`)
    if (window.length > 80) {
      const baseScore = scoreText(window, terms)
      if (baseScore > 0) {
        candidates.push({ text: window, score: baseScore + 3.0 })
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const picked: string[] = []
  let used = 0
  for (const c of candidates) {
    if (c.score <= 0 && terms.length > 0) continue
    // Allow larger excerpts for high-scoring heading windows
    const maxLen = c.score > 4 ? 480 : 160
    const snippet = trunc(c.text, maxLen)
    if (picked.some((p) => overlapRatio(p, snippet) > 0.65)) continue
    if (used + snippet.length > maxChars) break
    picked.push(snippet)
    used += snippet.length
    if (picked.length >= 4) break
  }
  return picked
}

function extractRelevantCode(body: string, terms: string[], maxChars: number): string {
  const blocks: string[] = []
  for (const m of body.matchAll(/```[\w]*\n([\s\S]*?)```/g)) {
    const block = m[1]?.trim()
    if (!block || block.length < 8) continue
    if (terms.length === 0 || scoreText(block, terms) > 0) blocks.push(block)
  }
  if (!blocks.length) return ''
  return trunc(blocks.sort((a, b) => scoreText(b, terms) - scoreText(a, terms))[0], maxChars)
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => norm(s)).filter((s) => s.length > 0)
}

function overlapRatio(a: string, b: string): number {
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  if (al.includes(bl) || bl.includes(al)) return 1
  const aw = new Set(al.split(/\W+/).filter((w) => w.length > 3))
  const bw = bl.split(/\W+/).filter((w) => w.length > 3)
  if (!aw.size || !bw.length) return 0
  let hit = 0
  for (const w of bw) if (aw.has(w)) hit++
  return hit / Math.max(aw.size, bw.length)
}

function dedupeStrings(items: string[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (out.some((o) => overlapRatio(o, item) > 0.8)) continue
    out.push(item)
  }
  return out
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
