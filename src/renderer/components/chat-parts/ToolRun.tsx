import { memo, useEffect, useState } from 'react'
import type { ToolActivity } from '../chatTypes'
import { openImageInTab } from '../../lib/openImageInTab'

const TOOL_LABEL: Record<string, string> = {
  execute_in_browser: 'Running script',
  shell: 'Running shell',
  search: 'Searching',
  fetch_page: 'Opening page',
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
  grep: 'Searching files',
  search_files: 'Searching files',
  read_clipboard: 'Reading clipboard',
  write_clipboard: 'Writing clipboard',
  run_validation: 'Validating',
  recall_history: 'Recalling history'
}

/** Verb pair for a tool: [present-continuous (running), past (settled)]. */
const TOOL_VERB: Record<string, [string, string]> = {
  execute_in_browser: ['Running script', 'Ran script'],
  shell: ['Running shell', 'Ran shell'],
  search: ['Searching the web for', 'Searched the web for'],
  fetch_page: ['Opening', 'Opened'],
  read_page: ['Reading the page', 'Read the page'],
  navigate: ['Navigating to', 'Navigated to'],
  screenshot_confirmation: ['Confirming', 'Confirmed'],
  grep_click: ['Clicking', 'Clicked'],
  grep_type: ['Typing', 'Typed'],
  click_xy: ['Clicking', 'Clicked'],
  type_text: ['Typing', 'Typed'],
  press_key: ['Pressing', 'Pressed'],
  cdp_command: ['Running', 'Ran'],
  read_file: ['Reading', 'Read'],
  write_file: ['Writing', 'Wrote'],
  edit_file: ['Editing', 'Edited'],
  list_dir: ['Listing', 'Listed'],
  grep: ['Searching files for', 'Searched files for'],
  search_files: ['Searching files for', 'Searched files for'],
  read_clipboard: ['Reading clipboard', 'Read clipboard'],
  write_clipboard: ['Writing clipboard', 'Wrote to clipboard'],
  run_validation: ['Validating', 'Validated'],
  recall_history: ['Recalling earlier history', 'Recalled earlier history']
}

/** Trailing-path basename, so "/a/b/ChatPanel.tsx" reads as "ChatPanel.tsx". */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const tail = trimmed.split('/').filter(Boolean).pop() ?? trimmed
  return tail || path
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
  } else if (name === 'search' || name === 'search_files' || name === 'grep') {
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
  } else if (name === 'execute_in_browser' || name === 'shell') {
    object = a.command ? `“${String(a.command).slice(0, 60)}”` : ''
  } else if (name === 'read_clipboard') {
    object = `(${String(a.selection || 'clipboard')})`
  } else if (name === 'write_clipboard') {
    const text = String(a.text ?? '')
    object = text.trim() ? `“${text.slice(0, 60)}”` : '(empty text)'
  }

  const sentence = object ? `${verb} ${object}` : verb
  return tool.status === 'error' ? `${sentence} — failed` : sentence
}

function baseToolName(name: string): string {
  const stripped = name.startsWith('copilot.')
    ? name.slice('copilot.'.length)
    : name.startsWith('cursor.')
      ? name.slice('cursor.'.length)
      : name
  const parts = stripped.split('.').filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : stripped
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 1000 * 60) return `${Math.round(ms / 1000)}s`
  return `${(ms / 1000 / 60).toFixed(1)}min`
}

function statusTone(tool: ToolActivity): 'running' | 'error' | 'ok' {
  if (tool.status === 'error') return 'error'
  if (tool.status === 'running') return 'running'
  return 'ok'
}

function groupBadge(group: ToolActivity[]): string | null {
  const count = group.length
  if (count > 1) return `${count} calls`
  const tool = group[0]
  const name = baseToolName(tool.tool)
  if (name === 'edit_file' || name === 'write_file') return 'edit'
  if (name === 'search' || name === 'search_files' || name === 'grep') return 'query'
  return null
}

function isMutatingTool(name: string): boolean {
  return name === 'edit_file' || name === 'write_file'
}

