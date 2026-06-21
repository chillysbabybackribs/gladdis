import type { ActionNode, PageCapture } from '../../../shared/types'
import type {
  Action,
  Condition,
  Plan,
  PipelineDeps,
  PlanStep,
  StepEvidence,
  StepResult,
  Target,
  Trajectory
} from './types'
import { normalizePlanSteps, isPositionalSelector } from './Planner'

/** Re-plan callback: given the live capture + the failed step, produce a fresh
 *  tail of steps to splice in. This is the ONLY place the LLM enters the loop. */
export type ReplanFn = (
  capture: PageCapture,
  failed: PlanStep,
  remaining: PlanStep[]
) => Promise<PlanStep[]>

const MAX_TOTAL_REPLANS = 1
const EVIDENCE_TEXT_CHARS = 1_200
const EVIDENCE_HEADINGS = 12
const EVIDENCE_LINKS = 12

/**
 * The deterministic execution engine. Plan-once, execute-blind, verify-with-CDP.
 *
 * Invariant: the happy path costs ZERO LLM calls. We only call `replan` when a
 * post-condition genuinely fails and the step's policy is 'replan'. Every
 * verification (URL / element / text / network-idle) is a deterministic CDP read.
 */
export class Runner {
  /** Live count of in-flight network requests, maintained from CDP events the
   *  CDPSession already pumps. Lets networkIdle be deterministic, not a sleep. */
  private inFlight = 0

  constructor(private readonly deps: PipelineDeps, private readonly onLog?: (msg: string) => void) {}

