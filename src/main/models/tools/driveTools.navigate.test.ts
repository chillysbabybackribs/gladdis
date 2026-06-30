import { describe, expect, it, vi } from 'vitest'

import { runNavigate } from './driveTools'

function makeDeps(overrides?: { takeArmedNetworkCapture?: () => null | object }) {
  const navigate = vi.fn(async () => undefined)
  const navigateWithNetworkCapture = vi.fn(async () => ({
    totalSeen: 0,
    captured: [],
    bodies: [],
    filter: undefined
  }))
  const executeJavaScript = vi.fn(async () => ({ success: true, result: 0 }))
  const takeArmedNetworkCapture = vi.fn(() => null) as any
  const tabs = {
    navigate,
    navigateWithNetworkCapture,
    executeJavaScript,
    takeArmedNetworkCapture: overrides?.takeArmedNetworkCapture ?? takeArmedNetworkCapture
  }
  return { deps: { tabs } as any, navigate, navigateWithNetworkCapture }
}

describe('runNavigate (visible-tab SERP-leak regression)', () => {
  it('rejects a non-URL "query" string instead of letting the URL-bar SERP fallback load DuckDuckGo into the visible tab', async () => {
    const { deps, navigate, navigateWithNetworkCapture } = makeDeps()

    const out = await runNavigate(deps, { url: 'cursor docs' }, { tabId: 'tab-1' })

    expect(out.ok).toBe(false)
    expect(out.text).toMatch(/not an http\(s\) URL/i)
    expect(out.text).toMatch(/use search\(\) if you meant to look it up/i)
    expect(navigate).not.toHaveBeenCalled()
    expect(navigateWithNetworkCapture).not.toHaveBeenCalled()
  })

  it('rejects a bare hostname (no scheme) because TabManager.navigate would otherwise rewrite it', async () => {
    const { deps, navigate } = makeDeps()

    const out = await runNavigate(deps, { url: 'example.com' }, { tabId: 'tab-1' })

    expect(out.ok).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rejects non-http schemes (file:, javascript:, ftp:)', async () => {
    const { deps, navigate } = makeDeps()

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com']) {
      const out = await runNavigate(deps, { url }, { tabId: 'tab-1' })
      expect(out.ok).toBe(false)
    }
    expect(navigate).not.toHaveBeenCalled()
  })

  it('forwards a valid http(s) URL through TabManager.navigate untouched (parsed canonical form)', async () => {
    const { deps, navigate } = makeDeps()

    const out = await runNavigate(deps, { url: 'https://example.com/foo' }, { tabId: 'tab-1' })

    expect(out.ok).toBe(true)
    expect(navigate).toHaveBeenCalledWith('tab-1', 'https://example.com/foo', expect.any(Object))
    expect(out.text).toContain('https://example.com/foo')
    expect((out.structuredContent as any).url).toBe('https://example.com/foo')
  })

  it('returns a usable error (not throw) when url is empty', async () => {
    const { deps, navigate } = makeDeps()

    const out = await runNavigate(deps, { url: '' }, { tabId: 'tab-1' })

    expect(out.ok).toBe(false)
    expect(out.text).toMatch(/"url" is required/)
    expect(navigate).not.toHaveBeenCalled()
  })
})
