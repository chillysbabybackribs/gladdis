import type { Action, Condition, PlanStep, Target } from './types'
import { isPositionalSelector } from './Planner'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

export function describe(t: Target | undefined): string {
  if (!t) return '(unknown target)'
  return t.selector ?? `${t.role ?? '?'}:"${t.name ?? ''}"`
}

export function describeCondition(condition: Condition): string {
  if (condition.kind === 'always') return 'no verification condition'
  if (condition.kind === 'urlMatches') return `URL matches /${condition.pattern}/`
  if (condition.kind === 'elementExists')
    return `element exists: ${condition.target ? describe(condition.target) : '(unknown)'}`
  if (condition.kind === 'elementGone') return `element gone: ${condition.selector}`
  if (condition.kind === 'textPresent') return `text present: “${condition.text}”`
  if (condition.kind === 'networkIdle') return `network idle for ${condition.ms}ms`
  return `condition ${(condition as { kind: string }).kind}`
}

export function describeAction(a: Action | undefined): string {
  if (!a) return '(undefined action)'
  if (a.type === 'navigate') return `to "${a.url ?? '(no url)'}"`
  if (a.type === 'press') return `key "${a.key ?? '(no key)'}"`
  if (a.type === 'click') return `on ${describe((a as any).target)}`
  if (a.type === 'scrollIntoView') return `target ${describe((a as any).target)}`
  if (a.type === 'type') return `"${(a as any).value}" into ${describe((a as any).target)}`
  return ''
}

/**
 * Drop brittle structural / position-based selectors so we never end up
 * pinning a click on `:nth-child(3) > div > a:first-of-type`. Stable
 * selectors (id, attr, class) come back unchanged; everything that flunks
 * the `isPositionalSelector` test returns null and the caller falls back to
 * AX role+name resolution.
 */
export function stableSelector(selector: string): string | null {
  const trimmed = selector.trim()
  if (!trimmed) return null
  if (isPositionalSelector(trimmed)) return null
  return trimmed
}

/**
 * Steps that did real navigation or assertively confirmed a URL/text deserve
 * an evidence snapshot for the trajectory. Click/scrollIntoView do not — we
 * only persist evidence when something user-visible actually changed.
 */
export function shouldCaptureEvidence(step: PlanStep, postCond: Condition): boolean {
  return (
    step.action.type === 'navigate' ||
    postCond.kind === 'urlMatches' ||
    (postCond.kind === 'textPresent' && step.action.type !== 'scrollIntoView')
  )
}

/**
 * Steps that wait on a navigation post-condition aren't worth retrying —
 * either the URL changed or it didn't. Everything else gets one retry by
 * default to absorb transient layout shifts.
 */
export function defaultMaxRetries(step: PlanStep): number {
  if (
    step.action.type === 'navigate' ||
    ((step.action.type === 'press' || step.action.type === 'click') && step.postCondition.kind === 'urlMatches')
  ) {
    return 0
  }
  return 1
}
