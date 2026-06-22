import { memo, useMemo, useState, type ReactNode } from 'react'
import type { ContractTrace } from '../../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import type {
  CapabilityActivityPart,
  LoopStatePart,
  Message,
  ProgressStepPart,
  TaskMemoryPart,
  ToolActivity,
  VerificationStatePart
} from './chatTypes'
import { ToolRun } from './chat-parts/ToolRun'

/**
 * Shallow array compare — element references must match. Used by `memo`
 * comparators below so an array prop (`parts`/`steps`/`tools`) rebuilt with
 * the same content (immutable update style: spread + appended new tail)
 * skips re-rendering the heavy children whose internals haven't changed.
 */
function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const STEP_STATUS_LABEL: Record<ProgressStepPart['status'], string> = {
  planned: 'Planned',
  running: 'Running',
  passed: 'Done',
  replanned: 'Replanned',
  failed: 'Failed',
  aborted: 'Aborted',
  skipped: 'Skipped'
}

function summarizeProgressStepStatus(status: ProgressStepPart['status']): string {
  return STEP_STATUS_LABEL[status]
}

/**
 * Markdown is the per-token hot path during streaming: marked.parse +
 * DOMPurify.sanitize re-run the WHOLE accumulated message on every render, and
 * that cost grows with message length. Isolating each text block behind
 * React.memo means a render only re-parses the block whose `text` actually
 * changed — finished messages and unchanged blocks cost ~0 while a new bubble
 * streams in.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

const LOOP_EVENT_LABEL: Record<LoopStatePart['event'], string> = {
  task_started: 'Task started',
  phase_changed: 'Phase changed',
  iteration_started: 'Iteration started',
  iteration_completed: 'Iteration completed',
  checkpoint_created: 'Checkpoint created',
  task_paused: 'Task paused',
  task_blocked: 'Task blocked',
  task_completed: 'Task completed',
  task_aborted: 'Task aborted'
}

const CAPABILITY_EVENT_LABEL: Record<CapabilityActivityPart['event'], string> = {
  capability_requested: 'Requested',
  capability_started: 'Running',
  capability_progress: 'In progress',
  capability_completed: 'Completed',
  capability_failed: 'Failed',
  capability_cache_hit: 'Cache hit'
}

const VERIFICATION_EVENT_LABEL: Record<VerificationStatePart['event'], string> = {
  verification_started: 'Verification started',
  verification_check_started: 'Check started',
  verification_check_finished: 'Check finished',
  verification_passed: 'Verification passed',
  verification_failed: 'Verification failed',
  verification_blocked: 'Verification blocked'
}

const LOOP_PHASE_LABEL: Record<LoopStatePart['phase'], string> = {
  inspect: 'Inspect',
  recon: 'Recon',
  plan: 'Plan',
  act: 'Act',
  validate: 'Validate',
  decide: 'Decide',
  handoff: 'Handoff',
  done: 'Done'
}

/** Activity parts that are collapsed together into one quiet reasoning group. */
type ActivityPart =
  | LoopStatePart
  | CapabilityActivityPart
  | VerificationStatePart
  | TaskMemoryPart

