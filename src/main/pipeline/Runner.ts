import type { PageCapture } from '../../../shared/types'
import type {
  Plan,
  PipelineDeps,
  PlanStep,
  StepEvidence,
  StepResult,
  Trajectory
} from './types'
import { normalizePlanSteps } from './Planner'
import { defaultMaxRetries, describeAction, describeCondition } from './runnerHelpers'
import { executeAction, settleForPostCondition } from './runnerActions'
import { checkCondition, type NetworkIdleSource } from './runnerConditions'
import { captureEvidence } from './runnerEvidence'

/** Re-plan callback: given the live capture + the failed step, produce a fresh
 *  tail of steps to splice in. This is the ONLY place the LLM enters the loop. */
export type ReplanFn = (
  capture: PageCapture,
  failed: PlanStep,
  remaining: PlanStep[]
) => Promise<PlanStep[]>

export type PipelineProgressStatus =
  | 'planned'
  | 'running'
  | 'passed'
  | 'failed'
  | 'replanned'
  | 'aborted'
  | 'skipped'

export interface PipelineProgressEvent {
  /** Stable sequence number from the execution plan. */
  step: number
  /** Total steps if known at emit time. */
  total?: number
  title: string
  status: PipelineProgressStatus
  detail?: string
}

const MAX_TOTAL_REPLANS = 1

/**
 * Deterministic execution engine. Plan-once, execute-blind, verify-with-CDP.
 *
 * Invariant: the happy path costs ZERO LLM calls. We only call `replan` when
 * a post-condition genuinely fails and the step's policy is 'replan'. Every
 * verification (URL / element / text / network-idle) is a deterministic CDP
 * read — see `runnerConditions.ts`. Trusted-input click/type/navigate
 * primitives live in `runnerActions.ts`. Evidence capture (the snapshot we
 * persist to the trajectory) lives in `runnerEvidence.ts`.
 */
export class Runner {
  /** Live count of in-flight network requests, maintained from CDP events the
   *  CDPSession already pumps. Lets networkIdle be deterministic, not a sleep. */
  private inFlightCount = 0
  private activeTabId: string | null = null
  private readonly network: NetworkIdleSource = {
    inFlight: () => this.inFlightCount
  }

  constructor(
    private readonly deps: PipelineDeps,
    private readonly onLog?: (msg: string) => void,
    private readonly onProgress?: (event: PipelineProgressEvent) => void
  ) {}

  get runningTabId(): string | null {
    return this.activeTabId
  }

