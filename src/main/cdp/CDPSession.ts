import { WebContents } from 'electron'
import type { CdpEventPayload } from '../../../shared/types'

/**
 * Owns the Chrome DevTools Protocol debugger session for a single tab's
 * WebContents. Keep the attach quiet: Page is enabled only so init scripts can
 * register before navigation; Runtime.evaluate and Accessibility.getFullAXTree
 * work on demand without pre-enabling Runtime/Network/DOM. This mirrors the
 * Browser2 posture that reduced bot-protection friction.
 */
export class CDPSession {
  private attached = false
  private attachPromise: Promise<void> | null = null

  constructor(
    private readonly wc: WebContents,
    private readonly tabId: string,
    private readonly onEvent: (e: CdpEventPayload) => void,
    /**
     * Page-world scripts to register via Page.addScriptToEvaluateOnNewDocument
     * as part of attach — run after Page.enable (so the call isn't racing domain
     * enablement) and before any other domain, so they're present for the first
     * document. Used for browser polish plus stealth/anti-detection patches.
     */
    private readonly initScripts: string[] = []
  ) {}

  async attach(): Promise<void> {
    if (this.attached) return
    if (this.attachPromise) return this.attachPromise

    this.attachPromise = this._doAttach().finally(() => {
      this.attachPromise = null
    })
    return this.attachPromise
  }

  private async _doAttach(): Promise<void> {
    try {
      this.wc.debugger.attach('1.3')
    } catch (err) {
      console.error(`[cdp ${this.tabId}] attach failed:`, err)
      return
    }
    this.attached = true

    this.wc.debugger.on('message', (_event, method, params) => {
      this.onEvent({ tabId: this.tabId, method, params })
    })

    this.wc.debugger.on('detach', (_event, reason) => {
      this.attached = false
      this.attachPromise = null
      console.warn(`[cdp ${this.tabId}] detached:`, reason)
    })

    await this.enableSequence()
  }

  private async enableSequence(): Promise<void> {
    const enable = async (method: string, params?: Record<string, unknown>): Promise<void> => {
      try {
        await this.send(method, params)
      } catch (e) {
        console.warn(`[cdp ${this.tabId}] enable ${method} failed:`, (e as Error)?.message ?? e)
      }
    }

    await enable('Page.enable')
    for (const source of this.initScripts) {
      // Register for every document (persists across navigations). This reliably
      // patches every page the tab ever loads going forward.
      try {
        await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
      } catch (e) {
        console.warn(`[cdp ${this.tabId}] init script failed:`, (e as Error)?.message ?? e)
      }
    }
  }

  /** Fire any CDP command. This is the universal escape hatch for models. */
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.attached) {
      await this.attach()
    }
    return this.wc.debugger.sendCommand(method, params)
  }

  detach(): void {
    if (!this.attached) return
    try {
      this.wc.debugger.detach()
    } catch {
      /* already gone */
    }
    this.attached = false
    this.attachPromise = null
  }
}
