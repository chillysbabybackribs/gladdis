import { memo, type ReactNode } from 'react'
import type {
  CapabilityActivityPart,
  LoopStatePart,
  Message,
  ProgressStepPart,
  TaskMemoryPart,
  ToolActivity,
  VerificationStatePart
} from './chatTypes'
import { ActivityGroup, type ActivityPart } from './chat-parts/ActivityGroup'
import { ContractTraceLine } from './chat-parts/ContractTraceLine'
import { MarkdownBlock } from './chat-parts/MarkdownBlock'
import { PipelineProgress } from './chat-parts/PipelineProgress'
import { ToolRun } from './chat-parts/ToolRun'

// Re-export the trace helpers used by the test suite + any external
// consumers (kept for back-compat after the chat-parts/* split).
export {
  buildTraceDebugPayload,
  deriveExecutionSummary,
  deriveValidationState,
  type ContractValidationState,
  type TraceExecutionSummary
} from './chat-parts/ContractTraceLine'

/**
 * ChatMessageBody is the dispatch layer that turns a streaming Message into
 * a list of UI blocks. The heavy renderers live in `chat-parts/`:
 *  • MarkdownBlock      — memoized markdown bubble
 *  • ToolRun            — grouped tool-call cards (file edits, page reads, …)
 *  • PipelineProgress   — multi-step browser task progress
 *  • ActivityGroup      — collapsed loop / capability / verification timeline
 *  • ContractTraceLine  — per-turn profile + validation + execution summary
 *
 * A streaming text delta only re-runs this dispatch layer; each child
 * decides via memo whether to actually re-render its body.
 */
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
        <PipelineProgress
          key={`pipeline-progress-${run[0].step}-${run[run.length - 1].step}`}
          steps={run}
        />
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
        activityRun.push(part as LoopStatePart | CapabilityActivityPart | VerificationStatePart | TaskMemoryPart)
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
    if (message.liveText) {
      blocks.push(<MarkdownBlock key="live-text" text={message.liveText} />)
    }
    return <>{blocks}</>
  }

  return (
    <>
      {message.tools && message.tools.length > 0 && (
        <ToolRun tools={message.tools} />
      )}
      {(message.liveText || message.text) ? (
        <MarkdownBlock text={message.liveText || message.text} />
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
