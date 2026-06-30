import type { PageCapture, ActionNode } from '../../../shared/types'
import type { Action, Condition, Plan, PlanStep, Target } from './types'

/**
 * The Planner — the ONE expensive call in the whole pipeline.
 *
 * STATUS (see root CLAUDE.md): "the whole pipeline" here means THIS deterministic
 * pipeline, which is NOT the app's main browser-automation path (that is the
 * agentic perceive/drive tool loop) and is reached by only one live caller,
 * taskTools.orchestrate. Its future is undecided. Note also: a dozen core files
 * import `LlmComplete` from this file — that is a TYPE import only; importing it
 * does NOT mean they use the pipeline.
 *
 * It mirrors the old (pre-CDP) pipeline's thesis: feed a model the richest
 * possible landing-page snapshot + the task + the site, and have it emit the
 * full step plan up front as an educated guess. The difference now is the
 * input quality — `PageCapture` is Chromium's own semantic view (AX tree +
 * stable selectors + bounding boxes), not scraped HTML — so the guess is far
 * less of a guess. After this call the Runner executes deterministically and
 * only ever comes back to the model when a CDP post-condition actually fails.
 */

/** Narrow LLM dependency: one non-streaming text completion. The host wires
 *  this to ChatService's existing anthropic()/google() clients. Keeping it this
 *  thin means the pipeline never imports the agent loop and stays unit-testable
 *  with a stub completion. */
export interface LlmCompleteOptions {
  /** Stage label for logging/adapter-specific budgeting. */
  stage?: string
  /** Provider output cap for this call. Input prompt size is controlled by callers. */
  maxOutputTokens?: number
  /** Optional conversation key for provider-side prompt caching or routing. */
  conversationId?: string | null
}

export type LlmComplete = (system: string, user: string, options?: LlmCompleteOptions) => Promise<string>

const PLANNER_SYSTEM = [
  'You are the planning stage of a DETERMINISTIC browser-automation pipeline.',
  'You get ONE call. From the page snapshot + the task, emit the COMPLETE plan',
  'of steps up front. After you, a deterministic runner executes each step and',
  'verifies it with the Chrome DevTools Protocol — with ZERO further model calls',
  'unless a step\'s post-condition fails. So your job is to be thorough and',
  'specific now, not to leave gaps for "figure it out later".',
  '',
  'Each step needs: an `intent` (one short human sentence), an `action`, and a',
  '`postCondition` — a DETERMINISTIC, CDP-checkable proof the action worked.',
  '',
  'ACTIONS (use exactly these shapes):',
  '  { "type": "navigate", "url": "https://..." }',
  '  { "type": "click",  "target": <Target> }',
  '  { "type": "type",   "target": <Target>, "value": "..." }',
  '  { "type": "press",  "key": "Enter" }            // also Tab, Escape, ArrowDown...',
  '  { "type": "scrollIntoView", "target": <Target> }',
  '',
  'TARGET — how to locate an element. Prefer the exact `selector` from the',
  'snapshot\'s actions list; you MAY also give role+name as a fallback:',
  '  { "selector": "...", "role": "button", "name": "Add to cart" }',
  'Prefer selectors that are stable across layout changes. Avoid positional selectors',
  'containing nth-child/nth-of-type chains and deep >-based index paths.',
  '',
  'POST-CONDITIONS (use exactly these shapes — all are checked without a model):',
  '  { "kind": "urlMatches", "pattern": "/checkout" }   // RegExp against the URL',
  '  { "kind": "elementExists", "target": <Target> }',
  '  { "kind": "elementGone", "selector": "..." }',
  '  { "kind": "textPresent", "text": "Order confirmed" }',
  '  { "kind": "networkIdle", "ms": 500 }',
  '  { "kind": "always" }                               // only if nothing is verifiable',
  '',
  'Optional per step: "onFail": "replan" | "retry" | "abort" (default "replan"),',
  'and "maxRetries": <int> (default 1).',
  '',
  'Choose post-conditions that genuinely PROVE the step worked.',
  '• A `navigate` action MUST use `urlMatches` — never `networkIdle` — because',
  '  the runner already waits for the page load event before checking anything.',
  '• A form submit that lands on a new page should assert the URL or a confirmation text.',
  '• A simple click that may or may not trigger navigation should use',
  '  { "kind": "always" } — do NOT use urlMatches for a button click unless you',
  '  are certain the click will always produce a navigation to a predictable URL.',
  '• Reserve `networkIdle` only for AJAX-heavy interactions (search-as-you-type,',
  '  infinite scroll, SPA route transitions that do not change the URL).',
  '',
  'OUTPUT: a single JSON object, no prose, no markdown fence:',
  '  { "steps": [ { "intent": "...", "action": {...}, "postCondition": {...} }, ... ] }'
].join('\n')

/** Cap how much of the action surface we send so the planner prompt stays lean
 *  (cost discipline). The most useful actions are the visible, enabled,
 *  interactive ones; we send those first. */
