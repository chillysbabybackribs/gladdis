import { memo, useMemo } from 'react'
import type { ProgressStepPart } from '../chatTypes'
import { shallowArrayEqual } from './utils'

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
 * Renders the live multi-step pipeline progress in a chat bubble. Steps
 * stream in over time; we keep only the latest event per step number, sort
 * ascending, and split out the "step 0" plan summary for a friendlier head.
 *
 * Memoized with shallow-array compare so streaming text-delta renders of
 * the parent ChatMessageBody don't redo the sort+Map work when the progress
 * slice hasn't changed.
 */
export const PipelineProgress = memo(function PipelineProgress({
  steps
}: {
  steps: ProgressStepPart[]
}) {
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
