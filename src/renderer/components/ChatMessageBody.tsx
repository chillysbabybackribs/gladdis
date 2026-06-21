import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

/** Verb pair for a tool: [present-continuous (running), past (settled)]. */
const TOOL_VERB: Record<string, [string, string]> = {
  execute_in_browser: ['Running script', 'Ran script'],
  search: ['Searching the web for', 'Searched the web for'],
  background_web_search: ['Searching the web for', 'Searched the web for'],
  fetch_page: ['Opening', 'Opened'],
  browse_task: ['Running task', 'Ran task'],
  read_page: ['Reading the page', 'Read the page'],
  navigate: ['Navigating to', 'Navigated to'],
  screenshot_confirmation: ['Confirming', 'Confirmed'],
  click_xy: ['Clicking', 'Clicked'],
  type_text: ['Typing', 'Typed'],
  press_key: ['Pressing', 'Pressed'],
  cdp_command: ['Running', 'Ran'],
  read_file: ['Reading', 'Read'],
  write_file: ['Writing', 'Wrote'],
  edit_file: ['Editing', 'Edited'],
  list_dir: ['Listing', 'Listed'],
  search_files: ['Searching files for', 'Searched files for'],
  run_validation: ['Validating', 'Validated'],
  recall_history: ['Recalling earlier history', 'Recalled earlier history']
}

/** Trailing-path basename, so "/a/b/ChatPanel.tsx" reads as "ChatPanel.tsx". */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const tail = trimmed.split('/').filter(Boolean).pop() ?? trimmed
  return tail || path
}

/**
 * One clean natural-language line for a tool call, e.g. "Read ChatPanel.tsx" or
 * "Searching the web for performance tuning". Tense follows status: running
 * reads present-continuous, settled reads past; an error appends "— failed".
 */
