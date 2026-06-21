/**
 * In-page visual overlay for the action surface.
 *
 * Like pageScript, this is stringified and run via CDP Runtime.evaluate inside
 * the page. It paints a fixed-position layer of boxes + numeric labels over
 * every interactive element, matching the `idx` returned by the extractor.
 *
 * It is self-cleaning and re-entrant: calling with on=false removes it; calling
 * with on=true rebuilds it. The overlay container carries data-gladdis so the
 * extractor's own selectors never pick it up, and pointer-events are disabled
 * so it can't interfere with the page.
 */

const OVERLAY_ID = '__gladdis_overlay__'

/** Returns a JS expression that toggles the overlay and returns the box count. */
export function overlayScript(on: boolean): string {
  function build(overlayId: string, enable: boolean) {
    const prev = document.getElementById(overlayId)
    if (prev) prev.remove()
    if (!enable) return 0

    const SEL =
      'a[href], button, input, select, textarea, summary, [role="button"], ' +
      '[role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick], [tabindex]'

    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const st = getComputedStyle(el)
      return !(st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0)
    }
    const palette = [
      '#4493f8',
      '#e5534b',
      '#3fb950',
      '#d29922',
      '#a371f7',
      '#39c5cf',
      '#ec6cb9'
    ]

    const root = document.createElement('div')
    root.id = overlayId
    root.setAttribute('data-gladdis', 'overlay')
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
      'font:11px/1.2 ui-monospace,monospace;'

    const seen = new Set<Element>()
    let idx = 0
    const els = Array.from(document.querySelectorAll(SEL))
    for (const el of els) {
      if (idx >= 120) break
      if (seen.has(el)) continue
      seen.add(el)
      if (!isVisible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
        // Off-screen: still counts toward idx so labels match the extractor.
        idx++
        continue
      }
      idx++
      const color = palette[idx % palette.length]
      const box = document.createElement('div')
      box.style.cssText =
        'position:absolute;left:' +
        r.left +
        'px;top:' +
        r.top +
        'px;width:' +
        r.width +
        'px;height:' +
        r.height +
        'px;border:1.5px solid ' +
        color +
        ';border-radius:2px;box-sizing:border-box;background:' +
        color +
        '14;'
      const tag = document.createElement('span')
      tag.textContent = String(idx)
      tag.style.cssText =
        'position:absolute;left:' +
        Math.max(0, r.left) +
        'px;top:' +
        Math.max(0, r.top - 14) +
        'px;background:' +
        color +
        ';color:#fff;padding:0 3px;border-radius:2px;font-weight:700;'
      root.appendChild(box)
      root.appendChild(tag)
    }

    document.documentElement.appendChild(root)
    return idx
  }

  return '(' + build.toString() + ')(' + JSON.stringify(OVERLAY_ID) + ',' + JSON.stringify(on) + ')'
}
