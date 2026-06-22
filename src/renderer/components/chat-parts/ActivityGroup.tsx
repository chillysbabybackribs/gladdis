import { memo, useState, type ReactNode } from 'react'
import type {
  CapabilityActivityPart,
  LoopStatePart,
  TaskMemoryPart,
  VerificationStatePart
} from '../chatTypes'
import { formatMs, shallowArrayEqual } from './utils'

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

/** Activity parts that get collapsed together into one quiet reasoning group. */
export type ActivityPart =
  | LoopStatePart
  | CapabilityActivityPart
  | VerificationStatePart
  | TaskMemoryPart

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
      tone={
        part.event === 'task_completed'
          ? 'success'
          : part.event === 'task_blocked' || part.event === 'task_aborted'
          ? 'error'
          : 'live'
      }
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
      tone={
        part.event === 'capability_failed'
          ? 'error'
          : part.event === 'capability_completed' || part.event === 'capability_cache_hit'
          ? 'success'
          : 'live'
      }
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
      tone={
        part.status === 'fail' || part.status === 'blocked'
          ? 'error'
          : part.event === 'verification_passed'
          ? 'success'
          : 'live'
      }
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
    <CompactEventCard title={title} detail={[part.summary, extra].filter(Boolean).join('\n') || null} />
  )
}

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
 * quiet reasoning block: one summary row (the most recent event) that expands
 * to the full step list. Keeps the timeline readable so tool cards and prose
 * carry the visual weight.
 *
 * Memoized so streaming text-delta renders skip the body whenever the
 * activity slice hasn't changed.
 */
export const ActivityGroup = memo(
  function ActivityGroup({ parts }: { parts: ActivityPart[] }) {
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
  },
  (prev, next) => shallowArrayEqual(prev.parts, next.parts)
)