  /** Feed this every CDP event (from TabManager's onCdpEvent fan-out) so the
   *  Runner can track network settle deterministically. Cheap + optional —
   *  networkIdle degrades to a bounded wait if not wired. */
  onCdpEvent(method: string): void {
    if (method === 'Network.requestWillBeSent') this.inFlight++
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.inFlight = Math.max(0, this.inFlight - 1)
    }
  }

  async run(tabId: string, plan: Plan, replan?: ReplanFn): Promise<Trajectory> {
    const startedAt = Date.now()
    const results: StepResult[] = []
    let llmCalls = 1 // the initial planner call that produced `plan`
    let checks = 0
    let success = true
    let totalReplans = 0
    const evidenceUrls = new Set<string>()

    // Work off a mutable queue so replans can splice in a fresh tail.
    const queue: PlanStep[] = [...plan.steps]

    while (queue.length > 0) {
      const step = queue.shift()!
      const sStart = Date.now()
      const maxRetries = step.maxRetries ?? defaultMaxRetries(step)
      let usedLlm = false
      let status: StepResult['status'] = 'passed'
      let error: string | undefined
      let evidence: StepEvidence | undefined
      let localChecks = 0

      this.onLog?.(`➡️ [Runner] Executing step: ${step.action.type} ${describeAction(step.action)}`)

      // Pre-condition gate (deterministic).
      if (step.preCondition) {
        localChecks++
        const pre = await this.check(tabId, step.preCondition)
        if (!pre.ok) {
          // Precondition unmet — treat like a failed step per policy.
          error = `precondition failed: ${pre.reason}`
          this.onLog?.(`⚠️ [Runner] Pre-condition check failed: ${pre.reason}`)
        } else {
          this.onLog?.(`✅ [Runner] Pre-condition check passed.`)
        }
      }

      // Normalise postCondition: if the LLM omitted it, treat as 'always' so we
      // never crash with "Cannot read properties of undefined (reading 'ok')".
      const postCond = step.postCondition ?? { kind: 'always' as const }

      // Attempt + verify, with deterministic retries. If the pre-condition
      // already failed above, `error` is set and we skip straight to escalation.
      let passed = !error
      if (!error) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            this.onLog?.(`🔄 [Runner] Retrying step (attempt ${attempt}/${maxRetries})...`)
          }
          try {
            await this.execute(tabId, step.action)
            await this.settleForPostCondition(tabId, step.action, postCond)
          } catch (e: any) {
            error = `action threw: ${e?.message ?? e}`
            passed = false
            this.onLog?.(`❌ [Runner] Action failed: ${error}`)
            break
          }
          localChecks++
          let post: { ok: boolean; reason: string }
          try {
            post = await this.check(tabId, postCond)
          } catch (e: any) {
            post = { ok: false, reason: `post-check failed: ${e?.message ?? e}` }
          }
          if (post.ok) {
            passed = true
            error = undefined
            status = attempt === 0 ? 'passed' : 'retried-pass'
            this.onLog?.(`✅ [Runner] Post-condition check passed.`)
            break
          }
          passed = false
          error = `postcondition not met: ${post.reason}`
          this.onLog?.(`⚠️ [Runner] Post-condition check failed: ${post.reason}`)
        }
      }

      // Escalate on failure per policy.
      if (!passed) {
        const policy = step.onFail ?? 'replan'
        this.onLog?.(`🚨 [Runner] Step failed verification. Policy is "${policy}".`)
        if (policy === 'abort' || !replan) {
          status = 'aborted'
          success = false
          checks += localChecks
          results.push(this.result(step, status, localChecks, usedLlm, error, sStart))
          this.onLog?.(`🛑 [Runner] Aborting run.`)
          break
        }
        if (policy === 'retry') {
          // Already exhausted deterministic retries above → fall through to replan.
        }
        // Replan: the one expensive path. Re-perceive live state, ask the model.
        if (totalReplans >= MAX_TOTAL_REPLANS) {
          this.onLog?.(`🛑 [Runner] Max replans (${MAX_TOTAL_REPLANS}) reached — aborting.`)
          status = 'aborted'
          success = false
          checks += localChecks
          results.push(this.result(step, status, localChecks, usedLlm, error, sStart, evidence))
          break
        }
        this.onLog?.(`🧠 [Runner] Querying LLM for a RE-PLAN...`)
        const capture = await this.deps.capture(tabId)
        const fresh = await replan(capture, step, queue)
        llmCalls++
        usedLlm = true
        totalReplans++
        status = 'replanned'
        // Validate replan steps — drop any that are structurally malformed
        // (e.g. LLM returned a step with no action, or a click with no target).
        const validFresh = normalizePlanSteps(fresh, { requireAtLeastOne: false })
        if (validFresh.length === 0) {
          this.onLog?.('⚠️ [Runner] Re-plan did not yield any usable step(s). Aborting run.')
          status = 'aborted'
          success = false
          checks += localChecks
          results.push(this.result(step, status, localChecks, usedLlm, 're-plan produced no usable steps', sStart, evidence))
          break
        }
        if (validFresh.length !== fresh.length) {
          this.onLog?.(`⚠️ [Runner] Dropped ${fresh.length - validFresh.length} malformed step(s) from replan.`)
        }
        // Splice the fresh tail in front of whatever remained.
        queue.unshift(...validFresh)
        error = undefined
        this.onLog?.(`📝 [Runner] RE-PLAN completed. Spliced in ${validFresh.length} new step(s).`)
      } else {
        evidence = await this.captureEvidence(tabId, step, postCond, evidenceUrls)
      }

      checks += localChecks
      results.push(this.result(step, status, localChecks, usedLlm, error, sStart, evidence))
    }

    return {
      task: plan.task,
      site: plan.site,
      startedAt,
      tookMs: Date.now() - startedAt,
      llmCalls,
      deterministicChecks: checks,
      success,
      steps: results,
      finalPlan: { ...plan, steps: results.map((r) => r.step) }
    }
  }

  // ---- action execution (reuses the exact trusted-input CDP calls) ----

  private async execute(tabId: string, action: Action): Promise<void> {
    // Guard: malformed replan steps may arrive without required fields.
    if (!action || !action.type) throw new Error('execute: action is missing or has no type')

    switch (action.type) {
      case 'navigate': {
        if (!action.url) throw new Error('navigate action is missing url')
        // Use Page.navigate and wait for the load event so post-conditions
        // (especially networkIdle) fire against a fully-loaded page, not a
        // blank interim state.
        await this.deps.cdpSend(tabId, 'Page.navigate', { url: action.url })
        await this.waitForLoad(tabId)
        return
      }
      case 'press':
        await this.pressKey(tabId, action.key)
        return
      case 'click': {
        if (!action.target) throw new Error('click action is missing target')
        const node = await this.resolve(tabId, action.target)
        if (!node) throw new Error(`click target not found: ${describe(action.target)}`)
        await this.dispatchClick(tabId, node.rect.x + node.rect.w / 2, node.rect.y + node.rect.h / 2)
        return
      }
      case 'scrollIntoView': {
        if (!action.target) throw new Error('scrollIntoView action is missing target')
        const node = await this.resolve(tabId, action.target)
        if (!node) {
          this.onLog?.(`⚠️ [Runner] scroll target not found: ${describe(action.target)} (best effort skip)`)
          return
        }
        await this.deps.cdpSend(tabId, 'Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(node.selector)})?.scrollIntoView({block:'center'})`
        })
        return
      }
      case 'type': {
        if (!action.target) throw new Error('type action is missing target')
        const node = await this.resolve(tabId, action.target)
        if (!node) throw new Error(`type target not found: ${describe(action.target)}`)
        // Guard against LLM emitting value: undefined / "undefined".
        const text = action.value != null && action.value !== 'undefined' ? action.value : ''
        if (!text) throw new Error(`type action has no value for target: ${describe(action.target)}`)
        await this.dispatchClick(tabId, node.rect.x + node.rect.w / 2, node.rect.y + node.rect.h / 2)
        await this.deps.cdpSend(tabId, 'Input.insertText', { text })
        return
      }
      default:
        throw new Error(`execute: unknown action type "${(action as any).type}"`)
    }
  }

  // ---- deterministic verification (the ~free path) ----

  private async check(tabId: string, c: Condition): Promise<{ ok: boolean; reason: string }> {
    try {
      switch (c.kind) {
        case 'always':
          return { ok: true, reason: 'always' }
        case 'urlMatches': {
          const cap = await this.deps.capture(tabId)
          let pattern: RegExp
          try {
            pattern = new RegExp(c.pattern)
          } catch {
            return { ok: false, reason: `invalid url pattern: ${c.pattern}` }
          }
          const ok = pattern.test(cap.url)
          return { ok, reason: ok ? '' : `url "${cap.url}" !~ /${c.pattern}/` }
        }
        case 'elementExists': {
          const node = await this.resolve(tabId, c.target)
          return { ok: !!node, reason: node ? '' : `not found: ${describe(c.target)}` }
        }
        case 'elementGone': {
          const res = (await this.deps.cdpSend(tabId, 'Runtime.evaluate', {
            expression: `!document.querySelector(${JSON.stringify(c.selector)})`,
            returnByValue: true
          })) as { result?: { value?: boolean } }
          const ok = res.result?.value === true
          return { ok, reason: ok ? '' : `still present: ${c.selector}` }
        }
        case 'textPresent': {
          const target = c.text?.trim()
          if (!target) return { ok: false, reason: 'empty text check' }
          // Check the live rendered text directly (no full-DOM serialization).
          const res = (await this.deps.cdpSend(tabId, 'Runtime.evaluate', {
            expression:
              `(document.body?.innerText ?? '').toLowerCase().includes(${JSON.stringify(target.toLowerCase())})`,
            returnByValue: true
          })) as { result?: { value?: boolean } }
          const ok = res.result?.value === true
          return { ok, reason: ok ? '' : `text not found: "${target}"` }
        }
        case 'networkIdle': {
          const idle = await this.waitNetworkIdle(c.ms ?? 500)
          return { ok: idle, reason: idle ? '' : 'network still active' }
        }
      }
      return { ok: false, reason: `unknown condition: ${(c as { kind: string }).kind}` }
    } catch (e: any) {
      return { ok: false, reason: `check failed: ${e?.message ?? e}` }
    }
  }

  /** Resolve a Target to a live ActionNode from a fresh capture. selector first,
   *  then AX role+name. Returns null if nothing matches. */
  private async resolve(tabId: string, t: Target): Promise<ActionNode | null> {
    const cap = await this.deps.capture(tabId)
    const acts = cap.actions ?? []

    if (t.selector) {
      const stable = stableSelector(t.selector)
      if (stable) {
        const bySel = acts.find((a) => a.selector === stable)
        if (bySel) return bySel
        const byCss = await this.resolveByCss(tabId, stable)
        if (byCss) return byCss
      }
    }
    if (t.role || t.name) {
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
      // Final fallback: try brittle selector only if nothing else matched.
      const bySel = acts.find((a) => a.selector === t.selector)
      if (bySel) return bySel
    }
    return null
  }

  private async resolveByCss(tabId: string, selector: string): Promise<ActionNode | null> {
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
    const res = (await this.deps.cdpSend(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true
    })) as { result?: { value?: ActionNode | null } }
    return res.result?.value ?? null
  }

  private async captureEvidence(
    tabId: string,
    step: PlanStep,
    postCond: Condition,
    seenUrls: Set<string>
  ): Promise<StepEvidence | undefined> {
    if (!shouldCaptureEvidence(step, postCond)) return undefined
    try {
      const cap = await this.deps.capture(tabId)
      if (!cap.url || seenUrls.has(cap.url)) return undefined
      seenUrls.add(cap.url)
      const text = (cap.content?.markdown || cap.content?.text || '').trim()
      const links: Array<{ text: string; href: string }> = []
      const seenLinks = new Set<string>()
      for (const action of cap.actions ?? []) {
        if (action.role !== 'link' || !action.value || seenLinks.has(action.value)) continue
        seenLinks.add(action.value)
        links.push({
          text: truncate(action.name || action.value, 100),
          href: truncate(action.value, 180)
        })
        if (links.length >= EVIDENCE_LINKS) break
      }
      return {
        url: cap.url,
        title: cap.title,
        contentTitle: cap.content?.title,
        wordCount: cap.content?.wordCount,
        text: truncate(text, EVIDENCE_TEXT_CHARS),
        headings: (cap.content?.headings ?? []).slice(0, EVIDENCE_HEADINGS),
        links
      }
    } catch (e: any) {
      this.onLog?.(`⚠️ [Runner] Evidence capture skipped: ${e?.message ?? e}`)
      return undefined
    }
  }

  /** Deterministic settle: resolve when in-flight hits 0 (from CDP events), or
   *  after a bounded ceiling so a hung socket can't wedge the run.
   *
   *  When CDP Network events aren't forwarded, inFlight stays 0 permanently.
   *  In that case we still honour a brief quiet window before declaring idle,
   *  so the DOM has time to stabilise after a navigate.
   */
  private async waitNetworkIdle(quietMs: number): Promise<boolean> {
    const ceiling = Date.now() + 8000   // generous ceiling for slow pages
    const effectiveQuiet = Math.max(quietMs, 300)  // minimum 300 ms quiet window
    let quietSince = this.inFlight === 0 ? Date.now() : 0
    while (Date.now() < ceiling) {
      if (this.inFlight === 0) {
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince >= effectiveQuiet) return true
      } else {
        quietSince = 0
      }
      await sleep(50)
    }
    // Ceiling reached — treat as idle if there's nothing actively in-flight.
    return this.inFlight === 0
  }

  /** Wait for the page's load event (or a generous timeout) after a navigation,
   *  so post-conditions always run against a settled DOM. Uses Page.loadEventFired
   *  if available, otherwise falls back to polling document.readyState. */
  private async waitForLoad(tabId: string, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = (await this.deps.cdpSend(tabId, 'Runtime.evaluate', {
        expression: `document.readyState`,
        returnByValue: true
      })) as { result?: { value?: string } }
      if (res?.result?.value === 'complete' || res?.result?.value === 'interactive') return
      await sleep(100)
    }
    // Timed out — proceed anyway; the page may be partially loaded.
  }

  private async settleForPostCondition(tabId: string, action: Action, postCond: Condition): Promise<void> {
    if ((action.type === 'click' || action.type === 'press') && postCond.kind === 'urlMatches') {
      const matched = await this.waitForUrlMatch(tabId, postCond.pattern, 2_500)
      if (matched) await this.waitForLoad(tabId, 1_500)
      return
    }
    if ((action.type === 'click' || action.type === 'press' || action.type === 'type') && postCond.kind !== 'always') {
      await sleep(150)
    }
  }

  private async waitForUrlMatch(tabId: string, patternText: string, timeoutMs: number): Promise<boolean> {
    let pattern: RegExp
    try {
      pattern = new RegExp(patternText)
    } catch {
      return false
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const url = await this.currentUrl(tabId)
      if (url && pattern.test(url)) return true
      await sleep(50)
    }
    return false
  }

  private async currentUrl(tabId: string): Promise<string | null> {
    try {
      const res = (await this.deps.cdpSend(tabId, 'Runtime.evaluate', {
        expression: `location.href`,
        returnByValue: true
      })) as { result?: { value?: string } }
      return typeof res.result?.value === 'string' ? res.result.value : null
    } catch {
      return null
    }
  }

  // ---- trusted-input primitives (mirrors BrowserTools) ----

  private async dispatchClick(tabId: string, x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left' as const, clickCount: 1 }
    await this.deps.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.deps.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.deps.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  }

  private async pressKey(tabId: string, key: string): Promise<void> {
    // Delegated semantics: callers pass BrowserTools-style key names. We send a
    // best-effort key event; the canonical KEY_MAP lives in BrowserTools and we
    // intentionally don't duplicate it — wire this through if richer keys needed.
    await this.deps.cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key })
    await this.deps.cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key })
  }

  private result(
    step: PlanStep,
    status: StepResult['status'],
    checks: number,
    usedLlm: boolean,
    error: string | undefined,
    sStart: number,
    evidence?: StepEvidence
  ): StepResult {
    return { step, status, checks, usedLlm, evidence, error, startedAt: sStart, tookMs: Date.now() - sStart }
  }
}

