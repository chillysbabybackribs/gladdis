import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PageCapture } from '../../../shared/types'
import { Planner, normalizePlanSteps, type LlmComplete } from './Planner'
import { Runner, type PipelineProgressEvent, type ReplanFn } from './Runner'
import type { PipelineDeps, Plan, PlanStep, Trajectory } from './types'

const MAX_REPLAN_ACTIONS = 30
const MAX_REPLAN_REMAINING_STEPS = 6
const MAX_REPLAN_STEPS = 8
const MAX_REPLAN_OUTPUT_TOKENS = 1_200

/**
 * Standalone test harness for the deterministic browser pipeline.
 *
 * This is intentionally NOT wired into ChatService or the chat UI yet. It exists
 * so we can run ONE real task on ONE real site and measure the headline numbers
 * — LLM calls, deterministic checks, step count, success — against the old
 * pre-CDP pipeline. Falsifiable, isolated, and fully reversible: delete
 * src/main/pipeline/ and nothing else changes.
 *
 * Wiring (done by the host once, e.g. in index.ts behind a dev flag):
 *   const deps  = { cdpSend: tabs.cdpSend.bind(tabs),
 *                   capture: (id) => extractor.run(id) }
 *   const llm   = makeAnthropicComplete(chatService)   // see note below
 *   const traj  = await orchestrate({ tabId, task, deps, llm })
 *
 * The Runner's networkIdle is deterministic only if it's fed CDP events. If the
 * host has an onCdpEvent fan-out (TabManager does), forward Network.* methods to
 * `runner.onCdpEvent(tabId, method)`; otherwise networkIdle degrades to a bounded
 * wait.
 */

export interface OrchestrateOpts {
  tabId: string
  task: string
  /** Optional human site/context label; defaults to the page origin. */
  site?: string
  deps: PipelineDeps
  /** One non-streaming text completion (host wires to its model client). */
  llm: LlmComplete
  /** Where to drop the trajectory JSON. Defaults to ./pipeline-runs. */
  outDir?: string
  /** Register the runner so the host can forward CDP events to it (for
   *  deterministic networkIdle). Called synchronously before the run starts. */
  onRunnerReady?: (runner: Runner) => void
  /** Real-time callback to stream log lines back to the host/user. */
  onLog?: (msg: string) => void
  /** Real-time callback for step-by-step progress updates. */
  onProgress?: (event: PipelineProgressEvent) => void
}

/** The replan path: re-perceive live state, ask the model for a fresh tail.
 *  Mirrors the planner's contract but is scoped to "what now, from HERE". */
function makeReplan(llm: LlmComplete): ReplanFn {
  return async (capture: PageCapture, failed: PlanStep, remaining: PlanStep[]) => {
    const system = [
      'You are the RE-PLAN stage of a deterministic browser pipeline. A step just',
      'failed its deterministic post-condition. Given the LIVE page snapshot, the',
      'failed step, and the steps that were still queued, emit a corrected tail of',
      'steps (same JSON shapes as the planner) to reach the goal from HERE.',
      '',
      'RULES:',
      '- Every "type" action MUST include a concrete non-empty "value" string.',
      '  If you do not know what the user wants to type, omit the type step entirely.',
      '- Only use post-conditions you can genuinely verify. If nothing is verifiable,',
      '  use { "kind": "always" }.',
      '- Do NOT hallucinate selectors. Use only selectors from the `actions` list.',
      '',
      'Output a single JSON object: { "steps": [ ... ] }. No prose, no markdown.'
    ].join('\n')
    const user = JSON.stringify(
      {
        liveUrl: capture.url,
        liveTitle: capture.content?.title ?? '',
        failedStep: compactStep(failed),
        stillQueued: remaining.slice(0, MAX_REPLAN_REMAINING_STEPS).map(compactStep),
        stillQueuedCount: remaining.length,
        actions: (capture.actions ?? []).slice(0, MAX_REPLAN_ACTIONS).map((a) => ({
          selector: a.selector,
          role: a.role,
          name: (a.name ?? '').slice(0, 80),
          value: a.value ? a.value.slice(0, 140) : undefined,
          inViewport: a.inViewport,
          disabled: a.disabled
        }))
      },
      null,
      0
    )
  const raw = await llm(system, user, {
    stage: 'pipeline:replan',
    maxOutputTokens: MAX_REPLAN_OUTPUT_TOKENS
  })
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return [] // give up cleanly → step aborts upstream
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(obj.steps)) return []
    return normalizePlanSteps(obj.steps as unknown[], {
      requireAtLeastOne: false,
      maxSteps: MAX_REPLAN_STEPS
    })
  } catch {
    return []
  }
}

