import type { Action, Condition, PipelineDeps, Target } from './types'
import { describe, sleep } from './runnerHelpers'
import { resolveTarget } from './runnerConditions'

/**
 * Execute one Action against the active tab using trusted-input CDP calls.
 * Mirrors BrowserTools' click/type/navigate/scroll primitives so the runner
 * uses the exact same dispatch the LLM-driven path uses (no JS-shimmed
 * `click()` calls that anti-bot guards trip on).
 */
export async function executeAction(
  deps: PipelineDeps,
  tabId: string,
  action: Action,
  onLog?: (msg: string) => void
): Promise<void> {
  if (!action || !action.type) throw new Error('execute: action is missing or has no type')

  switch (action.type) {
    case 'navigate': {
      if (!action.url) throw new Error('navigate action is missing url')
      await deps.cdpSend(tabId, 'Page.navigate', { url: action.url })
      await waitForLoad(deps, tabId)
      return
    }
    case 'press':
      await pressKey(deps, tabId, action.key)
      return
    case 'click': {
      if (!action.target) throw new Error('click action is missing target')
      const node = await resolveTarget(deps, tabId, action.target)
      if (!node) throw new Error(`click target not found: ${describe(action.target)}`)
      await dispatchClick(deps, tabId, node.rect.x + node.rect.w / 2, node.rect.y + node.rect.h / 2)
      return
    }
    case 'scrollIntoView': {
      if (!action.target) throw new Error('scrollIntoView action is missing target')
      const node = await resolveTarget(deps, tabId, action.target)
      if (!node) {
        onLog?.(`⚠️ [Runner] scroll target not found: ${describe(action.target)} (best effort skip)`)
        return
      }
      await deps.cdpSend(tabId, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(node.selector)})?.scrollIntoView({block:'center'})`
      })
      return
    }
    case 'type': {
      if (!action.target) throw new Error('type action is missing target')
      const node = await resolveTarget(deps, tabId, action.target)
      if (!node) throw new Error(`type target not found: ${describe(action.target)}`)
      const text = action.value != null && action.value !== 'undefined' ? action.value : ''
      if (!text) throw new Error(`type action has no value for target: ${describe(action.target)}`)
      await dispatchClick(deps, tabId, node.rect.x + node.rect.w / 2, node.rect.y + node.rect.h / 2)
      await deps.cdpSend(tabId, 'Input.insertText', { text })
      return
    }
    default:
      throw new Error(`execute: unknown action type "${(action as any).type}"`)
  }
}

export async function dispatchClick(
  deps: PipelineDeps,
  tabId: string,
  x: number,
  y: number
): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await deps.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await deps.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await deps.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

async function pressKey(deps: PipelineDeps, tabId: string, key: string): Promise<void> {
  // Best-effort key event. The canonical KEY_MAP lives in BrowserTools — we
  // intentionally don't duplicate it; wire deps.pressKey through for richer keys.
  await deps.cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key })
  await deps.cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key })
}

/**
 * Click/press handlers can race the post-condition check: the URL hasn't
 * changed yet by the time we re-perceive. Wait for the expected URL pattern
 * (when the post-condition is `urlMatches`), or sleep briefly for other
 * verifications, before we let `check()` run.
 */
export async function settleForPostCondition(
  deps: PipelineDeps,
  tabId: string,
  action: Action,
  postCond: Condition
): Promise<void> {
  if ((action.type === 'click' || action.type === 'press') && postCond.kind === 'urlMatches') {
    const matched = await waitForUrlMatch(deps, tabId, postCond.pattern, 2_500)
    if (matched) await waitForLoad(deps, tabId, 1_500)
    return
  }
  if ((action.type === 'click' || action.type === 'press' || action.type === 'type') && postCond.kind !== 'always') {
    await sleep(150)
  }
}

export async function waitForLoad(
  deps: PipelineDeps,
  tabId: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = (await deps.cdpSend(tabId, 'Runtime.evaluate', {
      expression: `document.readyState`,
      returnByValue: true
    })) as { result?: { value?: string } }
    if (res?.result?.value === 'complete' || res?.result?.value === 'interactive') return
    await sleep(100)
  }
}

async function waitForUrlMatch(
  deps: PipelineDeps,
  tabId: string,
  patternText: string,
  timeoutMs: number
): Promise<boolean> {
  let pattern: RegExp
  try {
    pattern = new RegExp(patternText)
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = await currentUrl(deps, tabId)
    if (url && pattern.test(url)) return true
    await sleep(50)
  }
  return false
}

async function currentUrl(deps: PipelineDeps, tabId: string): Promise<string | null> {
  try {
    const res = (await deps.cdpSend(tabId, 'Runtime.evaluate', {
      expression: `location.href`,
      returnByValue: true
    })) as { result?: { value?: string } }
    return typeof res.result?.value === 'string' ? res.result.value : null
  } catch {
    return null
  }
}

// Re-export Target so consumers don't need to reach into types directly.
export type { Target }
