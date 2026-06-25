import type { ActionNode } from '../../../shared/types'
import type { Condition, PipelineDeps, Target } from './types'
import { describe, sleep, stableSelector } from './runnerHelpers'

export interface NetworkIdleSource {
  /** Live in-flight request count, surfaced from CDP `Network.*` events. */
  inFlight(): number
}

/**
 * Deterministic post-condition check. Each branch is a CDP read against the
 * live page — no LLM in the loop. Returns `{ ok, reason }` so the runner can
 * surface meaningful detail when escalating to retry / replan.
 */
export async function checkCondition(
  deps: PipelineDeps,
  tabId: string,
  c: Condition,
  network: NetworkIdleSource
): Promise<{ ok: boolean; reason: string }> {
  try {
    switch (c.kind) {
      case 'always':
        return { ok: true, reason: 'always' }
      case 'urlMatches': {
        let pattern: RegExp
        try {
          pattern = new RegExp(c.pattern)
        } catch {
          return { ok: false, reason: `invalid url pattern: ${c.pattern}` }
        }
        const url = await currentUrl(deps, tabId)
        const ok = !!url && pattern.test(url)
        return { ok, reason: ok ? '' : `url "${url ?? '(unavailable)'}" !~ /${c.pattern}/` }
      }
      case 'elementExists': {
        const node = await resolveTarget(deps, tabId, c.target)
        return { ok: !!node, reason: node ? '' : `not found: ${describe(c.target)}` }
      }
      case 'elementGone': {
        const res = (await deps.cdpSend(tabId, 'Runtime.evaluate', {
          expression: `!document.querySelector(${JSON.stringify(c.selector)})`,
          returnByValue: true
        })) as { result?: { value?: boolean } }
        const ok = res.result?.value === true
        return { ok, reason: ok ? '' : `still present: ${c.selector}` }
      }
      case 'textPresent': {
        const target = c.text?.trim()
        if (!target) return { ok: false, reason: 'empty text check' }
        const res = (await deps.cdpSend(tabId, 'Runtime.evaluate', {
          expression:
            `(document.body?.innerText ?? '').toLowerCase().includes(${JSON.stringify(target.toLowerCase())})`,
          returnByValue: true
        })) as { result?: { value?: boolean } }
        const ok = res.result?.value === true
        return { ok, reason: ok ? '' : `text not found: "${target}"` }
      }
      case 'networkIdle': {
        const idle = await waitNetworkIdle(network, c.ms ?? 500)
        return { ok: idle, reason: idle ? '' : 'network still active' }
      }
    }
    return { ok: false, reason: `unknown condition: ${(c as { kind: string }).kind}` }
  } catch (e: any) {
    return { ok: false, reason: `check failed: ${e?.message ?? e}` }
  }
}

/**
 * Resolve a Target → live ActionNode.
 *
 * Order matters and is intentional:
 *   1. Stable selector via direct CSS lookup (cheap and usually enough for
 *      planned actions emitted from an earlier capture).
 *   2. Stable selector against the captured AX/action tree (covers nodes whose
 *      useful role/name data is richer than DOM attributes).
 *   3. role+name match (handles dynamic / shadow content where selectors
 *      change between captures).
 *   4. Brittle selector — only as a last resort, since positional CSS goes
 *      stale fast.
 */
export async function resolveTarget(
  deps: PipelineDeps,
  tabId: string,
  t: Target
): Promise<ActionNode | null> {
  let capActions: ActionNode[] | null = null
  const actions = async (): Promise<ActionNode[]> => {
    if (capActions) return capActions
    const cap = await deps.capture(tabId)
    capActions = cap.actions ?? []
    return capActions
  }
  if (t.selector) {
    const stable = stableSelector(t.selector)
    if (stable) {
      const byCss = await resolveByCss(deps, tabId, stable)
      if (byCss) return byCss
      const bySel = (await actions()).find((a) => a.selector === stable)
      if (bySel) return bySel
    }
  }
  if (t.role || t.name) {
    const acts = await actions()
    const wantRole = t.role?.toLowerCase()
    const wantName = t.name?.trim().toLowerCase()
    const byRole = acts.find(
      (a) =>
        (!wantRole || a.role.toLowerCase() === wantRole) &&
        (!wantName || (a.name ?? '').trim().toLowerCase() === wantName || (a.name ?? '').trim().toLowerCase().includes(wantName))
    )
    if (byRole) return byRole

    const fuzzyName = wantName ? acts.find((a) => (a.name ?? '').trim().toLowerCase().includes(wantName)) : undefined
    if (fuzzyName) return fuzzyName

    if (wantRole) {
      const firstByRole = acts.find((a) => (a.role ?? '').toLowerCase() === wantRole)
      if (firstByRole) return firstByRole
    }
  }

  if (t.selector) {
    const acts = await actions()
    const bySel = acts.find((a) => a.selector === t.selector)
    if (bySel) return bySel
  }
  return null
}

async function currentUrl(deps: PipelineDeps, tabId: string): Promise<string | null> {
  const res = (await deps.cdpSend(tabId, 'Runtime.evaluate', {
    expression: `location.href`,
    returnByValue: true
  })) as { result?: { value?: string } }
  return typeof res.result?.value === 'string' ? res.result.value : null
}

async function resolveByCss(
  deps: PipelineDeps,
  tabId: string,
  selector: string
): Promise<ActionNode | null> {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    const tag = (el.tagName || '').toLowerCase();
    const explicitRole = el.getAttribute('role');
    const role = explicitRole || (
      tag === 'a' ? 'link' :
      tag === 'button' ? 'button' :
      tag === 'input' || tag === 'textarea' ? 'textbox' :
      tag === 'select' ? 'combobox' :
      tag || 'generic'
    );
    const name =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : '') ||
      (el.textContent || '').trim();
    const value =
      el instanceof HTMLAnchorElement ? el.href :
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.value || el.placeholder || '') :
      undefined;
    return {
      idx: -1,
      role,
      name: String(name || '').slice(0, 300),
      tag,
      value: value ? String(value).slice(0, 500) : undefined,
      selector: ${JSON.stringify(selector)},
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      inViewport: r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
    };
  })()`
  const res = (await deps.cdpSend(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true
  })) as { result?: { value?: ActionNode | null } }
  return res.result?.value ?? null
}

/**
 * Resolve when in-flight hits 0 (from CDP events) or after an 8s ceiling so
 * a hung socket can't wedge the run. We always honour a 300ms minimum quiet
 * window so DOM has time to settle after a navigate, even if `inFlight` is
 * already 0 because Network events aren't being forwarded.
 */
export async function waitNetworkIdle(
  network: NetworkIdleSource,
  quietMs: number
): Promise<boolean> {
  const ceiling = Date.now() + 8000
  const effectiveQuiet = Math.max(quietMs, 300)
  let quietSince = network.inFlight() === 0 ? Date.now() : 0
  while (Date.now() < ceiling) {
    if (network.inFlight() === 0) {
      if (!quietSince) quietSince = Date.now()
      if (Date.now() - quietSince >= effectiveQuiet) return true
    } else {
      quietSince = 0
    }
    await sleep(50)
  }
  return network.inFlight() === 0
}