function toolDetail(tool: ToolActivity): string | null {
  const preview = tool.preview?.trim()
  return preview?.length ? preview : null
}

function toolImageSrc(tool: ToolActivity): string | null {
  const src = tool.imageDataUrl?.trim()
  return src?.length ? src : null
}

/** A preview reads as a diff when several lines lead with +/- (unified style). */
function looksLikeDiff(text: string): boolean {
  const diffLines = text
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length
  return diffLines >= 2
}

/** Cursor-style colored diff for file edits/writes. */
function DiffBlock({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="diff-viewer">
      {lines.map((line, i) => {
        const tone = /^\+\+\+|^---/.test(line)
          ? 'diff-line-context'
          : line.startsWith('+')
            ? 'diff-line-added'
            : line.startsWith('-')
              ? 'diff-line-removed'
              : 'diff-line-context'
        return (
          <div key={i} className={`diff-line ${tone}`}>
            {line.length ? line : ' '}
          </div>
        )
      })}
    </div>
  )
}

function ToolImage({ tool }: { tool: ToolActivity }) {
  const imageSrc = toolImageSrc(tool)
  if (!imageSrc) return null
  const name = baseToolName(tool.tool)
  const title = `${name} result`
  return (
    <button
      type="button"
      className="tool-call-output-image-link"
      title="Open image in tab"
      onClick={() => void openImageInTab(imageSrc, title)}
    >
      <img className="tool-call-output-image" src={imageSrc} alt={title} />
    </button>
  )
}

function ToolOutput({ tool }: { tool: ToolActivity }) {
  const detail = toolDetail(tool)
  const imageSrc = toolImageSrc(tool)
  if (!detail && !imageSrc) return null
  const isError = tool.status === 'error'
  const name = baseToolName(tool.tool)
  const title = isError ? 'Error' : name
  const showDiff = !!detail && !isError && isMutatingTool(name) && looksLikeDiff(detail)
  return (
    <div className="tool-call-output">
      <div className="tool-call-output-box">
        <div className="tool-call-output-title">{title}</div>
        <ToolImage tool={tool} />
        {detail && (showDiff ? <DiffBlock text={detail} /> : <pre className="tool-call-output-pre">{detail}</pre>)}
      </div>
    </div>
  )
}

function ToolCall({ tool }: { tool: ToolActivity }) {
  const isError = tool.status === 'error'
  const isRunning = tool.status === 'running'
  const [isExpanded, setExpanded] = useState(false)
  const hasOutput = !!toolDetail(tool) || !!toolImageSrc(tool)
  return (
    <div className={`tool-call-card ${isExpanded ? 'expanded' : ''} ${isError ? 'error' : ''}`}>
      <button
        type="button"
        className="tool-call-card-header"
        onClick={() => hasOutput && setExpanded((open) => !open)}
        disabled={!hasOutput}
        aria-expanded={hasOutput ? isExpanded : undefined}
      >
        <span className={`tool-call-card-status ${statusTone(tool)}`}>
          <ToolStatusIcon status={tool.status} />
        </span>
        <span className="tool-call-card-title">{toolSentence(tool)}</span>
        {tool.durationMs != null && (
          <span className="tool-call-card-duration">{formatMs(tool.durationMs)}</span>
        )}
        {hasOutput ? (
          <span className="tool-call-details">{isExpanded ? 'Hide' : 'Show'} details</span>
        ) : (
          isRunning && <span className="tool-call-details">live</span>
        )}
      </button>
      {isExpanded && <ToolOutput tool={tool} />}
    </div>
  )
}

