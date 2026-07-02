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
  private readonly targetSessionIds = new Map<string, string>()

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

    this.wc.debugger.on('message', (_event, method, params, sessionId) => {
      this.trackTargetSessionEvent(method, params, sessionId)
      this.onEvent({ tabId: this.tabId, method, params, sessionId: sessionId || undefined })
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
    await enable('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
    await this.primeIframeTargets()
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
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.attached) {
      await this.attach()
    }
    return this.wc.debugger.sendCommand(method, params, sessionId)
  }

  sessionIdForTarget(targetId: string): string | null {
    return this.targetSessionIds.get(targetId) ?? null
  }

  private async primeIframeTargets(): Promise<void> {
    type TargetListing = { targetInfos?: Array<{ targetId?: string; type?: string; attached?: boolean }> }
    let targets: TargetListing | null = null
    try {
      targets = (await this.send('Target.getTargets', {})) as TargetListing
    } catch {
      return
    }
    for (const info of targets?.targetInfos ?? []) {
      if (info.type !== 'iframe' || !info.targetId || info.attached) continue
      try {
        const attached = (await this.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true
        })) as { sessionId?: string }
        if (attached.sessionId) this.targetSessionIds.set(info.targetId, attached.sessionId)
      } catch {
        /* best effort */
      }
    }
  }

  private trackTargetSessionEvent(method: string, params: any, sessionId?: string): void {
    if (method === 'Target.attachedToTarget') {
      const targetId = typeof params?.targetInfo?.targetId === 'string' ? params.targetInfo.targetId : null
      const targetType = typeof params?.targetInfo?.type === 'string' ? params.targetInfo.type : null
      const childSessionId = typeof params?.sessionId === 'string' ? params.sessionId : sessionId
      if (targetId && targetType === 'iframe' && childSessionId) {
        this.targetSessionIds.set(targetId, childSessionId)
      }
      return
    }
    if (method === 'Target.detachedFromTarget') {
      const detachedSessionId = typeof params?.sessionId === 'string' ? params.sessionId : sessionId
      if (!detachedSessionId) return
      for (const [targetId, mappedSessionId] of this.targetSessionIds.entries()) {
        if (mappedSessionId === detachedSessionId) {
          this.targetSessionIds.delete(targetId)
          break
        }
      }
    }
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
    this.targetSessionIds.clear()
  }
}