function shouldCaptureEvidence(step: PlanStep, postCond: Condition): boolean {
  return (
    step.action.type === 'navigate' ||
    postCond.kind === 'urlMatches' ||
    (postCond.kind === 'textPresent' && step.action.type !== 'scrollIntoView')
  )
}

function defaultMaxRetries(step: PlanStep): number {
  if (
    step.action.type === 'navigate' ||
    ((step.action.type === 'press' || step.action.type === 'click') && step.postCondition.kind === 'urlMatches')
  ) {
    return 0
  }
  return 1
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function describe(t: Target | undefined): string {
  if (!t) return '(unknown target)'
  return t.selector ?? `${t.role ?? '?'}:"${t.name ?? ''}"`
}

function describeAction(a: Action | undefined): string {
  if (!a) return '(undefined action)'
  if (a.type === 'navigate') return `to "${a.url ?? '(no url)'}"`
  if (a.type === 'press') return `key "${a.key ?? '(no key)'}"`
  if (a.type === 'click') return `on ${describe((a as any).target)}`
  if (a.type === 'scrollIntoView') return `target ${describe((a as any).target)}`
  if (a.type === 'type') return `"${(a as any).value}" into ${describe((a as any).target)}`
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function stableSelector(selector: string): string | null {
  const trimmed = selector.trim()
  if (!trimmed) return null
  if (isPositionalSelector(trimmed)) return null
  return trimmed
}
