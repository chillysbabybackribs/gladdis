import { memo, useMemo, useState } from 'react'
import type { ContractTrace } from '../../../../shared/types'
import type { ToolActivity } from '../chatTypes'
import {
  baseToolName,
  extractDigestUrl,
  formatMs,
  isEditTool,
  normalizeDisplayUrl,
  resolvedDurationMs,
  sanitizeToolArgs,
  shallowArrayEqual
} from './utils'

export type ContractValidationState =
  | 'no-edits'
  | 'pending'
  | 'repair-required'
  | 'validated'
  | 'validated-after-repair'
  | 'auto-validated'

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

/**
 * Cursor-style "trace" summary at the bottom of an assistant turn. Surfaces
 * which profile shipped, validation state, execution stats, and the routing
 * decisions that determined what got attached to the prompt. Memoized so
 * text-delta renders of the surrounding ChatMessageBody don't redo the
 * O(n) tool walks behind the metrics.
 */
export const ContractTraceLine = memo(
  function ContractTraceLine({
    trace,
    tools
  }: {
    trace: ContractTrace
    tools: ToolActivity[]
  }) {
    const [expanded, setExpanded] = useState(false)
    const [copied, setCopied] = useState(false)
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
  },
  (prev, next) => prev.trace === next.trace && shallowArrayEqual(prev.tools, next.tools)
)

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

// ── Pure derivations (re-exported via ChatMessageBody for the test suite) ───

export interface TraceExecutionSummary {
  toolCalls: number
  totalDurationMs: number
  totalDurationLabel: string
  slowestTool: string | null
  slowestDurationMs: number | null
  slowestLabel: string
  searchCalls: number
  /** Includes current `navigate` calls and legacy `fetch_page` history items. */
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
    if (name === 'navigate' || name === 'fetch_page') {
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
