import type { Runner } from './Runner'

/**
 * Registry of pipeline Runners currently driving the browser, so CDP events
 * (Network.*) can be forwarded to each for deterministic networkIdle.
 *
 * Replaces a single `(global as any).activeRunner` slot — which assumed exactly
 * one browser-driving turn at a time and got clobbered when two ran at once
 * (e.g. one chat drawer running /pipeline while another does). A Runner only
 * counts requests for its own tab, so broadcasting every CDP event to every
 * registered Runner is harmless: a cross-tab event just nudges a counter that
 * settles on the same ceiling either way.
 */
const runners = new Set<Runner>()

export function registerRunner(runner: Runner): void {
  runners.add(runner)
}

export function unregisterRunner(runner: Runner): void {
  runners.delete(runner)
}

/** Forward a CDP event method to every live Runner. Never throws. */
export function broadcastCdpEvent(method: string): void {
  for (const runner of runners) {
    try {
      runner.onCdpEvent(method)
    } catch (err) {
      console.error('[pipeline] failed to forward CDP event to a runner:', err)
    }
  }
}
