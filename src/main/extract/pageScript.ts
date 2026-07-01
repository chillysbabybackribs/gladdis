/**
 * The deterministic in-page extraction payload.
 *
 * This source is stringified (via `.toString()`) and handed to CDP
 * `Runtime.evaluate` so it runs *inside the page's JS context* in an isolated
 * world. It must therefore be a single self-contained function with NO imports
 * and NO references to anything outside its own body. It returns a plain
 * JSON-serializable object matching the renderer-side PageCapture shape.
 *
 * Hardening notes:
 *  - Never throws: every sub-extraction is wrapped so one bad page can't void
 *    the whole capture.
 *  - Caps everything (text length, node counts, selector depth) so a hostile
 *    or huge page can't blow up memory or the IPC payload.
 *  - Pure-deterministic ordering: elements are walked in DOM order.
 */
export function extractionScript(): string {
  function extract() {
    const CAP = {
      text: 200_000, // main content chars
      markdown: 200_000,
      actions: 120, // interactive elements (digest shows far fewer)
      name: 400, // per-element name length
      value: 2000
    }

    const clamp = (s: unknown, n: number): string =>
      typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : ''
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn()
      } catch {
        return fallback
      }
    }

    /* ---------- deterministic CSS selector for any element ---------- */
    function cssPath(el: Element): string {
      if (!(el instanceof Element)) return ''
      // Prefer a stable id when it's a valid simple identifier.
      const id = el.getAttribute('id')
      if (id && /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
        return '#' + CSS.escape(id)
      }
      const parts: string[] = []
      let node: Element | null = el
      let depth = 0
      while (node && node.nodeType === 1 && depth < 6) {
        const cur: Element = node
        let part = cur.tagName.toLowerCase()
        const parent = cur.parentElement
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            (c: Element) => c.tagName === cur.tagName
          )
          if (sameTag.length > 1) {
            part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')'
          }
        }
        parts.unshift(part)
        if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
          parts[0] = '#' + CSS.escape(cur.id)
          break
        }
        node = parent
        depth++
      }
      return parts.join(' > ')
    }

    /* ---------- visibility ---------- */
    function isVisible(el: Element): boolean {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) return false
      return true
    }

    /* ---------- accessible name (best-effort) ---------- */
    function accName(el: Element): string {
      const aria = el.getAttribute('aria-label')
      if (aria) return norm(aria)
      const labelledby = el.getAttribute('aria-labelledby')
      if (labelledby) {
        const t = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
        if (norm(t)) return norm(t)
      }
      const he = el as HTMLElement
      if (he instanceof HTMLInputElement || he instanceof HTMLTextAreaElement) {
        const id = el.getAttribute('id')
        if (id) {
          const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]')
          if (lab?.textContent) return norm(lab.textContent)
        }
        return norm(he.getAttribute('placeholder') || he.getAttribute('name') || '')
      }
      const title = el.getAttribute('title')
      if (title) return norm(title)
      const alt = el.querySelector('img[alt]')?.getAttribute('alt')
      if (alt) return norm(alt)
      return norm(el.textContent || '')
    }

    function roleOf(el: Element): string {
      const explicit = el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      const map: Record<string, string> = {
        a: 'link',
        button: 'button',
        select: 'select',
        textarea: 'textbox',
        summary: 'button'
      }
      if (tag === 'input') {
        const t = (el as HTMLInputElement).type
        if (t === 'checkbox') return 'checkbox'
        if (t === 'radio') return 'radio'
        if (t === 'submit' || t === 'button') return 'button'
        return 'textbox'
      }
      return map[tag] || tag
    }

    /* ================= 1. Interactive action surface ================= */
    const actions = safe(() => {
      const SEL =
        'a[href], button, input, select, textarea, summary, [role="button"], ' +
        '[role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick], [tabindex]'
      const seen = new Set<Element>()
      const out: any[] = []
      const els = Array.from(document.querySelectorAll(SEL))
      let idx = 0
      for (const el of els) {
        if (out.length >= CAP.actions) break
        if (seen.has(el)) continue
        seen.add(el)
        if (!isVisible(el)) continue
        const r = el.getBoundingClientRect()
        const he = el as HTMLElement
        const value =
          (el as HTMLAnchorElement).href ||
          (el as HTMLInputElement).value ||
          el.getAttribute('placeholder') ||
          ''
        idx++
        out.push({
          idx,
          role: roleOf(el),
          name: clamp(accName(el), CAP.name),
          tag: el.tagName.toLowerCase(),
          value: clamp(value, CAP.value) || undefined,
          selector: cssPath(el),
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height)
          },
          inViewport:
            r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
          disabled:
            (he as any).disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined
        })
      }
      return out
    }, [] as any[])

    /* ================= 1b. Blocking overlay (modal / cookie wall / paywall) =================
     * A modal is the ONE thing whose stacking deliberately contradicts its DOM
     * position: appended at the end of <body>, yet covering the top of the screen.
     * The rest of the capture is DOM-ordered, so a covering layer would otherwise
     * land at the bottom of the action list (or get truncated off) and the model
     * would read a normal-looking page while the live tab shows a blocker — the
     * "I'm on the wrong page" false negative. We detect the topmost blocker here so
     * it can be surfaced FIRST, out of DOM order, with a clear "page underneath is
     * fine" signal. */
    const overlay = safe(() => {
      const vw = innerWidth || 1
      const vh = innerHeight || 1
      const viewportArea = vw * vh
      // Candidate roots: real dialogs, aria-modal, common cookie/consent/paywall
      // containers, plus any large fixed/sticky element sitting over page center.
      const explicit = Array.from(
        document.querySelectorAll(
          'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], ' +
            '[class*="modal" i], [class*="cookie" i], [class*="consent" i], ' +
            '[class*="paywall" i], [id*="cookie" i], [id*="consent" i]'
        )
      )
      // The element actually painted at viewport center — the thing a click hits.
      const atCenter = document.elementFromPoint(Math.round(vw / 2), Math.round(vh / 2))
      let centerFixed: Element | null = null
      for (let n: Element | null = atCenter; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position
        if (pos === 'fixed' || pos === 'sticky') {
          centerFixed = n
          break
        }
      }
      const candidates = centerFixed && !explicit.includes(centerFixed)
        ? [...explicit, centerFixed]
        : explicit

      let best: { el: Element; pct: number; kind: string; z: number } | null = null
      for (const el of candidates) {
        if (!isVisible(el)) continue
        const st = getComputedStyle(el)
        const pos = st.position
        // A blocker must be positioned above normal flow.
        if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute' && el.tagName !== 'DIALOG') continue
        const r = el.getBoundingClientRect()
        // Intersection of the element box with the viewport.
        const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
        const ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
        const pct = (iw * ih) / viewportArea
        // Must cover a meaningful slice of the viewport to count as blocking.
        if (pct < 0.12) continue
        const z = parseInt(st.zIndex, 10)
        const zNum = Number.isFinite(z) ? z : 0
        const cls = ((el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '')).toLowerCase()
        let kind = 'fixed-cover'
        if (el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') {
          kind = 'dialog'
        } else if (el.getAttribute('aria-modal') === 'true') {
          kind = 'aria-modal'
        } else if (/cookie|consent|gdpr|paywall/.test(cls)) {
          kind = 'cookie-consent'
        }
        // Prefer the highest-covering, then highest z-index candidate.
        if (!best || pct > best.pct + 0.05 || (Math.abs(pct - best.pct) <= 0.05 && zNum > best.z)) {
          best = { el, pct, kind, z: zNum }
        }
      }

      if (!best) return null

      // Collect the overlay's OWN controls, in DOM order, so the model can act on
      // it (Accept / Reject / ✕) without hunting the bottom of the page list.
      const ctrlSel =
        'a[href], button, input, select, textarea, summary, [role="button"], ' +
        '[role="link"], [role="checkbox"], [onclick], [tabindex]'
      const ctrlEls = Array.from(best.el.querySelectorAll(ctrlSel))
      const seen = new Set<Element>()
      const ovActions: any[] = []
      let oi = 0
      for (const el of ctrlEls) {
        if (ovActions.length >= 12) break
        if (seen.has(el)) continue
        seen.add(el)
        if (!isVisible(el)) continue
        const r = el.getBoundingClientRect()
        const he = el as HTMLElement
        const value =
          (el as HTMLAnchorElement).href ||
          (el as HTMLInputElement).value ||
          el.getAttribute('placeholder') ||
          ''
        oi++
        ovActions.push({
          idx: oi,
          role: roleOf(el),
          name: clamp(accName(el), CAP.name),
          tag: el.tagName.toLowerCase(),
          value: clamp(value, CAP.value) || undefined,
          selector: cssPath(el),
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height)
          },
          inViewport: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
          disabled:
            (he as any).disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined
        })
      }

      // Overlay name: prefer aria-label/heading, else its first heading text.
      let name = norm(best.el.getAttribute('aria-label') || '')
      if (!name) {
        const h = best.el.querySelector('h1, h2, h3, [role="heading"]')
        if (h) name = norm(h.textContent || '')
      }
      if (!name) name = norm(best.el.textContent || '').slice(0, 120)

      return {
        kind: best.kind,
        name: clamp(name, 160),
        coversViewportPct: Math.round(best.pct * 100) / 100,
        actions: ovActions
      }
    }, null as any)

    /* ================= 2. Readable content (clean markdown, no limits) ================= */
    const content = safe(() => {
      // Pick the best content container
      const candidates = Array.from(
        document.querySelectorAll('article, main, [role="main"], #content, .content, body')
      )
      let best: Element = document.body
      let bestLen = 0
      for (const c of candidates) {
        const len = (c.textContent || '').length
        if (len > bestLen) {
          best = c
          bestLen = len
        }
      }

      // Clone and aggressively strip non-content sections
      const clone = best.cloneNode(true) as Element
      const stripSelectors = [
        'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside',
        'svg', 'form', 'iframe', '[aria-hidden="true"]',
        // Modal / overlay chrome is reported separately via `overlay`; keep it
        // out of the readable content so a cookie wall or paywall interstitial
        // doesn't masquerade as the page's actual prose.
        'dialog[open]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
        '.modal', '[class*="modal"]', '[class*="cookie"]', '[class*="consent"]', '[class*="paywall"]',
        // Common non-content containers
        '.nav', '.navbar', '.menu', '.sidebar', '.ad', '.ads', '.advertisement',
        '.cookie', '.cookies', '.banner', '.promo', '.related', '.recommendations',
        '.social', '.share', '.comments', '.comment', '.newsletter', '.subscribe',
        '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
        '[class*="sidebar"]', '[class*="footer"]', '[class*="header"]',
        '[id*="sidebar"]', '[id*="footer"]', '[id*="header"]', '[id*="nav"]'
      ]
      clone.querySelectorAll(stripSelectors.join(',')).forEach((n) => n.remove())

      // Build clean markdown from remaining content
      const md: string[] = []
      const seenTexts = new Set<string>()

      const walk = (node: Element) => {
        for (const child of Array.from(node.children)) {
          const tag = child.tagName.toLowerCase()
          const txt = norm(child.textContent || '')

          if (!txt || seenTexts.has(txt)) continue

          if (/^h[1-6]$/.test(tag)) {
            const level = +tag[1]
            md.push('#'.repeat(level) + ' ' + txt)
            seenTexts.add(txt)
          } else if (tag === 'p') {
            md.push(txt)
            seenTexts.add(txt)
          } else if (tag === 'li') {
            md.push('- ' + txt)
            seenTexts.add(txt)
          } else if (tag === 'pre' || tag === 'code') {
            md.push('```\n' + txt + '\n```')
            seenTexts.add(txt)
          } else if (tag === 'blockquote') {
            md.push('> ' + txt.replace(/\n/g, '\n> '))
            seenTexts.add(txt)
          } else if (child.children.length > 0) {
            walk(child)
          } else if (txt.length > 20) {
            // Catch other meaningful text blocks
            md.push(txt)
            seenTexts.add(txt)
          }
        }
      }

      walk(clone)

      const text = norm(clone.textContent || '')
      const titleEl = document.querySelector('h1')

      return {
        title: norm(titleEl?.textContent || document.title || ''),
        byline:
          (document.querySelector('[rel="author"], .author, [itemprop="author"]')?.textContent &&
            norm(document.querySelector('[rel="author"], .author, [itemprop="author"]')!.textContent!)) ||
          null,
        text,
        markdown: md.join('\n\n'),
        headings: Array.from(clone.querySelectorAll('h1,h2,h3,h4,h5,h6'))
          .map((h) => ({ level: +h.tagName[1], text: norm(h.textContent || '') }))
          .filter((h) => h.text),
        wordCount: text ? text.split(/\s+/).length : 0
      }
    }, {
      title: norm(document.title || ''),
      byline: null,
      text: '',
      markdown: '',
      headings: [] as any[],
      wordCount: 0
    })

    /* ================= 3. Structured data ================= */
    const data = safe(() => {
      const meta: Record<string, string> = {}
      const og: Record<string, string> = {}
      document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
        const key = m.getAttribute('name') || m.getAttribute('property') || ''
        const val = m.getAttribute('content') || ''
        if (!key || !val) return
        if (key.startsWith('og:') || key.startsWith('twitter:')) og[key] = clamp(val, 500)
        else meta[key] = clamp(val, 500)
      })
      const jsonLd: unknown[] = []
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          jsonLd.push(JSON.parse(s.textContent || ''))
        } catch {
          /* skip malformed */
        }
      })
      const feeds = Array.from(
        document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]')
      ).map((l) => ({
        title: l.getAttribute('title') || '',
        href: (l as HTMLLinkElement).href,
        type: l.getAttribute('type') || ''
      }))
      return {
        meta,
        openGraph: og,
        jsonLd: jsonLd.slice(0, 25),
        canonical:
          (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || null,
        feeds,
        lang: document.documentElement.getAttribute('lang') || null
      }
    }, { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null })

    /* ================= 4. Deep DOM signals ================= */
    const dom = safe(() => {
      return {
        nodeCount: document.getElementsByTagName('*').length,
        htmlBytes: (document.documentElement.outerHTML || '').length,
        frameCount: document.querySelectorAll('iframe,frame').length
      }
    }, { nodeCount: 0, htmlBytes: 0, frameCount: 0 })

    return {
      url: location.href,
      title: document.title,
      content,
      data,
      actions,
      ...(overlay ? { overlay } : {}),
      dom
    }
  }

  // Stringify the whole thing as an IIFE that returns the capture object.
  return '(' + extract.toString() + ')()'
}
