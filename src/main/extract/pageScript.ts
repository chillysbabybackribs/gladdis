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

    /* ================= 2. Readable content ================= */
    const content = safe(() => {
      // Heuristic main-content pick: largest text container among likely roots.
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
      // Strip obvious chrome from a clone before reading.
      const clone = best.cloneNode(true) as Element
      clone
        .querySelectorAll('script,style,noscript,nav,header,footer,aside,svg,form,iframe,[aria-hidden="true"]')
        .forEach((n) => n.remove())

      const headings = Array.from(clone.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map((h) => ({ level: +h.tagName[1], text: norm(h.textContent || '') }))
        .filter((h) => h.text)
        .slice(0, 300)

      // Lightweight markdown: headings + paragraphs + list items in DOM order.
      const md: string[] = []
      const walk = (node: Element) => {
        for (const child of Array.from(node.children)) {
          const tag = child.tagName.toLowerCase()
          const txt = norm(child.textContent || '')
          if (!txt) continue
          if (/^h[1-6]$/.test(tag)) md.push('#'.repeat(+tag[1]) + ' ' + txt)
          else if (tag === 'p') md.push(txt)
          else if (tag === 'li') md.push('- ' + txt)
          else if (tag === 'pre') md.push('```\n' + txt + '\n```')
          else if (child.children.length) walk(child)
          else if (txt.length > 40) md.push(txt)
          if (md.join('\n').length > CAP.markdown) break
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
        text: clamp(text, CAP.text),
        markdown: clamp(md.join('\n\n'), CAP.markdown),
        headings,
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
      dom
    }
  }

  // Stringify the whole thing as an IIFE that returns the capture object.
  return '(' + extract.toString() + ')()'
}
