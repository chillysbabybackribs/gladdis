/**
 * @vitest-environment jsdom
 *
 * Real-DOM smoke test for the in-page grep payload. Unlike the mocked
 * browserTools tests, this RUNS the actual JS payload `executeGrepInTab` ships,
 * against a real (jsdom) DOM that reproduces the exact traps seen on live pages:
 *   - "436 comments" (non-breaking space) — the HN link act failed to click
 *   - whitespace-collapsed multi-word queries
 * This is the only layer that exercises the whitespace-normalization fix, which
 * lives inside the JS string and never runs in a unit test that mocks
 * executeJavaScript.
 */
import { describe, expect, it } from 'vitest'
import { executeGrepInTab } from './perceiveTools'

// Run a Gladdis-style payload: a function body that uses `return`, with `this`
// bound to window so `document`/`getComputedStyle`/`window` resolve.
function runInPage(payload: string): unknown {
  // eslint-disable-next-line no-new-func
  const fn = new Function(payload)
  return fn.call(globalThis)
}

function tabsFor(html: string) {
  document.body.innerHTML = html
  // jsdom does no layout, so getBoundingClientRect is all zeros and
  // isElementVisible would reject everything. Give every element a believable
  // on-screen box so we test MATCHING, not layout.
  const rect = { left: 10, top: 20, width: 100, height: 16, right: 110, bottom: 36, x: 10, y: 20, toJSON() {} }
  Element.prototype.getBoundingClientRect = () => rect as DOMRect
  // jsdom does NOT implement innerText (returns undefined) — the payload reads
  // innerText everywhere (in a real browser it's the visible, layout-aware text).
  // Polyfill it to textContent so the matching logic has text to work on; this
  // is the closest jsdom approximation and is sufficient for the nbsp/whitespace
  // matching paths we're validating.
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return (this as HTMLElement).textContent ?? ''
      }
    })
  }
  return {
    async executeJavaScript(_tabId: string, code: string) {
      try {
        return { success: true, result: runInPage(code) }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    }
  }
}

describe('grep payload (real DOM)', () => {
  it('matches a literal multi-word query across a non-breaking space', async () => {
    // The exact HN trap: link text is "436 comments" (nbsp), query is "436 comments".
    const tabs = tabsFor(
      `<td class="subtext"><a href="item?id=1">436 comments</a> <a href="hide">hide</a></td>`
    )
    const res = await executeGrepInTab(tabs as any, 'tab-1', '436 comments', 'text', false, 2)
    expect(res.success).toBe(true)
    const hits = ((res.result as any[]) ?? []).filter((m) => m.type !== 'error')
    expect(hits.length, 'nbsp-separated "436 comments" should match').toBeGreaterThan(0)
  })

  it('matches when query spacing differs from the DOM spacing', async () => {
    const tabs = tabsFor(`<p>Save   50%   on   annual   billing.</p>`)
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Save 50% on annual billing', 'text', false, 2)
    expect(res.success).toBe(true)
    const hits = ((res.result as any[]) ?? []).filter((m) => m.type !== 'error')
    expect(hits.length, 'collapsed-whitespace query should still match').toBeGreaterThan(0)
  })

  it('still finds a plain single-word match (no regression)', async () => {
    const tabs = tabsFor(`<button class="btn">Upgrade Now</button>`)
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Upgrade', 'text', false, 2)
    expect(res.success).toBe(true)
    const hits = ((res.result as any[]) ?? []).filter((m) => m.type !== 'error')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('matches a form control by aria-label when it has no visible text (the Google Flights trap)', async () => {
    // Exact reproduction of the set_field failure: an input whose name lives in
    // aria-label/placeholder, with empty value/innerText. A plain innerText grep
    // finds nothing; the label-match pass must resolve it.
    const tabs = tabsFor(
      `<div><input type="text" role="combobox" aria-label="Where to? " placeholder="Where to?" value=""></div>`
    )
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Where to?', 'text', false, 2)
    expect(res.success).toBe(true)
    const hits = ((res.result as any[]) ?? []).filter((m) => m.type !== 'error')
    expect(hits.length, 'aria-label control should resolve').toBeGreaterThan(0)
    const control = hits.find((m) => m.type === 'control_match')
    expect(control, 'should return a control_match with coordinates').toBeTruthy()
    expect(control.coordinates).toBeTruthy()
    expect(control.visible).toBe(true)
  })

  it('matches a date/departure input by placeholder label', async () => {
    const tabs = tabsFor(
      `<input type="text" class="TP4Lpb" placeholder="Departure" aria-label="Departure">`
    )
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Departure', 'text', false, 2)
    const hits = ((res.result as any[]) ?? []).filter((m) => m.type !== 'error')
    expect(hits.some((m) => m.type === 'control_match')).toBe(true)
  })

  it('ranks the exact-label control ahead of a partial one', async () => {
    const tabs = tabsFor(
      `<input aria-label="Search everywhere else"><input aria-label="Search">`
    )
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Search', 'text', false, 2)
    const controls = ((res.result as any[]) ?? []).filter((m) => m.type === 'control_match')
    expect(controls.length).toBeGreaterThanOrEqual(2)
    // Exact "Search" must come first so matchIndex 0 hits the right field.
    expect(controls[0].label.toLowerCase()).toBe('search')
  })

  it('does not turn ordinary page-text grep into control noise', async () => {
    // A query that matches page prose but no control label must not fabricate
    // control_match entries.
    const tabs = tabsFor(`<p>Departure lounge access is included.</p>`)
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Departure lounge access', 'text', false, 2)
    const controls = ((res.result as any[]) ?? []).filter((m) => m.type === 'control_match')
    expect(controls.length).toBe(0)
  })

  it('returns a qualified lead when the line is semantically close but not exact', async () => {
    const tabs = tabsFor(`<p>The tower is 330 metres (1,083 ft) tall.</p>`)
    const res = await executeGrepInTab(tabs as any, 'tab-1', 'Height 300 meters', 'text', false, 2)
    expect(res.success).toBe(true)
    expect((res.result as any[]) ?? []).toHaveLength(0)
    expect(res.qualifiedLeads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text_lead',
          matchedLine: 'The tower is 330 metres (1,083 ft) tall.',
          overlapTerms: expect.arrayContaining(['height', 'metre'])
        })
      ])
    )
  })
})