function compactStep(step: PlanStep): Pick<PlanStep, 'intent' | 'action' | 'postCondition' | 'onFail'> {
  return {
    intent: step.intent.slice(0, 160),
    action: step.action,
    postCondition: step.postCondition,
    ...(step.onFail ? { onFail: step.onFail } : {})
  }
}
}

export async function orchestrate(opts: OrchestrateOpts): Promise<Trajectory> {
  const {
    tabId,
    task,
    site,
    deps,
    llm,
    outDir = 'pipeline-runs',
    onRunnerReady,
    onLog,
    onProgress
  } = opts

  onLog?.(`🎬 [Pipeline] Starting task: "${task}"`)

  // 1. Perceive the landing page (deterministic, free of the model).
  onLog?.(`🔍 [Pipeline] Perceiving the landing page snapshot...`)
  const landing = await deps.capture(tabId)

  // 2. Plan — the single up-front model call.
  onLog?.(`🧠 [Pipeline] Querying LLM to generate the interaction plan...`)
  const planner = new Planner(llm)
  const plan: Plan = await planner.plan(task, landing, site)
  onLog?.(`📝 [Pipeline] Plan generated with ${plan.steps.length} step(s).`)
  onProgress?.({
    step: 0,
    total: Math.max(plan.steps.length, 1),
    title: 'Plan ready',
    status: 'planned',
    detail: `Generated ${plan.steps.length} step(s): "${task}".`
  })
  for (const step of plan.steps.entries()) {
    onProgress?.({
      step: step[0] + 1,
      total: plan.steps.length,
      title: step[1].intent.slice(0, 140),
      status: 'planned',
      detail: `Planned: ${step[1].intent.slice(0, 120)}`
    })
  }

  // 3. Execute deterministically; the model only re-enters on a failed check.
  const runner = new Runner(deps, onLog, onProgress)
  onRunnerReady?.(runner)
  const trajectory = await runner.run(tabId, plan, makeReplan(llm))

  // 4. Freeze the trajectory + headline metrics to disk for measurement.
  await persist(trajectory, outDir)
  logSummary(trajectory)

  const passed = trajectory.steps.filter((s) => s.status === 'passed' || s.status === 'retried-pass').length
  const replanned = trajectory.steps.filter((s) => s.usedLlm).length
  onLog?.(`🏁 [Pipeline] Finished. Success: ${trajectory.success}. Steps: ${trajectory.steps.length}, Passed: ${passed}, Replans: ${replanned}, LLM Calls: ${trajectory.llmCalls}, CDP Checks: ${trajectory.deterministicChecks}.`)

  return trajectory
}

async function persist(traj: Trajectory, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const slug = traj.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '')
  const file = join(outDir, `${Date.now()}-${slug || 'run'}.json`)
  await writeFile(file, JSON.stringify(traj, null, 2), 'utf8')
}

function logSummary(t: Trajectory): void {
  const passed = t.steps.filter((s) => s.status === 'passed' || s.status === 'retried-pass').length
  const replanned = t.steps.filter((s) => s.usedLlm).length
  // The headline: did the deterministic engine carry the run, or did the model?
  console.log(
    `[pipeline] task=${JSON.stringify(t.task)} success=${t.success} ` +
      `steps=${t.steps.length} passed=${passed} replans=${replanned} ` +
      `llmCalls=${t.llmCalls} detChecks=${t.deterministicChecks} ms=${t.tookMs}`
  )
}