function toolSentence(tool: ToolActivity): string {
  const name = baseToolName(tool.tool)
  const a = (tool.args ?? {}) as Record<string, any>
  const [running, past] = TOOL_VERB[name] ?? [TOOL_LABEL[name] ?? name, TOOL_LABEL[name] ?? name]
  // Past tense only on success; a failed/in-flight call reads present-continuous
  // ("Validating typecheck — failed", not "Validated … — failed").
  const verb = tool.status === 'ok' ? past : running

  let object = ''
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'list_dir') {
    object = a.path ? baseName(String(a.path)) : ''
  } else if (name === 'search' || name === 'background_web_search' || name === 'search_files') {
    object = a.query ? `“${String(a.query).slice(0, 60)}”` : ''
  } else if (name === 'fetch_page' || name === 'navigate' || name === 'screenshot_confirmation') {
    object = a.url ? normalizeDisplayUrl(String(a.url)).replace(/^https?:\/\//, '') : ''
  } else if (name === 'click_xy') {
    object = `at (${a.x}, ${a.y})`
  } else if (name === 'type_text') {
    object = a.text ? `“${String(a.text).slice(0, 40)}”` : ''
  } else if (name === 'press_key') {
    object = a.key ?? ''
  } else if (name === 'cdp_command') {
    object = a.method ?? ''
  } else if (name === 'run_validation') {
    object = a.check ?? ''
  } else if (name === 'browse_task') {
    object = a.task ? String(a.task).slice(0, 60) : ''
  }

  const sentence = object ? `${verb} ${object}` : verb
  return tool.status === 'error' ? `${sentence} — failed` : sentence
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

const ChevronIcon = () => (
  <svg className="tool-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

const Spinner = () => (
  <svg className="tool-spinner" viewBox="0 0 24 24">
    <circle className="path" cx="12" cy="12" r="10" fill="none" strokeWidth="3" />
  </svg>
)

const CheckIcon = () => (
  <svg className="tool-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const ErrorIcon = () => (
  <svg className="tool-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
)

function isEditOrWriteTool(tool: string): boolean {
  const name = baseToolName(tool)
  return name === 'edit_file' || name === 'write_file'
}

function renderToolTitle(tool: ToolActivity): ReactNode {
  const name = baseToolName(tool.tool)
  const a = (tool.args ?? {}) as Record<string, any>
  const [running, past] = TOOL_VERB[name] ?? [TOOL_LABEL[name] ?? name, TOOL_LABEL[name] ?? name]
  const verb = tool.status === 'ok' ? past : running

  let objectNode: ReactNode = null
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'list_dir') {
    if (a.path) {
      const displayPath = baseName(String(a.path))
      objectNode = <code className="tool-highlight-code" title={String(a.path)}>{displayPath}</code>
    }
  } else if (name === 'search' || name === 'background_web_search' || name === 'search_files') {
    if (a.query) {
      objectNode = <span className="tool-highlight-query">“{String(a.query).slice(0, 60)}”</span>
    }
  } else if (name === 'fetch_page' || name === 'navigate' || name === 'screenshot_confirmation') {
    if (a.url) {
      const cleanUrl = normalizeDisplayUrl(String(a.url)).replace(/^https?:\/\//, '')
      objectNode = <code className="tool-highlight-code" title={String(a.url)}>{cleanUrl}</code>
    }
  } else if (name === 'click_xy') {
    objectNode = <span>at <strong className="tool-highlight-coords">({a.x}, {a.y})</strong></span>
  } else if (name === 'type_text') {
    if (a.text) {
      objectNode = <span className="tool-highlight-query">“{String(a.text).slice(0, 40)}”</span>
    }
  } else if (name === 'press_key') {
    if (a.key) {
      objectNode = <code className="tool-highlight-code">{String(a.key)}</code>
    }
  } else if (name === 'cdp_command') {
    if (a.method) {
      objectNode = <code className="tool-highlight-code">{String(a.method)}</code>
    }
  } else if (name === 'run_validation') {
    if (a.check) {
      objectNode = <code className="tool-highlight-code">{String(a.check)}</code>
    }
  } else if (name === 'run_command') {
    if (a.command) {
      objectNode = <code className="tool-highlight-code" title={String(a.command)}>{String(a.command).slice(0, 60)}{String(a.command).length > 60 ? '…' : ''}</code>
    }
  } else if (name === 'browse_task') {
    if (a.task) {
      objectNode = <span className="tool-highlight-query">“{String(a.task).slice(0, 60)}”</span>
    }
  }

  return (
    <span className="tool-title-text">
      {verb} {objectNode}
      {tool.status === 'error' && <span className="tool-title-failed"> — failed</span>}
    </span>
  )
}

function DiffViewer({ preview }: { preview: string }) {
  if (!preview) return null
  
  const lines = preview.split('\n')
  return (
    <div className="diff-viewer">
      {lines.map((line, idx) => {
        let className = 'diff-line diff-line-context'
        if (line.startsWith('+')) {
          className = 'diff-line diff-line-added'
        } else if (line.startsWith('-')) {
          className = 'diff-line diff-line-removed'
        }
        return (
          <div key={idx} className={className}>
            {line}
          </div>
        )
      })}
    </div>
  )
}

function ToolCallCard({ tool }: { tool: ToolActivity }) {
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  
  const [expanded, setExpanded] = useState(isRunning || isError)

  useEffect(() => {
    if (isRunning || isError) {
      setExpanded(true)
    }
  }, [isRunning, isError])

  let statusIcon = <CheckIcon />
  if (isRunning) {
    statusIcon = <Spinner />
  } else if (isError) {
    statusIcon = <ErrorIcon />
  }

  const durationLabel = tool.durationMs ? formatMs(tool.durationMs) : null
  const hasDetails = !!(tool.preview || tool.args)

  return (
    <div className={`tool-call-card ${tool.status} ${expanded ? 'expanded' : 'collapsed'}`}>
      <button
        type="button"
        className="tool-call-card-header"
        onClick={() => {
          if (hasDetails) setExpanded((s) => !s)
        }}
        disabled={!hasDetails}
        aria-expanded={expanded}
        title={hasDetails ? (expanded ? 'Collapse tool details' : 'Expand tool details') : undefined}
      >
        <span className="tool-call-card-status">{statusIcon}</span>
        <span className="tool-call-card-title">
          {renderToolTitle(tool)}
        </span>
        {durationLabel && (
          <span className="tool-call-card-duration">{durationLabel}</span>
        )}
        {hasDetails && (
          <span className="tool-call-card-caret">
            <ChevronIcon />
          </span>
        )}
      </button>
      
      {expanded && hasDetails && (
        <div className="tool-call-card-body">
          {!!tool.args && (
            <div className="tool-call-args">
              <span className="tool-call-args-label">Parameters:</span>
              <pre className="tool-call-args-pre">
                {JSON.stringify(sanitizeToolArgs(tool.args), null, 2)}
              </pre>
            </div>
          )}
          {tool.preview && (
            <div className="tool-call-output">
              <span className="tool-call-output-label">Result:</span>
              <div className="tool-call-output-box">
                {isEditOrWriteTool(tool.tool) ? (
                  <DiffViewer preview={tool.preview} />
                ) : (
                  <pre className="tool-call-output-pre">{tool.preview}</pre>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolRun({ tools }: { tools: ToolActivity[] }) {
  const isRunning = tools.some((t) => t.status === 'running')
  const hasError = tools.some((t) => t.status === 'error')
  
  const [expanded, setExpanded] = useState(isRunning || hasError)
  
  useEffect(() => {
    if (isRunning || hasError) {
      setExpanded(true)
    }
  }, [isRunning, hasError])

  const totalDuration = tools.reduce((acc, t) => acc + (resolvedDurationMs(t) ?? 0), 0)
  const durationLabel = totalDuration > 0 ? formatMs(totalDuration) : null
  const failedCount = tools.filter((t) => t.status === 'error').length

  let statusIcon = <CheckIcon />
  let statusClass = 'ok'
  if (isRunning) {
    statusIcon = <Spinner />
    statusClass = 'running'
  } else if (hasError) {
    statusIcon = <ErrorIcon />
    statusClass = 'error'
  }

  return (
    <section className="tool-run">
      <div className={`tool-run-group ${statusClass} ${expanded ? 'expanded' : 'collapsed'}`}>
        <button
          type="button"
          className="tool-run-group-header"
          onClick={() => setExpanded((s) => !s)}
          aria-expanded={expanded}
          title={expanded ? 'Collapse tool run' : 'Expand tool run'}
        >
          <span className="tool-run-group-status">{statusIcon}</span>
          <span className="tool-run-group-title">
            {isRunning ? 'Running tools...' : `Used ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`}
          </span>
          {failedCount > 0 && (
            <span className="tool-run-group-failed-badge">
              {failedCount} failed
            </span>
          )}
          {durationLabel && (
            <span className="tool-run-group-duration">{durationLabel}</span>
          )}
          <span className="tool-run-group-caret">
            <ChevronIcon />
          </span>
        </button>
        
        {expanded && (
          <div className="tool-run-group-body">
            {tools.map((tool) => (
              <ToolCallCard key={tool.callId} tool={tool} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
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
