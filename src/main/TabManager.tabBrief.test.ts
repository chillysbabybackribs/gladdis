import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { SLOW_LOAD_THRESHOLD_MS, TabManager } from './TabManager'

/**
 * A minimal but COMPLETE webContents stand-in — the fields tabBrief()/info()
 * actually read. (The watchNetwork harness omits getURL/getTitle, which is a
 * separate pre-existing gap; these tests carry their own full mock so they are
 * self-contained.)
 */
function fakeWebContents(url: string, opts: { loading?: boolean; title?: string } = {}) {
  const wc: any = Object.assign(new EventEmitter(), {
    getURL: () => url,
    getTitle: () => opts.title ?? '',
    isLoading: () => opts.loading ?? false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }
  })
  return wc
}

/** Register a fake tab directly on the manager's private map + order list. */
function addTab(
  manager: TabManager,
  id: string,
  url: string,
  opts: { loading?: boolean; title?: string; loadingStartedAt?: number | null } = {}
): any {
  const wc = fakeWebContents(url, opts)
  const tab = { id, view: { webContents: wc }, cdp: {}, favicon: null, loadingStartedAt: opts.loadingStartedAt ?? null }
  ;(manager as any).tabs.set(id, tab)
  ;(manager as any).order.push(id)
  ;(manager as any).activeId = (manager as any).activeId ?? id
  return tab
}

function makeManager(): TabManager {
  return new TabManager({} as any, () => {}, () => {})
}

describe('TabManager.tabBrief', () => {
  it('reports 1-based index and total count for the active tab', () => {
    const m = makeManager()
    addTab(m, 'tab-1', 'https://a.test/')
    addTab(m, 'tab-2', 'https://b.test/')
    addTab(m, 'tab-3', 'https://c.test/')
    ;(m as any).activeId = 'tab-2'

    const brief = m.tabBrief()
    expect(brief).not.toBeNull()
    expect(brief!.id).toBe('tab-2')
    expect(brief!.index).toBe(2)
    expect(brief!.count).toBe(3)
    expect(brief!.url).toBe('https://b.test/')
    expect(brief!.loading).toBe(false)
    expect(brief!.loadingMs).toBeNull()
    expect(brief!.slowLoad).toBe(false)
  })

  it('accepts an explicit tab id and falls back to the active tab', () => {
    const m = makeManager()
    addTab(m, 'tab-1', 'https://a.test/')
    addTab(m, 'tab-2', 'https://b.test/')
    ;(m as any).activeId = 'tab-1'

    expect(m.tabBrief('tab-2')!.id).toBe('tab-2')
    // Unknown id → active tab, never a wrong tab.
    expect(m.tabBrief('tab-nope')!.id).toBe('tab-1')
    expect(m.tabBrief(null)!.id).toBe('tab-1')
  })

  it('surfaces how long a still-loading tab has been loading', () => {
    const m = makeManager()
    const startedAt = Date.now() - 1200
    addTab(m, 'tab-1', 'https://slow.test/', { loading: true, loadingStartedAt: startedAt })

    const brief = m.tabBrief('tab-1')!
    expect(brief.loading).toBe(true)
    expect(brief.loadingMs).toBeGreaterThanOrEqual(1000)
    expect(brief.slowLoad).toBe(false) // under the threshold
  })

  it('flags slowLoad once a load runs past the threshold', () => {
    const m = makeManager()
    const startedAt = Date.now() - (SLOW_LOAD_THRESHOLD_MS + 500)
    addTab(m, 'tab-1', 'https://stuck.test/', { loading: true, loadingStartedAt: startedAt })

    const brief = m.tabBrief('tab-1')!
    expect(brief.loading).toBe(true)
    expect(brief.slowLoad).toBe(true)
    expect(brief.loadingMs).toBeGreaterThanOrEqual(SLOW_LOAD_THRESHOLD_MS)
  })

  it('reports no load timing when the tab is idle even if a stale start stamp lingers', () => {
    const m = makeManager()
    // loading=false but a stale loadingStartedAt: timing must key off isLoading().
    addTab(m, 'tab-1', 'https://a.test/', { loading: false, loadingStartedAt: Date.now() - 9000 })

    const brief = m.tabBrief('tab-1')!
    expect(brief.loading).toBe(false)
    expect(brief.loadingMs).toBeNull()
    expect(brief.slowLoad).toBe(false)
  })

  it('returns null when there is no usable tab', () => {
    const m = makeManager()
    expect(m.tabBrief()).toBeNull()
  })
})
