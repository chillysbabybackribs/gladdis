import type { PageCapture, ActionNode, OverlayInfo } from '../../../shared/extraction'

/**
 * DOM-order orientation wireframe, built from PageExtractor's PageCapture.
 *
 * This is the orientation source that WORKS on real pages. The a11y-tree
 * wireframe failed on HN (52 empty `row` nodes, footer links first, stories
 * crowded out by a node cap) because table-heavy pages expose their content on
 * child text nodes the a11y walk drops. PageCapture.actions, by contrast, is
 * "the interactive action surface, ordered by DOM position" — real names, hrefs,
 * selectors, coords — the same data grep_page reads correctly.
 *
 * We NEVER reorder. Document order is the page's own order, and "top" means the
 * first item. The model (which has the prompt) decides what matters.
 */

export type WireframeLine =
  | { kind: 'action'; idx: number; role: string; name: string; href?: string }
  | { kind: 'group'; role: string; count: number; idxStart: number; idxEnd: number }

export interface PageWireframe {
  url: string
  title: string
  /** Heading outline from the readable content, in document order. */
  headings: Array<{ level: number; text: string }>
  lines: WireframeLine[]
  totalActions: number
  truncated: boolean
  /** Blocking overlay on top of the page right now, if any. */
  overlay?: OverlayInfo
}

const MAX_LINES = 60
const RUN_COLLAPSE_MIN = 5
const MAX_NAME = 90

function isRepetitive(a: ActionNode): boolean {
  const n = (a.name ?? '').trim()
  // A "N comments"/"N replies" LINK is a real navigation target (it points into
  // a thread), not dead boilerplate — never collapse those, the model wants
  // them. Only pure timestamps, bare point counts, and tiny labels collapse.
  const isThreadLink =
    a.role === 'link' && !!a.value && /^\d+\s*(comments?|replies?)$/i.test(n)
  if (isThreadLink) return false
  return (
    n.length <= 2 ||
    /^\d+\s*(hours?|minutes?|days?|months?|years?|sec(ond)?s?)\s*ago$/i.test(n) ||
    /^\d+\s*(comments?|points?|replies?|votes?)$/i.test(n)
  )
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Build a document-order wireframe from a PageCapture. Actions are taken in
 * their existing DOM order (NOT ranked). Consecutive repetitive same-role runs
 * (timestamps, "N comments") collapse in place to one line with an idx range.
 */
export function buildPageWireframe(cap: PageCapture): PageWireframe {
  const actions = (cap.actions ?? []).filter((a) => (a.name?.trim() || a.value?.trim()))
  const lines: WireframeLine[] = []

  let i = 0
  while (i < actions.length && lines.length < MAX_LINES) {
    const role = actions[i].role
    // A repetitive run = consecutive same-role actions with repetitive names.
    let j = i
    while (j < actions.length && actions[j].role === role && isRepetitive(actions[j])) j++
    const runLen = j - i
    if (runLen >= RUN_COLLAPSE_MIN) {
      lines.push({ kind: 'group', role, count: runLen, idxStart: actions[i].idx, idxEnd: actions[j - 1].idx })
      i = j
      continue
    }
    const a = actions[i]
    lines.push({
      kind: 'action',
      idx: a.idx,
      role: a.role,
      name: trunc((a.name ?? a.value ?? '').trim(), MAX_NAME),
      ...(a.role === 'link' && a.value ? { href: a.value } : {})
    })
    i += 1
  }

  return {
    url: cap.url,
    title: cap.title,
    headings: (cap.content?.headings ?? []).slice(0, 20),
    lines,
    totalActions: actions.length,
    truncated: actions.length > lines.length || i < actions.length,
    ...(cap.overlay ? { overlay: cap.overlay } : {})
  }
}

/**
 * One-line-per-control banner describing a blocking overlay. Rendered BEFORE the
 * wireframe so the model reads "a layer is in front, the page underneath is fine,
 * here's how to dismiss it" before it ever judges whether it's on the right page.
 */
export function formatOverlayBanner(ov: OverlayInfo): string {
  const kindLabel =
    ov.kind === 'cookie-consent'
      ? 'cookie/consent wall'
      : ov.kind === 'dialog'
        ? 'modal dialog'
        : ov.kind === 'aria-modal'
          ? 'modal dialog'
          : 'blocking overlay'
  const pct = Math.round(ov.coversViewportPct * 100)
  const name = ov.name ? ` "${trunc(ov.name, 80)}"` : ''
  const out: string[] = []
  out.push(
    `⚠ ACTIVE OVERLAY: a ${kindLabel}${name} is covering the page (≈${pct}% of the viewport).`
  )
  out.push(
    `  The underlying page loaded correctly — this is a layer ON TOP, not the wrong page. Dismiss or answer this overlay first.`
  )
  if (ov.actions.length) {
    out.push('  Overlay controls:')
    for (const a of ov.actions.slice(0, 8)) {
      const cx = a.rect ? Math.round(a.rect.x + a.rect.w / 2) : '?'
      const cy = a.rect ? Math.round(a.rect.y + a.rect.h / 2) : '?'
      out.push(`    #${a.idx} ${a.role}: ${trunc((a.name || a.value || '').trim(), 60)}  (${cx}, ${cy})`)
    }
  } else {
    out.push('  (no distinct controls detected — try grep_click on its visible label, press Escape, or click_xy outside it)')
  }
  return out.join('\n')
}

/** Render the wireframe as a compact, document-order text block for the model. */
export function formatPageWireframe(wire: PageWireframe): string {
  const out: string[] = []
  // Overlay banner comes FIRST — before anything DOM-ordered — because it is the
  // one thing whose stacking contradicts DOM order and the usual cause of a
  // "this looks like the wrong page" misread.
  if (wire.overlay) {
    out.push(formatOverlayBanner(wire.overlay))
    out.push('')
  }
  if (wire.headings.length) {
    out.push('OUTLINE:')
    for (const h of wire.headings.slice(0, 12)) {
      out.push(`  ${'  '.repeat(Math.max(0, h.level - 1))}${trunc(h.text, 80)}`)
    }
  }
  out.push('INTERACTIVE (document order — "top" = first):')
  for (const line of wire.lines) {
    if (line.kind === 'group') {
      out.push(`  [${line.count}× ${line.role} idx ${line.idxStart}–${line.idxEnd}]`)
    } else {
      const href = line.href ? ` → ${trunc(line.href, 60)}` : ''
      out.push(`  #${line.idx} ${line.role}: ${line.name}${href}`)
    }
  }
  if (wire.lines.length === 0) out.push('  (no interactive elements found)')
  if (wire.truncated) out.push(`  … (${wire.totalActions} interactive elements total, list capped)`)
  return out.join('\n')
}
