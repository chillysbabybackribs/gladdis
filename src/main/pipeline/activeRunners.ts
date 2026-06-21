import type { Runner } from './Runner'
import type { CdpEventPayload } from '../../../shared/types'

/**
 * Registry of pipeline Runners currently driving the browser, so CDP events
 * (Network.*) can be forwarded to the matching tab runner for deterministic
 * networkIdle.
 *
 * Replaces a single `(global as any).activeRunner` slot — which assumed exactly
 * one browser-driving turn at a time and got clobbered when two ran at once
 * (e.g. one chat drawer running /pipeline while another does). A Runner only
 * counts requests for its own tab, so only the active tab runner receives events.
 */
const runners = new Set<Runner>()

export function registerRunner(runner: Runner): void {
  runners.add(runner)
}

export function unregisterRunner(runner: Runner): void {
  runners.delete(runner)
}

/** Forward a CDP event to every matching live Runner. Never throws. */
export function broadcastCdpEvent(event: CdpEventPayload): void {
  for (const runner of runners) {
    if (runner.runningTabId !== event.tabId) continue
    try {
      runner.onCdpEvent(event.tabId, event.method)
    } catch (err) {
      console.error('[pipeline] failed to forward CDP event to a runner:', err)
    }
  }
}
