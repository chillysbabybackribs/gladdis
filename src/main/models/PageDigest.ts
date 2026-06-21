/**
 * PageDigest — deterministic, bounded page summariser.
 *
 * Takes a raw PageCapture (which can be 50–200 KB of JSON) and produces a
 * tightly-bounded "paper" the LLM can read and act on. Hard ceiling: ≤3 500
 * tokens (~14 000 chars) regardless of page size.
 *
 * The output is structured plain-text (not JSON) so the model reads it as
 * prose rather than having to mentally parse a schema. Sections are labelled
 * and self-skipping when empty, so the model always gets a tight, signal-dense
 * brief — never raw HTML, never a 30-field JSON blob.
 *
 * Token budget breakdown (chars ≈ tokens×4). Content-first: most read_page
 * calls are to UNDERSTAND a page, so prose gets the larger share and the
 * click-table is trimmed to what's needed to drive.
 *   URL + title + meta           ~200 chars
 *   Content summary              ≤3 000 chars  (750 tokens)
 *   Structured data (OG/LD)      ≤600 chars    (150 tokens)
 *   Interactive actions          ≤3 000 chars  (750 tokens)
 *   Headings outline             ≤600 chars    (150 tokens)
 *   Key links                    ≤1 200 chars  (300 tokens)
 *   ─────────────────────────────────────────────────────────
 *   Total ceiling                ≤8 600 chars  (~2 150 tokens)
 */

import type { PageCapture, ActionNode } from '../../../shared/types'
// ActionNode is imported for the rankActions helper — TS uses it structurally.

const CONTENT_CHARS     = 3_000
const OG_CHARS          = 600
const HEADINGS_CHARS    = 600
const LINKS_CHARS       = 1_200
const ACTIONS_CHARS     = 3_000   // total budget for the action table
const MAX_ACTIONS       = 40      // action rows sent to the model
const MAX_ACTION_NAME   = 60      // truncate long labels
const MAX_ACTION_VALUE  = 80      // truncate long href/values

export interface DigestOptions {
  /** Include only actions that are in the viewport (default: false → all). */
  viewportOnly?: boolean
  /**
   * Hint about what we care about — passed through to the action scorer so
   * relevant elements rank higher even if they're out-of-viewport.
   */
  focus?: string
}

/**
 * Produce a tightly-bounded plain-text digest of a PageCapture.
 * Called by the deterministic `read_page` tool implementation in BrowserTools.
 */
export function digestPage(cap: PageCapture, opts: DigestOptions = {}): string {
  const sections: string[] = []

  // ── Identity ─────────────────────────────────────────────────────────────
  sections.push(`URL: ${cap.url}`)
  sections.push(`TITLE: ${cap.title ?? '(untitled)'}`)
  if (cap.content?.title && cap.content.title !== cap.title) {
    sections.push(`PAGE HEADING: ${cap.content.title}`)
  }
  sections.push(`WORDS: ~${cap.content?.wordCount ?? 0}`)

  // ── Content summary ───────────────────────────────────────────────────────
  const rawContent = (cap.content?.markdown ?? cap.content?.text ?? '').trim()
  if (rawContent) {
    sections.push('')
    sections.push('── CONTENT ──')
    sections.push(trunc(rawContent, CONTENT_CHARS))
  }

  // ── Structured data (OG / JSON-LD) ───────────────────────────────────────
  const ogLines: string[] = []
  const og = cap.data?.openGraph ?? {}
  for (const [k, v] of Object.entries(og)) {
    if (v) ogLines.push(`  og:${k} = ${String(v).slice(0, 120)}`)
  }
  const meta = cap.data?.meta ?? {}
  for (const [k, v] of Object.entries(meta)) {
    if (v && !['viewport', 'charset', 'theme-color'].includes(k)) {
      ogLines.push(`  meta:${k} = ${String(v).slice(0, 120)}`)
    }
  }
  if (ogLines.length) {
    const joined = trunc(ogLines.join('\n'), OG_CHARS)
    sections.push('')
    sections.push('── META / OG ──')
    sections.push(joined)
  }

  // ── Headings outline ─────────────────────────────────────────────────────
  const headings = cap.content?.headings ?? []
  if (headings.length) {
    const lines = headings
      .slice(0, 20)
      .map((h) => `  ${'#'.repeat(Math.min(h.level, 6))} ${h.text}`)
    sections.push('')
    sections.push('── HEADINGS ──')
    sections.push(trunc(lines.join('\n'), HEADINGS_CHARS))
  }

  // ── Interactive actions ───────────────────────────────────────────────────
  const actions = rankActions(cap.actions ?? [], opts)
  if (actions.length) {
    sections.push('')
    sections.push(`── ACTIONS (${actions.length} shown, ranked by relevance) ──`)
    sections.push('idx | role         | name / label                                    | x    y   | selector')
    sections.push('────┼──────────────┼─────────────────────────────────────────────────┼──────────┼─────────')
    const rows = actions.map((a) => {
      const cx = a.rect ? Math.round(a.rect.x + a.rect.w / 2) : '?'
      const cy = a.rect ? Math.round(a.rect.y + a.rect.h / 2) : '?'
      const name = trunc(a.name ?? a.value ?? '', MAX_ACTION_NAME).padEnd(MAX_ACTION_NAME, ' ')
      const role = (a.role ?? '').padEnd(12, ' ')
      const sel  = trunc(a.selector ?? '', 60)
      const vp   = a.inViewport ? '' : '↑'
      const dis  = a.disabled   ? '✗' : ''
      return ` ${String(a.idx).padStart(3)} | ${role} | ${name} | ${String(cx).padStart(4)} ${String(cy).padStart(4)}${vp}${dis} | ${sel}`
    })
    sections.push(trunc(rows.join('\n'), ACTIONS_CHARS))
  }

  // ── Notable links ─────────────────────────────────────────────────────────
  const links = extractLinks(cap)
  if (links.length) {
    sections.push('')
    sections.push('── KEY LINKS ──')
    const lines = links.map((l) => `  [${trunc(l.text, 60)}] ${trunc(l.href, MAX_ACTION_VALUE)}`)
    sections.push(trunc(lines.join('\n'), LINKS_CHARS))
  }

  return sections.join('\n')
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Score actions by usefulness. Higher = shown first. */
function score(a: ActionNode, focus?: string): number {
  let s = 0
  if (a.inViewport)  s += 4
  if (!a.disabled)   s += 3
  if (a.name?.trim()) s += 2
  if (/(button|link|textbox|combobox|checkbox|radio|searchbox|menuitem)/i.test(a.role)) s += 2
  if (focus) {
    const fl = focus.toLowerCase()
    if ((a.name ?? '').toLowerCase().includes(fl)) s += 5
    if ((a.selector ?? '').toLowerCase().includes(fl)) s += 3
  }
  return s
}

function rankActions(actions: ActionNode[], opts: DigestOptions): ActionNode[] {
  let pool = opts.viewportOnly ? actions.filter((a) => a.inViewport) : actions
  return [...pool]
    .sort((a, b) => score(b, opts.focus) - score(a, opts.focus))
    .slice(0, MAX_ACTIONS)
}

function extractLinks(cap: PageCapture): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = []
  const seen = new Set<string>()
  for (const a of cap.actions ?? []) {
    if (a.role !== 'link' || !a.value) continue
    if (seen.has(a.value)) continue
    seen.add(a.value)
    out.push({ text: a.name ?? a.value, href: a.value })
    if (out.length >= 30) break
  }
  return out
}
