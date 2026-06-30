import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { ensureNavigableUrl, navigateTo, normalizeAddress } from './navigation'

class FakeWebContents extends EventEmitter {
  currentUrl = ''
  readonly navigationHistory = {
    goBack: () => undefined,
    goForward: () => undefined
  }

  isLoading(): boolean {
    return false
  }

  loadURL(url: string): Promise<void> {
    this.currentUrl = url
    this.emit('did-start-loading')
    this.emit('dom-ready')
    this.emit('did-stop-loading')
    return Promise.resolve()
  }

  reload(): void {}
}

describe('navigateTo', () => {
  it('arms navigation settlement before loadURL fires synchronous events', async () => {
    const wc = new FakeWebContents()

    await expect(
      navigateTo(wc as any, 'https://example.com/feed', { wait: true, timeoutMs: 50 })
    ).resolves.toBeUndefined()
    expect(wc.currentUrl).toBe('https://example.com/feed')
  })

  it('rejects non-URL input by default so a tool call cannot leak into the DDG SERP', async () => {
    const wc = new FakeWebContents()
    await expect(
      navigateTo(wc as any, 'cursor docs', { wait: false })
    ).rejects.toThrow(/not a navigable http\(s\) URL/i)
    expect(wc.currentUrl).toBe('')
  })

  it('rejects non-http schemes by default (file:, javascript:, etc.)', async () => {
    const wc = new FakeWebContents()
    await expect(
      navigateTo(wc as any, 'file:///etc/passwd', { wait: false })
    ).rejects.toThrow(/not a navigable http\(s\) URL/i)
    await expect(
      navigateTo(wc as any, 'javascript:alert(1)', { wait: false })
    ).rejects.toThrow(/not a navigable http\(s\) URL/i)
    expect(wc.currentUrl).toBe('')
  })

  it('still allows about:blank by default (programmatic blank-tab init)', async () => {
    const wc = new FakeWebContents()
    await expect(
      navigateTo(wc as any, 'about:blank', { wait: false })
    ).resolves.toBeUndefined()
    expect(wc.currentUrl).toBe('about:blank')
  })

  it('smartAddressBarInput opt-in rewrites bare words to a DDG SERP (URL-bar behavior)', async () => {
    const wc = new FakeWebContents()
    await navigateTo(wc as any, 'cursor docs', { wait: false, smartAddressBarInput: true })
    expect(wc.currentUrl).toBe('https://duckduckgo.com/?q=cursor%20docs')
  })

  it('smartAddressBarInput opt-in rewrites a bare hostname to https (URL-bar behavior)', async () => {
    const wc = new FakeWebContents()
    await navigateTo(wc as any, 'example.com', { wait: false, smartAddressBarInput: true })
    expect(wc.currentUrl).toBe('https://example.com')
  })
})

describe('ensureNavigableUrl', () => {
  it('returns http(s) URLs unchanged', () => {
    expect(ensureNavigableUrl('https://example.com/foo')).toBe('https://example.com/foo')
    expect(ensureNavigableUrl('http://example.com')).toBe('http://example.com/')
  })

  it('accepts about:blank verbatim', () => {
    expect(ensureNavigableUrl('about:blank')).toBe('about:blank')
  })

  it('throws on bare words / search-style input', () => {
    expect(() => ensureNavigableUrl('cursor docs')).toThrow()
    expect(() => ensureNavigableUrl('openai gpt-5 release notes')).toThrow()
    expect(() => ensureNavigableUrl('')).toThrow()
  })

  it('throws on bare hostnames (no scheme) so the SERP fallback cannot apply', () => {
    expect(() => ensureNavigableUrl('example.com')).toThrow()
  })

  it('throws on non-http schemes', () => {
    expect(() => ensureNavigableUrl('javascript:alert(1)')).toThrow()
    expect(() => ensureNavigableUrl('file:///etc/passwd')).toThrow()
    expect(() => ensureNavigableUrl('ftp://example.com')).toThrow()
  })
})

describe('normalizeAddress (URL-bar smart input only)', () => {
  it('still rewrites bare words to the DDG SERP — this is the URL-bar contract', () => {
    expect(normalizeAddress('cursor docs')).toBe('https://duckduckgo.com/?q=cursor%20docs')
  })

  it('still rewrites bare hostnames to https', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com')
  })

  it('passes through fully-formed URLs', () => {
    expect(normalizeAddress('https://example.com/foo')).toBe('https://example.com/foo')
  })
})