export const ChatMessageBody = memo(function ChatMessageBody({ message }: { message: Message }) {
  if (message.parts && message.parts.length) {
    const blocks: ReactNode[] = []
    let toolRun: ToolActivity[] = []
    let progressRun: ProgressStepPart[] = []
    let activityRun: ActivityPart[] = []
    const allTools = message.parts
      .filter((part) => part.kind === 'tool')
      .map((part) => part.tool)
    const flushTools = () => {
      if (!toolRun.length) return
      const run = toolRun
      blocks.push(<ToolRun key={`run-${run[0].callId}`} tools={run} />)
      toolRun = []
    }
    const flushProgress = () => {
      if (!progressRun.length) return
      const run = progressRun
      blocks.push(
        <PipelineProgress key={`pipeline-progress-${run[0].step}-${run[run.length - 1].step}`} steps={run} />
      )
      progressRun = []
    }
    const flushActivity = () => {
      if (!activityRun.length) return
      const run = activityRun
      blocks.push(<ActivityGroup key={`activity-${blocks.length}`} parts={run} />)
      activityRun = []
    }
    const flushAll = () => {
      flushTools()
      flushProgress()
      flushActivity()
    }
    message.parts.forEach((part, idx) => {
      if (part.kind === 'tool') {
        flushActivity()
        toolRun.push(part.tool)
        return
      }
      if (part.kind === 'progress_step') {
        flushTools()
        flushActivity()
        progressRun.push(part)
        return
      }
      if (
        part.kind === 'loop_state' ||
        part.kind === 'capability_activity' ||
        part.kind === 'verification_state' ||
        part.kind === 'task_memory'
      ) {
        flushTools()
        flushProgress()
        activityRun.push(part)
        return
      }
      flushAll()
      if (part.kind === 'contract') {
        blocks.push(<ContractTraceLine key={`contract-${idx}`} trace={part.trace} tools={allTools} />)
        return
      }
      if (part.text) {
        blocks.push(<MarkdownBlock key={idx} text={part.text} />)
      }
    })
    flushAll()
    return <>{blocks}</>
  }

  return (
    <>
      {message.tools && message.tools.length > 0 && (
        <ToolRun tools={message.tools} />
      )}
      {message.text ? (
        <MarkdownBlock text={message.text} />
      ) : (
        !(message.tools && message.tools.length) && (
          <span className="typing">
            <i /> <i /> <i />
          </span>
        )
      )}
    </>
  )
})