const MAX_ACTIONS_IN_PROMPT = 40
const MAX_PLAN_ACTION_VALUE = 200
const MAX_ACTION_RETRIES = 3
const MAX_INTENT_LENGTH = 200
const MAX_PLAN_STEPS = 24
const MAX_PLANNER_OUTPUT_TOKENS = 2_500
const MAX_ACTION_VALUE_IN_PROMPT = 140

const POSITIONAL_SELECTOR_RE =
  /(:nth-(?:child|of-type)|:first-(?:child|of-type)|:last-(?:child|of-type)|\[[0-9]+\]|>[^>]*>[^>]*>)/i

export interface PlanSanitizationOptions {
  requireAtLeastOne?: boolean
  maxSteps?: number
}

/** Trim the capture to the planner-relevant essentials, as compact JSON. */
function describeCapture(cap: PageCapture): string {
  const acts = rankActions(cap.actions ?? []).map((a) => ({
    selector: a.selector,
      role: a.role,
      name: (a.name ?? '').slice(0, 80),
      value: a.value ? a.value.slice(0, MAX_ACTION_VALUE_IN_PROMPT) : undefined,
      inViewport: a.inViewport,
      disabled: a.disabled
    }))
  return JSON.stringify(
    {
      url: cap.url,
      title: cap.content?.title ?? '',
      summary: (cap.content?.text ?? '').slice(0, 900),
      actions: acts
    },
    null,
    0
  )
}

/** Extract the first plan-shaped JSON value from a model reply (tolerates an
 *  accidental ```json fence, a bare steps array, or leading prose). */
export function parsePlanJson(raw: string): { steps: unknown[] } {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const direct = parsePlanJsonValue(text)
  if (direct) return direct

  const extracted = extractFirstJsonValue(text)
  if (!extracted) throw new Error('planner returned no JSON object')
  const parsed = parsePlanJsonValue(extracted)
  if (!parsed) throw new Error('planner JSON missing steps[]')
  return parsed
}

function parsePlanJsonValue(text: string): { steps: unknown[] } | null {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(obj)) return { steps: obj }
  const record = obj && typeof obj === 'object' ? obj as Record<string, unknown> : null
  if (!record || !Array.isArray(record.steps)) throw new Error('planner JSON missing steps[]')
  return { steps: record.steps }
}