function ToolStatusIcon({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running') {
    return (
      <svg className="tool-spinner" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="path" cx="12" cy="12" r="9" fill="none" strokeWidth="2" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg className="tool-error-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5Zm-1.9 3.85 1.9 1.9 1.9-1.9.9.9L8.9 8.9l1.9 1.9-.9.9L8 9.8l-1.9 1.9-.9-.9 1.9-1.9-1.9-1.9.9-.9Z"
          fill="currentColor"
        />
      </svg>
    )
  }
  return (
    <svg className="tool-check-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.3 6.6 11l5.9-6.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const ToolRun = memo(function ToolRun({ tools }: { tools: ToolActivity[] }) {
  // Group sequential runs of the same tool into a single visual block.
  const groups: ToolActivity[][] = []
  let lastTool = ''
  tools.forEach((tool) => {
    const name = baseToolName(tool.tool)
    if (name === lastTool) {
      groups.at(-1)?.push(tool)
    } else {
      lastTool = name
      groups.push([tool])
    }
  })

  // Auto-expand only what carries content worth surfacing unprompted: failures
  // (so the error is visible) and image results (screenshots). A running group
  // is deliberately NOT auto-expanded — its body is empty until the result
  // lands, and the add-only expansion effect would otherwise leave every
  // settled-OK tool expanded, cluttering the transcript during multi-tool tasks.
  const defaultExpandedIds = groups
    .filter((group) => group.some((tool) => tool.status === 'error' || !!toolImageSrc(tool)))
    .map((group) => group[0].callId)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(defaultExpandedIds))

  useEffect(() => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      let changed = false
      for (const id of defaultExpandedIds) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [defaultExpandedIds.join('|')])

  const hasCollapsedControls = groups.length > 1 || tools.length > 2
  const allExpanded = groups.every((group) => expandedGroups.has(group[0].callId))

  const toggleGroup = (callId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(callId)) next.delete(callId)
      else next.add(callId)
      return next
    })
  }

  const setAllGroups = (expand: boolean) => {
    setExpandedGroups(expand ? new Set(groups.map((group) => group[0].callId)) : new Set())
  }

  return (
    <section className="tool-run">
      {hasCollapsedControls && (
        <div className="tool-run-toolbar">
          <span className="tool-run-toolbar-label">Tool activity</span>
          <button
            type="button"
            className="tool-run-toolbar-btn"
            onClick={() => setAllGroups(!allExpanded)}
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}
      {groups.map((group) => {
        const name = baseToolName(group[0].tool)
        const isError = group.some((tool) => tool.status === 'error')
        const isRunning = group.some((tool) => tool.status === 'running')
        const totalDuration = group
          .map((tool) => tool.durationMs ?? 0)
          .reduce((total, ms) => total + ms, 0)
        const groupId = group[0].callId
        const isExpanded = expandedGroups.has(groupId)
        const badge = groupBadge(group)
        return (
          <div
            key={groupId}
            className={[
              'tool-run-group',
              isExpanded ? 'expanded' : '',
              isError ? 'error' : '',
              isRunning ? 'running' : '',
              isMutatingTool(name) ? 'mutating' : ''
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <button type="button" className="tool-run-group-header" onClick={() => toggleGroup(groupId)}>
              <span className={`tool-run-group-status ${isError ? 'error' : isRunning ? 'running' : 'ok'}`}>
                <ToolStatusIcon status={isError ? 'error' : isRunning ? 'running' : 'ok'} />
              </span>
              <span className="tool-run-group-title">
                {group.length === 1 ? toolSentence(group[0]) : TOOL_LABEL[name] ?? name}
              </span>
              {badge && <span className="tool-run-group-badge">{badge}</span>}
              <span className="tool-run-group-duration">{formatMs(totalDuration)}</span>
              <span className="tool-run-group-caret">{isExpanded ? 'Hide' : 'Show'}</span>
            </button>
            {(isExpanded || (group.length === 1 && !!toolImageSrc(group[0]))) && (
              <div className="tool-run-group-body">
                {group.length === 1 ? (
                  // Screenshot/image results should surface visibly as soon as they land,
                  // even if expansion state lags during streaming/hydration.
                  <>
                    {!!toolImageSrc(group[0]) && !isExpanded && (
                      <div className="tool-call-output">
                        <div className="tool-call-output-box">
                          <ToolImage tool={group[0]} />
                        </div>
                      </div>
                    )}
                    {isExpanded && <ToolOutput tool={group[0]} />}
                  </>
                ) : (
                  group.map((tool) => <ToolCall key={tool.callId} tool={tool} />)
                )}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
})