const PipelineProgress = memo(function PipelineProgress({ steps }: { steps: ProgressStepPart[] }) {
  // Each text-delta render of ChatMessageBody used to redo this sort + Map
  // build. Cache by the steps reference so renders that don't change the
  // pipeline run skip the work entirely.
  const { planStep, rendered } = useMemo(() => {
    const ordered = [...steps].sort((a, b) => a.step - b.step)
    const latest = new Map<number, ProgressStepPart>()
    for (const step of ordered) latest.set(step.step, step)
    const latestSteps = [...latest.entries()]
      .map(([step, part]) => ({ step, part }))
      .sort((a, b) => a.step - b.step)
    return {
      planStep: latestSteps.find(({ step }) => step === 0)?.part,
      rendered: latestSteps.filter(({ step }) => step > 0).map(({ part }) => part)
    }
  }, [steps])

  return (
    <section className="pipeline-progress">
      <div className="pipeline-progress-title">Browser task progress</div>
      {planStep && (
        <div className="pipeline-progress-plan">
          <span className="pipeline-progress-plan-label">Plan ready</span>
          <span className="pipeline-progress-item-status planned">{summarizeProgressStepStatus('planned')}</span>
          <span className="pipeline-progress-plan-detail">{planStep.detail ?? 'Ready to run.'}</span>
        </div>
      )}
      <ol className="pipeline-progress-list">
        {rendered.map((step) => (
          <li key={`progress-${step.step}`} className={`pipeline-progress-item ${step.status}`}>
            <span className="pipeline-progress-item-step">{step.step}.</span>
            <div className="pipeline-progress-item-body">
              <div className="pipeline-progress-item-head">
                <span className="pipeline-progress-item-title">{step.title}</span>
                <span className={`pipeline-progress-item-status ${step.status}`}>
                  {summarizeProgressStepStatus(step.status)}
                </span>
              </div>
              {step.detail && <span className="pipeline-progress-item-detail">{step.detail}</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}, (prev, next) => shallowArrayEqual(prev.steps, next.steps))

function CompactEventCard({
  title,
  meta,
  detail,
  tone = 'neutral'
}: {
  title: string
  meta?: string | null
  detail?: string | null
  tone?: 'neutral' | 'live' | 'error' | 'success'
}) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = !!detail?.trim()
  return (
    <section className={`activity-card ${tone} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className={`activity-card-header ${hasDetail ? 'toggle' : ''}`}
        onClick={() => hasDetail && setExpanded((open) => !open)}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <span className="activity-card-dot" />
        <span className="activity-card-title">{title}</span>
        {meta && <span className="activity-card-meta">{meta}</span>}
        {hasDetail && <span className="activity-card-caret">{expanded ? 'Hide' : 'Details'}</span>}
      </button>
      {hasDetail && expanded ? (
        <div className="activity-card-body">
          <pre>{detail}</pre>
        </div>
      ) : null}
    </section>
  )
}

function LoopStateCard({ part }: { part: LoopStatePart }) {
  const detail = [part.summary, part.reason].filter(Boolean).join('\n')
  return (
    <CompactEventCard
      title={`${LOOP_EVENT_LABEL[part.event]}: ${LOOP_PHASE_LABEL[part.phase]}`}
      meta={`Iteration ${part.iteration}`}
      detail={detail || null}
      tone={part.event === 'task_completed' ? 'success' : part.event === 'task_blocked' || part.event === 'task_aborted' ? 'error' : 'live'}
    />
  )
}

function CapabilityActivityCard({ part }: { part: CapabilityActivityPart }) {
  const title = `${CAPABILITY_EVENT_LABEL[part.event]} ${part.capability}${part.cached ? ' (cached)' : ''}`
  const meta = [part.service, part.artifactId ? `artifact ${part.artifactId}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <CompactEventCard
      title={title}
      meta={part.durationMs != null ? formatMs(part.durationMs) : meta}
      detail={[part.summary, meta].filter(Boolean).join('\n') || null}
      tone={part.event === 'capability_failed' ? 'error' : part.event === 'capability_completed' || part.event === 'capability_cache_hit' ? 'success' : 'live'}
    />
  )
}

function VerificationStateCard({ part }: { part: VerificationStatePart }) {
  const title = part.check
    ? `${VERIFICATION_EVENT_LABEL[part.event]}: ${part.check}`
    : VERIFICATION_EVENT_LABEL[part.event]
  const extra = [
    part.status ? `status: ${part.status}` : null,
    part.rawLogArtifactId ? `artifact: ${part.rawLogArtifactId}` : null
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <CompactEventCard
      title={title}
      detail={[part.summary, extra].filter(Boolean).join('\n') || null}
      tone={part.status === 'fail' || part.status === 'blocked' ? 'error' : part.event === 'verification_passed' ? 'success' : 'live'}
    />
  )
}

function TaskMemoryCard({ part }: { part: TaskMemoryPart }) {
  const title = `${part.event.replaceAll('_', ' ')} (${part.scope})`
  const extra = [
    part.keys?.length ? `keys: ${part.keys.join(', ')}` : null,
    part.artifactId ? `artifact: ${part.artifactId}` : null
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <CompactEventCard
      title={title}
      detail={[part.summary, extra].filter(Boolean).join('\n') || null}
    />
  )
}

/** One-line label for any collapsed activity part. */
function activityLabel(part: ActivityPart): string {
  switch (part.kind) {
    case 'loop_state':
      return `${LOOP_EVENT_LABEL[part.event]}: ${LOOP_PHASE_LABEL[part.phase]}`
    case 'capability_activity':
      return `${CAPABILITY_EVENT_LABEL[part.event]} ${part.capability}${part.cached ? ' (cached)' : ''}`
    case 'verification_state':
      return part.check
        ? `${VERIFICATION_EVENT_LABEL[part.event]}: ${part.check}`
        : VERIFICATION_EVENT_LABEL[part.event]
    case 'task_memory':
      return `${part.event.replaceAll('_', ' ')} (${part.scope})`
  }
}

function activityTone(part: ActivityPart): 'neutral' | 'live' | 'error' | 'success' {
  switch (part.kind) {
    case 'loop_state':
      if (part.event === 'task_completed') return 'success'
      if (part.event === 'task_blocked' || part.event === 'task_aborted') return 'error'
      return 'live'
    case 'capability_activity':
      if (part.event === 'capability_failed') return 'error'
      if (part.event === 'capability_completed' || part.event === 'capability_cache_hit') return 'success'
      return 'live'
    case 'verification_state':
      if (part.status === 'fail' || part.status === 'blocked') return 'error'
      if (part.event === 'verification_passed') return 'success'
      return 'live'
    case 'task_memory':
      return 'neutral'
  }
}

function renderActivityCard(part: ActivityPart, idx: number): ReactNode {
  switch (part.kind) {
    case 'loop_state':
      return <LoopStateCard key={`loop-${idx}`} part={part} />
    case 'capability_activity':
      return <CapabilityActivityCard key={`capability-${idx}`} part={part} />
    case 'verification_state':
      return <VerificationStateCard key={`verification-${idx}`} part={part} />
    case 'task_memory':
      return <TaskMemoryCard key={`memory-${idx}`} part={part} />
  }
}

const TERMINAL_TONES = new Set(['success', 'error'])

/**
 * Collapses a run of loop/capability/verification/memory events into a single
 * quiet, Cursor-style reasoning block: one summary row (the most recent event)
 * that expands to the full step list. Keeps the timeline readable so tool cards
 * and prose carry the visual weight.
 *
 * Memoized so streaming text-delta renders of ChatMessageBody skip the body
 * whenever the activity slice hasn't changed.
 */
const ActivityGroup = memo(function ActivityGroup({ parts }: { parts: ActivityPart[] }) {
  const [expanded, setExpanded] = useState(false)
  const last = parts[parts.length - 1]
  const tone = activityTone(last)
  // While the run is mid-flight (no terminal event yet) keep the live pulse.
  const isLive = !TERMINAL_TONES.has(tone)
  const groupTone = isLive ? 'live' : tone
  return (
    <section className={`activity-run ${groupTone} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="activity-run-header"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className="activity-card-dot" />
        <span className="activity-run-title">{activityLabel(last)}</span>
        {parts.length > 1 && (
          <span className="activity-run-count">{parts.length} steps</span>
        )}
        <span className="activity-card-caret">{expanded ? 'Hide' : 'Steps'}</span>
      </button>
      {expanded && <div className="activity-run-body">{parts.map(renderActivityCard)}</div>}
    </section>
  )
}, (prev, next) => shallowArrayEqual(prev.parts, next.parts))

export type ContractValidationState =
  | 'no-edits'
  | 'pending'
  | 'repair-required'
  | 'validated'
  | 'validated-after-repair'
  | 'auto-validated'

const ContractTraceLine = memo(function ContractTraceLine({
  trace,
  tools
}: {
  trace: ContractTrace
  tools: ToolActivity[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  // The two derive* functions each iterate the full tools array. Cache by
  // tools reference so a streaming text delta that doesn't change tool state
  // doesn't pay the O(n) walk twice (validation + execution) per render.
  const validation = useMemo(() => deriveValidationState(tools), [tools])
  const execution = useMemo(() => deriveExecutionSummary(tools), [tools])
  const toolCount = trace.tools.length
  const profile = PROFILE_LABEL[trace.profile] ?? trace.profile
  const debugPayload = useMemo(
    () => buildTraceDebugPayload(trace, validation, tools),
    [trace, validation, tools]
  )
  const copyTrace = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(debugPayload, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className={`contract-trace ${validation} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="contract-trace-summary"
        onClick={() => setExpanded((s) => !s)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse turn trace' : 'Expand turn trace'}
      >
        <span className="contract-trace-dot" />
        <span>{profile} profile</span>
        <span className="contract-trace-sep" />
        <span>{toolCount} tools exposed</span>
        <span className="contract-trace-sep" />
        <span>{VALIDATION_LABEL[validation]}</span>
        {execution.brief && (
          <>
            <span className="contract-trace-sep" />
            <span>{execution.brief}</span>
          </>
        )}
        <span className="contract-trace-caret">{expanded ? 'Hide' : 'Trace'}</span>
      </button>
      {expanded && (
        <div className="contract-trace-detail">
          <div className="contract-trace-detail-head">
            <span>Execution</span>
          </div>
          <TraceMetric label="Tool calls" value={String(execution.toolCalls)} />
          <TraceMetric label="Total tool time" value={execution.totalDurationLabel} />
          <TraceMetric label="Slowest tool" value={execution.slowestLabel} />
          <TraceMetric label="Duplicate work" value={execution.duplicateLabel} />
          <div className="contract-trace-detail-head">
            <span>Model context</span>
            <button
              type="button"
              className="contract-trace-copy"
              onClick={copyTrace}
              title={copied ? 'Copied trace JSON' : 'Copy trace JSON'}
              aria-label="Copy turn trace JSON"
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          </div>
          <TraceInput label="Selected folder" value={trace.inputs?.selectedFolder} />
          <TraceInput label="Active page" value={trace.inputs?.activePageContext} />
          {trace.codexCwd && <TraceInput label="Codex cwd" value={trace.inputs?.codexCwd} />}
          <div className="contract-trace-detail-head decisions">
            <span>Routing decisions</span>
          </div>
          <TraceDecision label="Selected folder" decision={trace.workspace} />
          <TraceDecision label="Active page" decision={trace.activePage} />
          {trace.codexCwd && <TraceDecision label="Codex cwd" decision={trace.codexCwd} />}
          <div className="contract-trace-tools">
            <span>Tools</span>
            <code>{trace.tools.length ? trace.tools.join(', ') : 'none'}</code>
          </div>
        </div>
      )}
    </div>
  )
}, (prev, next) => prev.trace === next.trace && shallowArrayEqual(prev.tools, next.tools))

function TraceInput({ label, value }: { label: string; value?: string }) {
  return (
    <div className="contract-trace-row input">
      <span>{label}</span>
      <strong>{value ? 'sent' : 'not sent'}</strong>
      <code title={value}>{value ?? 'not sent'}</code>
    </div>
  )
}

function TraceDecision({
  label,
  decision
}: {
  label: string
  decision: ContractTrace['workspace']
}) {
  if (!decision) return null
  return (
    <div className="contract-trace-row">
      <span>{label}</span>
      <strong>{decision.included ? 'included' : 'ignored'}</strong>
      <code>{DECISION_LABEL[decision.reason] ?? decision.reason}</code>
      {decision.detail && <small title={decision.detail}>{decision.detail}</small>}
    </div>
  )
}

function TraceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="contract-trace-row metric">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  )
}

const PROFILE_LABEL: Record<string, string> = {
  browser: 'Browser',
  codex: 'Codex',
  conversation: 'Conversation',
  filesystem: 'Filesystem',
  full: 'Full',
  research: 'Research'
}

const VALIDATION_LABEL: Record<ContractValidationState, string> = {
  'auto-validated': 'auto-validated',
  'no-edits': 'no edits',
  pending: 'validation pending',
  'repair-required': 'repair required',
  validated: 'validated',
  'validated-after-repair': 'validated after repair'
}

const DECISION_LABEL: Record<string, string> = {
  'active-page-reference': 'user referenced page',
  'browser-action': 'browser action',
  'explicit-local-scope': 'explicit local scope',
  'local-action-target': 'local action target',
  'local-path': 'local path',
  'no-active-page-reference': 'no page reference',
  'no-local-intent': 'no local intent',
  'no-selected-folder': 'no selected folder',
  'selected-folder': 'selected folder',
  'web-docs-or-research': 'web/docs request'
}

export function buildTraceDebugPayload(
  trace: ContractTrace,
  validation: ContractValidationState,
  executedTools: ToolActivity[] = []
) {
  const execution = deriveExecutionSummary(executedTools)
  return {
    profile: trace.profile,
    validation,
    inputs: {
      selectedFolder: trace.inputs?.selectedFolder ?? null,
      activePageContext: trace.inputs?.activePageContext ?? null,
      codexCwd: trace.inputs?.codexCwd ?? null
    },
    decisions: {
      workspace: trace.workspace ?? null,
      activePage: trace.activePage ?? null,
      codexCwd: trace.codexCwd ?? null
    },
    tools: trace.tools,
    execution,
    executedTools: executedTools.map((tool) => ({
      callId: tool.callId,
      tool: tool.tool,
      args: sanitizeToolArgs(tool.args),
      status: tool.status,
      startedAt: tool.startedAt ?? null,
      endedAt: tool.endedAt ?? null,
      durationMs: tool.durationMs ?? null,
      preview: tool.preview ?? null
    }))
  }
}

export interface TraceExecutionSummary {
  toolCalls: number
  totalDurationMs: number
  totalDurationLabel: string
  slowestTool: string | null
  slowestDurationMs: number | null
  slowestLabel: string
  searchCalls: number
  fetchCalls: number
  duplicateSearches: number
  duplicateFetches: number
  duplicateFinalFetches: number
  cacheReuses: number
  duplicateLabel: string
  brief: string | null
}

export function deriveExecutionSummary(tools: ToolActivity[]): TraceExecutionSummary {
  let totalDurationMs = 0
  let slowest: ToolActivity | null = null
  let searchCalls = 0
  let fetchCalls = 0
  let cacheReuses = 0
  const seenSearches = new Set<string>()
  const seenFetches = new Set<string>()
  const seenFinalFetches = new Set<string>()
  let duplicateSearches = 0
  let duplicateFetches = 0
  let duplicateFinalFetches = 0

  for (const tool of tools) {
    const duration = resolvedDurationMs(tool)
    if (duration != null) {
      totalDurationMs += duration
      const slowestDuration = slowest ? resolvedDurationMs(slowest) ?? -1 : -1
      if (duration > slowestDuration) slowest = tool
    }

    const name = baseToolName(tool.tool)
    const args = (tool.args ?? {}) as Record<string, unknown>
    if (name === 'search') {
      searchCalls += 1
      const key = String(args.query ?? '').trim().toLowerCase()
      if (key && seenSearches.has(key)) duplicateSearches += 1
      if (key) seenSearches.add(key)
    }
    if (name === 'fetch_page') {
      fetchCalls += 1
      const key = normalizeDisplayUrl(String(args.url ?? ''))
      if (key && seenFetches.has(key)) duplicateFetches += 1
      if (key) seenFetches.add(key)
      const finalUrl = extractDigestUrl(tool.preview)
      if (finalUrl && seenFinalFetches.has(finalUrl)) duplicateFinalFetches += 1
      if (finalUrl) seenFinalFetches.add(finalUrl)
    }
    if (tool.preview?.toLowerCase().includes('already ')) cacheReuses += 1
  }

  const slowestDurationMs = slowest ? resolvedDurationMs(slowest) : null
  const duplicateBits = [
    duplicateSearches ? `${duplicateSearches} repeat search${duplicateSearches === 1 ? '' : 'es'}` : null,
    duplicateFetches ? `${duplicateFetches} repeat fetch${duplicateFetches === 1 ? '' : 'es'}` : null,
    duplicateFinalFetches ? `${duplicateFinalFetches} same final page${duplicateFinalFetches === 1 ? '' : 's'}` : null,
    cacheReuses ? `${cacheReuses} cache reuse${cacheReuses === 1 ? '' : 's'}` : null
  ].filter(Boolean)
  const duplicateLabel = duplicateBits.length ? duplicateBits.join(', ') : 'none'
  const briefBits = [
    tools.length ? `${tools.length} call${tools.length === 1 ? '' : 's'}` : null,
    slowestDurationMs != null && slowestDurationMs >= 3000
      ? `slowest ${baseToolName(slowest!.tool)} ${formatMs(slowestDurationMs)}`
      : null,
    cacheReuses ? `${cacheReuses} reused` : null,
    duplicateSearches + duplicateFetches + duplicateFinalFetches > 0
      ? `${duplicateSearches + duplicateFetches + duplicateFinalFetches} repeat`
      : null
  ].filter(Boolean)

  return {
    toolCalls: tools.length,
    totalDurationMs,
    totalDurationLabel: totalDurationMs ? formatMs(totalDurationMs) : 'none yet',
    slowestTool: slowest ? baseToolName(slowest.tool) : null,
    slowestDurationMs,
    slowestLabel: slowest && slowestDurationMs != null
      ? `${baseToolName(slowest.tool)} ${formatMs(slowestDurationMs)}`
      : 'none yet',
    searchCalls,
    fetchCalls,
    duplicateSearches,
    duplicateFetches,
    duplicateFinalFetches,
    cacheReuses,
    duplicateLabel,
    brief: briefBits.length ? briefBits.join(' · ') : null
  }
}

export function deriveValidationState(tools: ToolActivity[]): ContractValidationState {
  let sawEdit = false
  let sawValidationFailureAfterEdit = false
  let latestValidationAfterEdit: ToolActivity | null = null

  for (let i = 0; i < tools.length; i += 1) {
    const tool = tools[i]
    if (isEditTool(tool.tool)) {
      sawEdit = true
      latestValidationAfterEdit = null
      continue
    }
    if (!sawEdit || baseToolName(tool.tool) !== 'run_validation') continue
    latestValidationAfterEdit = tool
    if (tool.status === 'error') sawValidationFailureAfterEdit = true
  }

  if (!sawEdit) return 'no-edits'
  if (!latestValidationAfterEdit) return sawValidationFailureAfterEdit ? 'repair-required' : 'pending'
  if (latestValidationAfterEdit.status === 'error') return 'repair-required'
  if (latestValidationAfterEdit.status === 'running') return 'pending'
  if (sawValidationFailureAfterEdit) return 'validated-after-repair'
  return latestValidationAfterEdit.callId.startsWith('auto_validation_') ? 'auto-validated' : 'validated'
}

function isEditTool(tool: string): boolean {
  const name = baseToolName(tool)
  return name === 'edit_file' || name === 'write_file'
}

function baseToolName(tool: string): string {
  return tool.startsWith('gladdis.') ? tool.slice('gladdis.'.length) : tool
}
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 1000 * 60) return `${Math.round(ms / 1000)}s`
  return `${(ms / 1000 / 60).toFixed(1)}min`
}
function normalizeDisplayUrl(url: string, maxLength = 80): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 1 ? parsed.pathname : ''
    const display = `${parsed.hostname}${path}${parsed.search}${parsed.hash}`
    return display.length > maxLength ? `${display.slice(0, maxLength - 1)}…` : display
  } catch {
    return url
  }
}
function sanitizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args
  const sanitized = { ...args } as Record<string, unknown>
  if ('text' in sanitized && typeof sanitized.text === 'string' && sanitized.text.length > 200) {
    sanitized.text = `${sanitized.text.slice(0, 200)}…`
  }
  return sanitized
}
function extractDigestUrl(preview: string | null | undefined): string | null {
  if (!preview) return null
  const match = preview.match(/(?:Final URL|URL): (https?:\/\/[^\s]+)/)
  return match ? normalizeDisplayUrl(match[1]) : null
}
function resolvedDurationMs(tool: ToolActivity): number | null {
  if (tool.durationMs != null) return tool.durationMs
  if (tool.startedAt && tool.endedAt) {
    try {
      return new Date(tool.endedAt).getTime() - new Date(tool.startedAt).getTime()
    } catch {
      return null
    }
  }
  return null
}