  /** Feed this every CDP event (from TabManager's onCdpEvent fan-out) so the
   *  Runner can track network settle deterministically. Cheap + optional —
   *  networkIdle degrades to a bounded wait if not wired. */
  onCdpEvent(tabId: string, method: string): void {
    if (!this.activeTabId || tabId !== this.activeTabId) return
    if (method === 'Network.requestWillBeSent') this.inFlightCount++
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1)
    }
  }

  async run(tabId: string, plan: Plan, replan?: ReplanFn): Promise<Trajectory> {
    this.activeTabId = tabId
    try {
      const startedAt = Date.now()
      const results: StepResult[] = []
      let llmCalls = 1 // the initial planner call that produced `plan`
      let checks = 0
      let success = true
      let totalReplans = 0
      const evidenceUrls = new Set<string>()
      let preActionNetwork: Trajectory['preActionNetwork'] = null
      let shouldCheckPendingNetworkCapture = typeof this.deps.runWithPendingNetworkCapture === 'function'

      type QueuedStep = { stepNo: number; step: PlanStep }
      // Mutable queue so replans can splice a fresh tail in front of remainder.
      const queue: QueuedStep[] = plan.steps.map((step, index) => ({ stepNo: index + 1, step }))
      let nextStepNo = queue.length + 1

      while (queue.length > 0) {
        const item = queue.shift()!
        const step = item.step
        const stepNo = item.stepNo
        const title = (step.intent || describeAction(step.action)).slice(0, 140)
        const sStart = Date.now()
        const maxRetries = step.maxRetries ?? defaultMaxRetries(step)
        const maxAttempts = maxRetries + 1
        const actionLabel = describeAction(step.action)
        let usedLlm = false
        let status: StepResult['status'] = 'passed'
        let error: string | undefined
        let evidence: StepEvidence | undefined
        let localChecks = 0
        let attempts = 0

        this.onProgress?.({
          step: stepNo,
          title,
          status: 'running',
          detail: `Preparing step: ${actionLabel}`
        })
        this.onLog?.(`➡️ [Runner] Executing step: ${step.action.type} ${actionLabel}`)

        if (step.preCondition) {
          localChecks++
          this.onProgress?.({
            step: stepNo,
            title,
            status: 'running',
            detail: `Checking pre-condition: ${describeCondition(step.preCondition)}`
          })
          const pre = await checkCondition(this.deps, tabId, step.preCondition, this.network)
          if (!pre.ok) {
            error = `precondition failed: ${pre.reason}`
            this.onProgress?.({ step: stepNo, title, status: 'failed', detail: `Pre-condition failed: ${pre.reason}` })
            this.onLog?.(`⚠️ [Runner] Pre-condition check failed: ${pre.reason}`)
          } else {
            this.onProgress?.({
              step: stepNo,
              title,
              status: 'running',
              detail: `Pre-condition passed: ${describeCondition(step.preCondition)}`
            })
            this.onLog?.(`✅ [Runner] Pre-condition check passed.`)
          }
        }

        // Normalise postCondition: if the LLM omitted it, treat as 'always'
        // so we never crash with "Cannot read properties of undefined".
        const postCond = step.postCondition ?? { kind: 'always' as const }

        let passed = !error
        if (!error) {
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            attempts = attempt + 1
            this.onProgress?.({
              step: stepNo,
              title,
              status: 'running',
              detail: `Attempt ${attempts}/${maxAttempts}: ${actionLabel}`
            })
            if (attempt > 0) {
              this.onLog?.(`🔄 [Runner] Retrying step (attempt ${attempt}/${maxRetries})...`)
              this.onProgress?.({
                step: stepNo,
                title,
                status: 'running',
                detail: `Retry ${attempt}/${maxRetries}`
              })
            }
            try {
              if (shouldCheckPendingNetworkCapture && this.deps.runWithPendingNetworkCapture) {
                const wrapped = await this.deps.runWithPendingNetworkCapture(tabId, async () => {
                  await executeAction(this.deps, tabId, step.action, this.onLog)
                  await settleForPostCondition(this.deps, tabId, step.action, postCond)
                })
                preActionNetwork = wrapped.network
                shouldCheckPendingNetworkCapture = false
              } else {
                await executeAction(this.deps, tabId, step.action, this.onLog)
                await settleForPostCondition(this.deps, tabId, step.action, postCond)
              }
            } catch (e: any) {
              error = `action threw: ${e?.message ?? e}`
              passed = false
              this.onLog?.(`❌ [Runner] Action failed: ${error}`)
              break
            }
            localChecks++
            let post: { ok: boolean; reason: string }
            try {
              this.onProgress?.({
                step: stepNo,
                title,
                status: 'running',
                detail: `Validating: ${describeCondition(postCond)}`
              })
              post = await checkCondition(this.deps, tabId, postCond, this.network)
            } catch (e: any) {
              post = { ok: false, reason: `post-check failed: ${e?.message ?? e}` }
            }
            if (post.ok) {
              passed = true
              error = undefined
              status = attempt === 0 ? 'passed' : 'retried-pass'
              this.onProgress?.({
                step: stepNo,
                title,
                status: 'running',
                detail:
                  attempt === 0
                    ? `Passed on attempt ${attempts}/${maxAttempts}: ${describeCondition(postCond)}`
                    : `Passed after ${attempts}/${maxAttempts} retries: ${describeCondition(postCond)}`
              })
              this.onLog?.(`✅ [Runner] Post-condition check passed.`)
              break
            }
            passed = false
            error = `postcondition not met: ${post.reason}`
            if (attempt < maxRetries) {
              this.onProgress?.({
                step: stepNo,
                title,
                status: 'running',
                detail: `Attempt ${attempts}/${maxAttempts} failed (${post.reason}), retrying...`
              })
            } else {
              this.onProgress?.({
                step: stepNo,
                title,
                status: 'running',
                detail: `Attempt ${attempts}/${maxAttempts} failed (${post.reason}).`
              })
            }
            this.onLog?.(`⚠️ [Runner] Post-condition check failed: ${post.reason}`)
          }
        }

        if (!passed) {
          const policy = step.onFail ?? 'replan'
          this.onLog?.(`🚨 [Runner] Step failed verification. Policy is "${policy}".`)
          if (policy === 'abort' || !replan) {
            status = 'aborted'
            success = false
            checks += localChecks
            results.push(this.result(step, status, localChecks, usedLlm, error, sStart))
            this.onLog?.(`🛑 [Runner] Aborting run.`)
            this.onProgress?.({
              step: stepNo,
              title,
              status: 'aborted',
              detail: error ?? `Aborted after ${attempts} attempt(s).`
            })
            break
          }
          if (totalReplans >= MAX_TOTAL_REPLANS) {
            this.onLog?.(`🛑 [Runner] Max replans (${MAX_TOTAL_REPLANS}) reached — aborting.`)
            status = 'aborted'
            success = false
            checks += localChecks
            results.push(this.result(step, status, localChecks, usedLlm, error, sStart, evidence))
            this.onProgress?.({
              step: stepNo,
              title,
              status: 'aborted',
              detail: error ?? `Max replans (${MAX_TOTAL_REPLANS}) reached.`
            })
            break
          }
          this.onProgress?.({
            step: stepNo,
            title,
            status: 'running',
            detail: `Post-condition failed. Re-planning (${totalReplans + 1}/${MAX_TOTAL_REPLANS + 1}).`
          })
          this.onLog?.(`🧠 [Runner] Querying LLM for a RE-PLAN...`)
          const capture = await this.deps.capture(tabId)
          const fresh = await replan(capture, step, queue.map((entry) => entry.step))
          llmCalls++
          usedLlm = true
          totalReplans++
          status = 'replanned'
          // Drop structurally malformed steps so a stray replan doesn't crash
          // the runner (e.g. an action with no target).
          const validFresh = normalizePlanSteps(fresh, { requireAtLeastOne: false })
          if (validFresh.length === 0) {
            this.onLog?.('⚠️ [Runner] Re-plan did not yield any usable step(s). Aborting run.')
            status = 'aborted'
            success = false
            checks += localChecks
            results.push(
              this.result(step, status, localChecks, usedLlm, 're-plan produced no usable steps', sStart, evidence)
            )
            this.onProgress?.({ step: stepNo, title, status: 'aborted', detail: 'Re-plan produced no usable steps.' })
            break
          }
          if (validFresh.length !== fresh.length) {
            this.onLog?.(`⚠️ [Runner] Dropped ${fresh.length - validFresh.length} malformed step(s) from replan.`)
          }

          const freshQueued = validFresh.map((freshStep, idx) => ({
            stepNo: nextStepNo + idx,
            step: freshStep
          }))
          const plannedTotal = freshQueued[freshQueued.length - 1].stepNo
          nextStepNo += freshQueued.length
          for (const freshStep of freshQueued) {
            this.onProgress?.({
              step: freshStep.stepNo,
              title: (freshStep.step.intent || describeAction(freshStep.step.action)).slice(0, 140),
              status: 'planned',
              detail: `Added by re-plan: ${describeAction(freshStep.step.action)}`,
              total: plannedTotal
            })
          }
          queue.unshift(...freshQueued)
          error = undefined
          status = 'replanned'
          this.onProgress?.({
            step: stepNo,
            title,
            status: 'replanned',
            detail: `Replanned with ${freshQueued.length} step(s).`
          })
          this.onLog?.(`📝 [Runner] RE-PLAN completed. Spliced in ${validFresh.length} new step(s).`)
        } else {
          evidence = await captureEvidence(this.deps, tabId, step, postCond, evidenceUrls, this.onLog)
        }

        checks += localChecks
        results.push(this.result(step, status, localChecks, usedLlm, error, sStart, evidence))
        const finalStatus: PipelineProgressEvent['status'] =
          status === 'passed' || status === 'retried-pass'
            ? 'passed'
            : status === 'replanned'
              ? 'replanned'
              : status === 'aborted'
                ? 'aborted'
                : status === 'skipped'
                  ? 'skipped'
                  : 'failed'
        const detail = error
          ? error
          : finalStatus === 'passed' && status === 'retried-pass'
            ? `Passed after ${attempts}/${maxAttempts} attempt(s).`
            : finalStatus === 'passed'
              ? `Passed on first attempt (${attempts || 1}/${maxAttempts}).`
              : undefined
        this.onProgress?.({
          step: stepNo,
          title,
          status: finalStatus,
          detail,
          total: nextStepNo - 1
        })
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
        preActionNetwork,
        finalPlan: { ...plan, steps: results.map((r) => r.step) }
      }
    } finally {
      this.activeTabId = null
      this.inFlightCount = 0
    }
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