function extractFirstJsonValue(text: string): string | null {
  const start = findJsonStart(text)
  if (start === -1) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

function findJsonStart(text: string): number {
  const objStart = text.indexOf('{')
  const arrayStart = text.indexOf('[')
  if (objStart === -1) return arrayStart
  if (arrayStart === -1) return objStart
  return Math.min(objStart, arrayStart)
}

/** Make the model output structurally safe before execution. */
export function normalizePlanSteps(
  rawSteps: unknown[],
  { requireAtLeastOne = true, maxSteps = Number.POSITIVE_INFINITY }: PlanSanitizationOptions = {}
): PlanStep[] {
  const normalized: PlanStep[] = []
  for (const step of rawSteps) {
    if (normalized.length >= maxSteps) break
    const parsed = sanitizePlanStep(step)
    if (parsed) normalized.push(parsed)
  }
  if (normalized.length === 0 && requireAtLeastOne) {
    throw new Error('planner returned no valid executable steps')
  }
  return normalized
}

function sanitizePlanStep(rawStep: unknown): PlanStep | null {
  if (!rawStep || typeof rawStep !== 'object') return null
  const step = rawStep as Record<string, unknown>

  const action = sanitizeAction(step['action'])
  if (!action) return null

  const postCondition = sanitizeCondition(step['postCondition']) ?? { kind: 'always' as const }
  const preCondition = step['preCondition'] ? sanitizeCondition(step['preCondition']) : undefined
  const onFail = normalizeFailPolicy(step['onFail'])
  const maxRetries = normalizeMaxRetries(step['maxRetries'])
  const rawIntent = typeof step['intent'] === 'string' ? step['intent'].trim() : ''

  return {
    intent: rawIntent ? rawIntent.slice(0, MAX_INTENT_LENGTH) : 'Execute interaction step',
    action,
    postCondition,
    ...(preCondition ? { preCondition } : {}),
    ...(onFail ? { onFail } : {}),
    ...(maxRetries ? { maxRetries } : {})
  }
}

function sanitizeAction(rawAction: unknown): Action | null {
  if (!rawAction || typeof rawAction !== 'object') return null
  const action = rawAction as Record<string, unknown>
  const type = typeof action['type'] === 'string' ? action['type'] : ''

  if (type === 'navigate') {
    const url = typeof action['url'] === 'string' ? action['url'].trim() : ''
    if (!url) return null
    return { type: 'navigate', url }
  }

  if (type === 'press') {
    const key = typeof action['key'] === 'string' ? action['key'].trim() : ''
    if (!key) return null
    return { type: 'press', key }
  }

  if (type === 'click' || type === 'scrollIntoView' || type === 'type') {
    const target = sanitizeTarget(action['target'])
    if (!target) return null
    if (type === 'click') return { type: 'click', target }
    if (type === 'scrollIntoView') return { type: 'scrollIntoView', target }

    const value = typeof action['value'] === 'string' ? action['value'].trim() : ''
    if (!value) return null
    return { type: 'type', target, value: value.slice(0, MAX_PLAN_ACTION_VALUE) }
  }

  return null
}

function sanitizeTarget(rawTarget: unknown): Target | null {
  if (!rawTarget || typeof rawTarget !== 'object') return null
  const target = rawTarget as Record<string, unknown>

  const role = typeof target['role'] === 'string' ? target['role'].trim() : undefined
  const name = typeof target['name'] === 'string' ? target['name'].trim() : undefined
  let selector = typeof target['selector'] === 'string' ? target['selector'].trim() : undefined

  if (selector && isPositionalSelector(selector)) {
    if (role || name) selector = undefined
  }

  if (!selector && !role && !name) return null
  return {
    selector,
    role: role || undefined,
    name: name || undefined
  }
}

function sanitizeCondition(rawCondition: unknown): Condition | null {
  if (!rawCondition || typeof rawCondition !== 'object') return null
  const condition = rawCondition as Record<string, unknown>
  const kind = typeof condition['kind'] === 'string' ? condition['kind'] : ''

  if (kind === 'urlMatches') {
    const pattern = typeof condition['pattern'] === 'string' ? condition['pattern'].trim() : ''
    if (!pattern) return null
    return { kind: 'urlMatches', pattern }
  }

  if (kind === 'elementExists') {
    const target = sanitizeTarget(condition['target'])
    if (!target) return null
    return { kind: 'elementExists', target }
  }

  if (kind === 'elementGone') {
    const selector = typeof condition['selector'] === 'string' ? condition['selector'].trim() : ''
    if (!selector) return null
    return { kind: 'elementGone', selector }
  }

  if (kind === 'textPresent') {
    const text = typeof condition['text'] === 'string' ? condition['text'].trim() : ''
    if (!text) return null
    return { kind: 'textPresent', text }
  }

  if (kind === 'networkIdle') {
    const ms = normalizeMs(condition['ms'])
    if (!ms) return null
    return { kind: 'networkIdle', ms }
  }

  if (kind === 'always') return { kind: 'always' }

  return null
}

function normalizeFailPolicy(rawPolicy: unknown): PlanStep['onFail'] | undefined {
  if (!rawPolicy || typeof rawPolicy !== 'string') return undefined
  if (rawPolicy === 'abort' || rawPolicy === 'retry' || rawPolicy === 'replan') return rawPolicy
  return undefined
}

function normalizeMaxRetries(rawRetries: unknown): number | undefined {
  if (typeof rawRetries !== 'number' || !Number.isFinite(rawRetries)) return undefined
  const retries = Math.round(rawRetries)
  if (retries < 1) return undefined
  if (retries > MAX_ACTION_RETRIES) return MAX_ACTION_RETRIES
  return retries
}

function normalizeMs(rawMs: unknown): number | null {
  if (typeof rawMs !== 'number' || !Number.isFinite(rawMs)) return null
  const ms = Math.round(rawMs)
  if (ms <= 0) return null
  return ms
}

export function isPositionalSelector(selector: string): boolean {
  return POSITIONAL_SELECTOR_RE.test(selector) || selector.startsWith('/') || selector.startsWith('//')
}

/** Cap how much of the action surface we send to model so the prompt stays lean
 * and cheap. */
function rankActions(actions: ActionNode[]): ActionNode[] {
  return [...actions]
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_ACTIONS_IN_PROMPT)
}

function score(a: ActionNode): number {
  let s = 0
  if (a.inViewport) s += 3
  if (!a.disabled) s += 2
  if (a.name?.trim()) s += 1
  if (/(button|link|textbox|combobox|checkbox|searchbox)/i.test(a.role)) s += 1
  return s
}

export class Planner {
  constructor(private readonly complete: LlmComplete) {}

  /** Produce the full plan from a landing-page capture + the task. */
  async plan(task: string, capture: PageCapture, site?: string): Promise<Plan> {
    const user = [
      `TASK: ${task}`,
      `SITE: ${site ?? safeOrigin(capture.url)}`,
      '',
      'PAGE SNAPSHOT (JSON):',
      describeCapture(capture)
    ].join('\n')

    const raw = await this.complete(PLANNER_SYSTEM, user, {
      stage: 'pipeline:planner',
      maxOutputTokens: MAX_PLANNER_OUTPUT_TOKENS
    })
    const { steps } = parsePlanJson(raw)
    const sanitized = normalizePlanSteps(steps, { requireAtLeastOne: true, maxSteps: MAX_PLAN_STEPS })

    return {
      task,
      site: site ?? safeOrigin(capture.url),
      steps: sanitized,
      basedOnUrl: capture.url
    }
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}
