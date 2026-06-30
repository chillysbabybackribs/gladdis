import type { PageCapture } from '../../../shared/types'
import type {
  CapturedNetworkBody,
  CapturedNetworkRequest,
  NetworkFilterSpec
} from '../network/watchNetworkRecorder'

/**
 * Deterministic browser-interaction pipeline — type contract.
 *
 * Design thesis (see issue anthropics/claude-code#64194 for the failure mode
 * this prevents): front-load the reasoning into ONE planner LLM call, then
 * execute deterministically. The LLM is the *escape hatch*, never the engine.
 * Any step whose outcome CDP can verify on its own (URL, element presence,
 * network-idle, text) MUST cost zero LLM calls. We only re-invoke the model
 * when a deterministic post-condition fails.
 */

/** How to locate the element a step acts on. Resolved at execution time so a
 *  re-render between plan and act doesn't strand us on a stale handle.
 *  Default strategy: try `selector` first, fall back to AX `role` + `name`. */
export interface Target {
  /** Stable CSS selector (from ActionNode.selector). Preferred. */
  selector?: string
  /** AX role, e.g. "button", "link", "textbox". Fallback locator. */
  role?: string
  /** Accessible name to match (case-insensitive, trimmed). Fallback locator. */
  name?: string
}

/** A single deterministic action primitive. Maps 1:1 onto the trusted-input
 *  CDP calls already in BrowserTools (dispatchMouseEvent / insertText /
 *  dispatchKeyEvent / Page.navigate). */
export type Action =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: Target }
  | { type: 'type'; target: Target; value: string }
  | { type: 'press'; key: string }
  | { type: 'scrollIntoView'; target: Target }

/** A deterministic, CDP-checkable assertion. NONE of these may cost an LLM
 *  call — that is the whole point of the pipeline. */
export type Condition =
  | { kind: 'urlMatches'; pattern: string }            // RegExp against current URL
  | { kind: 'elementExists'; target: Target }          // resolvable + present
  | { kind: 'elementGone'; selector: string }          // no longer in DOM
  | { kind: 'textPresent'; text: string }              // substring of page text
  | { kind: 'networkIdle'; ms: number }                // no in-flight requests for ms
  | { kind: 'always' }                                 // no-op (fire-and-forget step)

/** What to do when a step's post-condition fails to hold. */
type FailPolicy = 'replan' | 'retry' | 'abort'

/** The unit of work the old pipeline lacked: an action + the deterministic
 *  proof it worked + what to do if that proof fails. */
export interface PlanStep {
  /** Human-readable rationale (also what we log / show the user). */
  intent: string
  action: Action
  /** Must hold before we attempt the action (skip/replan if not). */
  preCondition?: Condition
  /** Deterministic proof the action achieved its intent. */
  postCondition: Condition
  /** Escalation policy on post-condition failure. Default 'replan'. */
  onFail?: FailPolicy
  /** Max deterministic retries before honoring onFail. Default 1. */
  maxRetries?: number
}

/** A full plan: the educated guess emitted by ONE planner call from the
 *  landing-page capture + the task. */
export interface Plan {
  task: string
  /** The site/context string fed to the planner (origin or description). */
  site: string
  steps: PlanStep[]
  /** Capture the plan was generated from (for trajectory provenance). */
  basedOnUrl: string
}

/** Per-step execution outcome. */
export interface StepResult {
  step: PlanStep
  status: 'passed' | 'replanned' | 'retried-pass' | 'aborted' | 'skipped'
  /** How many times the deterministic check was evaluated. */
  checks: number
  /** True if this step triggered an LLM re-plan (the expensive path). */
  usedLlm: boolean
  /** Small deterministic page snapshot captured after meaningful successful steps. */
  evidence?: StepEvidence
  error?: string
  startedAt: number
  tookMs: number
}

/** Token-bounded evidence kept for final synthesis. */
export interface StepEvidence {
  url: string
  title: string
  contentTitle?: string
  wordCount?: number
  text: string
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; href: string }>
}

export interface PipelineNetworkCaptureResult {
  captured: CapturedNetworkRequest[]
  totalSeen: number
  bodies: CapturedNetworkBody[]
  filter?: NetworkFilterSpec
}

/** A frozen, replayable record of one end-to-end run. On a clean run this is
 *  the artifact that lets the SAME task on the SAME site run pure-deterministic
 *  next time, with zero planner calls until something breaks. */
export interface Trajectory {
  task: string
  site: string
  startedAt: number
  tookMs: number
  /** Total LLM calls used across planning + re-planning. The headline cost. */
  llmCalls: number
  /** Total deterministic CDP verifications (these are ~free). */
  deterministicChecks: number
  success: boolean
  steps: StepResult[]
  /** Optional one-shot network capture armed before the first real action. */
  preActionNetwork?: PipelineNetworkCaptureResult | null
  /** The final plan actually executed (may differ from initial after replans). */
  finalPlan: Plan
}

/** Minimal surface the Runner needs from the host app — kept narrow so the
 *  pipeline is testable in isolation and can't reach into the agent loop. */
export interface PipelineDeps {
  /** Universal CDP call — TabManager.cdpSend. */
  cdpSend(tabId: string, method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Deterministic perception — PageExtractor.run. */
  capture(tabId: string): Promise<PageCapture>
  /** Optional one-shot capture armed before the next browser-driving action. */
  runWithPendingNetworkCapture?<T>(
    tabId: string,
    action: () => Promise<T> | T
  ): Promise<{ value: T; network: PipelineNetworkCaptureResult | null }>
}
