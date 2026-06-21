import { memo, useMemo, useState, type ReactNode } from 'react'
import type { ContractTrace } from '../../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import type { Message, ToolActivity } from './chatTypes'

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

const TOOL_LABEL: Record<string, string> = {
  execute_in_browser: 'Running script',
  search: 'Searching',
  fetch_page: 'Opening page',
  background_web_search: 'Background search',
  browse_task: 'Running task',
  read_page: 'Reading page',
  navigate: 'Navigating',
  screenshot_confirmation: 'Confirming screenshot',
  click_xy: 'Clicking',
  type_text: 'Typing',
  press_key: 'Pressing key',
  cdp_command: 'CDP command',
  read_file: 'Reading file',
  write_file: 'Writing file',
  edit_file: 'Editing file',
  list_dir: 'Listing dir',
  search_files: 'Searching files',
  run_validation: 'Validating',
  recall_history: 'Recalling history'
}

function argHint(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, any>
  if (tool === 'navigate') return a.url ?? ''
  if (tool === 'screenshot_confirmation') return a.url ?? ''
  if (tool === 'click_xy') return `(${a.x}, ${a.y})`
  if (tool === 'cdp_command') return a.method ?? ''
  if (tool === 'execute_in_browser') return String(a.code ?? '').slice(0, 48)
  if (tool === 'type_text') return `"${String(a.text ?? '').slice(0, 32)}"`
  if (tool === 'press_key') return a.key ?? ''
  if (tool === 'read_page') return a.focus ?? ''
  if (tool === 'search' || tool === 'background_web_search') return a.query ?? ''
  if (tool === 'fetch_page') return a.url ?? ''
  if (tool === 'browse_task') return a.task ?? ''
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file' || tool === 'list_dir')
    return a.path ?? ''
  if (tool === 'search_files') return a.query ?? ''
  if (tool === 'run_validation') return a.check ?? ''
  if (tool === 'recall_history') return 'Recalling history'
  return ''
}

export const ChatMessageBody = memo(function ChatMessageBody({ message }: { message: Message }) {
  if (message.parts && message.parts.length) {
    const blocks: ReactNode[] = []
    let toolRun: ToolActivity[] = []
    const allTools = message.parts
      .filter((part) => part.kind === 'tool')
      .map((part) => part.tool)
    const flushTools = () => {
      if (!toolRun.length) return
      const run = toolRun
      blocks.push(<ToolRun key={`run-${run[0].callId}`} tools={run} />)
      toolRun = []
    }
    message.parts.forEach((part, idx) => {
      if (part.kind === 'tool') {
        toolRun.push(part.tool)
        return
      }
      flushTools()
      if (part.kind === 'contract') {
        blocks.push(<ContractTraceLine key={`contract-${idx}`} trace={part.trace} tools={allTools} />)
        return
      }
      if (part.text) {
        blocks.push(<MarkdownBlock key={idx} text={part.text} />)
      }
    })
    flushTools()
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

export type ContractValidationState =
  | 'no-edits'
  | 'pending'
  | 'repair-required'
  | 'validated'
  | 'validated-after-repair'
  | 'auto-validated'

function ContractTraceLine({ trace, tools }: { trace: ContractTrace; tools: ToolActivity[] }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const validation = deriveValidationState(tools)
  const execution = deriveExecutionSummary(tools)
  const toolCount = trace.tools.length
  const profile = PROFILE_LABEL[trace.profile] ?? trace.profile
  const debugPayload = buildTraceDebugPayload(trace, validation, tools)
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
}

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
    if (name === 'search' || name === 'background_web_search') {
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

function ToolRun({ tools }: { tools: ToolActivity[] }) {
  const [expanded, setExpanded] = useState(tools.length <= 2 || tools.some((t) => t.status !== 'ok'))
  const single = tools.length === 1
  const toggle = (
    <button
      type="button"
      className="tool-run-toggle"
      onClick={() => setExpanded((s) => !s)}
      aria-expanded={expanded}
      title={expanded ? 'Collapse tool details' : 'Expand tool details'}
    >
      {expanded ? 'Hide' : single ? 'Show' : `Show ${tools.length - 1} more`}
    </button>
  )
  const visible = expanded ? tools : tools.slice(0, 1)
  return (
    <section className={`tool-run ${expanded ? 'expanded' : 'collapsed'}`}>
      <div className="tool-run-track">
        {visible.map((tool, idx) => (
          <ToolStep
            key={tool.callId}
            tool={tool}
            last={idx === visible.length - 1}
            collapsed={single && !expanded}
            toggle={idx === 0 ? toggle : null}
          />
        ))}
      </div>
    </section>
  )
}

function ToolStep({
  tool,
  last,
  collapsed = false,
  toggle = null
}: {
  tool: ToolActivity
  last: boolean
  collapsed?: boolean
  toggle?: ReactNode
}) {
  const [showAll, setShowAll] = useState(false)
  // Codex surfaces browser tools namespaced as "gladdis.<name>"; label them the same.
  const baseTool = tool.tool.startsWith('gladdis.') ? tool.tool.slice('gladdis.'.length) : tool.tool
  const label = TOOL_LABEL[baseTool] ?? tool.tool
  const hint = argHint(baseTool, tool.args)
  const duration = formatToolDuration(tool)
  const expandable = (hint.length + (tool.preview?.length ?? 0)) > 120
  return (
    <div className={`tool-run-step ${tool.status}`}>
      <div className="tool-run-rail">
        <span className={`tool-run-step-dot ${tool.status}`} />
        {!last && <span className="tool-run-step-line" />}
      </div>
      <div className="tool-run-body">
        <div className="tool-run-topline">
          <span className="tool-run-step-label">{label}</span>
          <span className={`tool-run-step-status ${tool.status}`}>{tool.status}</span>
          {duration && <span className="tool-run-duration">{duration}</span>}
          {toggle}
        </div>
        {!collapsed && (
          <>
            {(hint || tool.preview) && (
              <div className={`tool-run-meta ${expandable ? (showAll ? 'expanded' : 'clamped') : ''}`}>
                {hint && <code className="tool-run-hint">{hint}</code>}
                {hint && tool.preview && <span className="tool-run-sep" />}
                {tool.preview && <span className="tool-run-preview">{tool.preview}</span>}
              </div>
            )}
            {expandable && (
              <button type="button" className="tool-run-more" onClick={() => setShowAll((s) => !s)}>
                {showAll ? 'Show less' : 'Show all'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function formatToolDuration(tool: ToolActivity): string | null {
  if (typeof tool.durationMs === 'number') return formatMs(tool.durationMs)
  if (tool.status === 'running' && typeof tool.startedAt === 'number') return 'running'
  return null
}

function resolvedDurationMs(tool: ToolActivity): number | null {
  if (typeof tool.durationMs === 'number') return Math.max(0, tool.durationMs)
  if (typeof tool.startedAt === 'number' && typeof tool.endedAt === 'number') {
    return Math.max(0, tool.endedAt - tool.startedAt)
  }
  return null
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

function extractDigestUrl(preview?: string): string {
  if (!preview) return ''
  const match = preview.match(/\bURL:\s*(\S+)/i)
  return match ? normalizeDisplayUrl(match[1]) : ''
}

function sanitizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args ?? null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value
    else if (typeof value === 'number' || typeof value === 'boolean' || value == null) out[key] = value
    else out[key] = '[object]'
  }
  return out
}

function normalizeDisplayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    let value = url.toString().toLowerCase()
    if (value.endsWith('/')) value = value.slice(0, -1)
    return value
  } catch {
    return raw.trim().replace(/[/#]+$/, '').toLowerCase()
  }
}
