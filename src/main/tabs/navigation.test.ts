import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { navigateTo } from './navigation'

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
})
