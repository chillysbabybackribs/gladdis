import { AGENT_TOOLS } from '../agentTools'
import { GLADDIS_WEB_TOOLS_RULE } from '../codex/dynamicBrowserTools'

export const CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME = 'gladdis'

export const CLAUDE_CODE_BROWSER_TOOL_NAMES = new Set([
  'recall_history',
  'memory_write',
  'memory_read',
  'memory_list',
  'memory_forget',
  'memory_create_task',
  'search',
  'navigate',
  'read_page',
  'read_a11y',
  'grep_page',
  'watch_network',
  'screenshot',
  'screenshot_app',
  'act',
  'grep_click',
  'grep_type',
  'execute_in_browser',
  'cdp_command'
])

export const CLAUDE_CODE_BROWSER_TOOLS = AGENT_TOOLS
  .filter((tool) => CLAUDE_CODE_BROWSER_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: tool.outputSchema
  }))

// Cursor already has native local repo/file/shell tools, so the attached Gladdis
// MCP surface stays focused on web/page work, conversation memory, and Gladdis's
// own bounded repo-intelligence helpers (which are NOT redundant with native
// grep — they return architecture-aware, token-capped digests). It deliberately
// omits raw FS/shell, which the CLI runtime supplies natively.
// Kept in parity with CODEX_BROWSER_TOOL_NAMES — see the surface-parity guard in
// toolSurfaceCoverage.test.ts.
export const CURSOR_MCP_TOOL_NAMES = new Set([
  'recall_history',
  'memory_write',
  'memory_read',
  'memory_list',
  'memory_forget',
  'memory_create_task',
  'search',
  'navigate',
  'read_page',
  'read_a11y',
  'grep_page',
  'watch_network',
  'screenshot',
  'screenshot_app',
  'act',
  'grep_click',
  'grep_type',
  'execute_in_browser',
  'cdp_command'
])

export function selectEmbeddedMcpToolNames(toolNames: Iterable<string>): ReadonlySet<string> {
  const allowed = new Set<string>()
  for (const name of toolNames) {
    if (CURSOR_MCP_TOOL_NAMES.has(name)) allowed.add(name)
  }
  return allowed
}

export const CURSOR_MCP_TOOLS = AGENT_TOOLS
  .filter((tool) => CURSOR_MCP_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: tool.outputSchema
  }))

const MEMORY_TOOL_NAMES = [
  'recall_history',
  'memory_write',
  'memory_read',
  'memory_list',
  'memory_forget',
  'memory_create_task'
] as const

const INTERACTION_TOOL_NAMES = [
  'navigate',
  'read_page',
  'read_a11y',
  'grep_page',
  'watch_network',
  'screenshot',
  'screenshot_app',
  'act',
  'grep_click',
  'grep_type',
  'execute_in_browser',
  'cdp_command'
] as const

function describeToolList(toolNames: Iterable<string>): string {
  const tools = [...new Set(toolNames)].sort()
  return tools.length > 0 ? tools.join(', ') : 'none'
}

function buildMemoryNotebookLine(allowed: ReadonlySet<string>): string | null {
  const parts: string[] = []
  if (allowed.has('memory_read')) parts.push('call memory_read before re-asking for context that may already be known')
  if (allowed.has('memory_write')) parts.push('use memory_write for durable decisions/constraints/identifiers')
  if (allowed.has('memory_list')) parts.push('use memory_list for a quick inventory')
  if (allowed.has('memory_create_task')) parts.push('use memory_create_task for task-specific notes')
  if (allowed.has('memory_forget')) parts.push('use memory_forget to clear stale notes when plans change')
  if (parts.length === 0) return null
  return `For longer or multi-step tasks, use the memory_* tools as a lightweight notebook: ${parts.join(', ')}. Store concise, reusable facts rather than large transcript dumps.`
}

function buildEmbeddedBrowserInstructions(args: {
  allowedToolNames?: Iterable<string>
  runtimeLabel: string
  nativeWorkLine: string
}): string {
  const allowed = new Set(args.allowedToolNames ?? CURSOR_MCP_TOOL_NAMES)
  const lines: string[] = [
    GLADDIS_WEB_TOOLS_RULE,
    `Attached Gladdis MCP tools this turn: ${describeToolList(allowed)}.`
  ]

  if (allowed.has('search')) {
    lines.push('Use `search` for live web lookup, and only pass `navigate_visible: true` when the user actually wants the result opened in the visible tab.')
  }

  const hasBrowserInteraction = INTERACTION_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasBrowserInteraction) {
    const browserTools = INTERACTION_TOOL_NAMES.filter((name) => allowed.has(name))
    lines.push(`For browser work beyond search, stay within the attached MCP tools: ${browserTools.join(', ')}.`)
  }

  if (allowed.has('act')) {
    lines.push(
      'act is the primary action verb (click | type | key | select) and returns a fresh `after` object with ' +
      '{url, title, readyState, activeElement, navigated, elements?}. Read that `after` object before deciding ' +
      'the next step instead of immediately re-reading the page.'
    )
  }

  if (allowed.has('grep_page')) {
    lines.push(
      '`grep_page` is SURGICAL, not exploratory: query a distinctive multi-word phrase pulled from what the user actually wants ' +
      '(for example "released on 14 March 2026" or "Pro plan $20 per user"), never a single common word like "price" or "date". ' +
      'If the first phrasing misses, run 2–3 variations of the same meaning rather than broadening. Use type "selector" only with a specific CSS selector or XPath; never with bare tag names.'
    )
  }

  if (allowed.has('act') && (allowed.has('read_a11y') || allowed.has('grep_page'))) {
    lines.push(
      'When `act` returns ok:false with "no visible element matched …", treat that as a re-orient signal: use one of the attached read tools ' +
      'such as `read_a11y` or `grep_page`, then target a fresh @ref or query instead of retrying the same action.'
    )
  }

  const hasMemoryTools = MEMORY_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasMemoryTools) {
    const notebookLine = buildMemoryNotebookLine(allowed)
    if (notebookLine) lines.push(notebookLine)
  }

  lines.push(
    `NEVER reach for a browser through ${args.runtimeLabel}'s native shell or any other path. Do not run google-chrome, chromium, chrome, ` +
    'xdg-open/open on a URL, playwright (screenshot/open/codegen/test/show-report), puppeteer scripts, or curl/wget against localhost:9222 DevTools — ' +
    `not even to "just take a screenshot" or check a dev server. These bypass Gladdis, hide the page from the user, and skip Gladdis's search. ` +
    'The attached Gladdis MCP tools are always the right tool for browsing.'
  )
  lines.push(
    'When debugging Gladdis itself, use the current visible app/browser first. Do not launch a second Gladdis/dev app unless you need startup/cold-boot/fresh-process validation, and say why first.'
  )
  lines.push(args.nativeWorkLine)

  return lines.join('\n')
}

export function buildClaudeCodeBrowserInstructions(allowedToolNames?: Iterable<string>): string {
  return buildEmbeddedBrowserInstructions({
    allowedToolNames,
    runtimeLabel: 'Claude Code',
    nativeWorkLine:
      "Keep Claude Code's native local repo, file, and shell abilities for code work; use the attached Gladdis MCP tools for browser work and Gladdis-specific context helpers."
  })
}

export const CLAUDE_CODE_BROWSER_INSTRUCTIONS = buildClaudeCodeBrowserInstructions(CLAUDE_CODE_BROWSER_TOOL_NAMES)

// Cursor Agent MCP browser contract. Cursor's bridge registers CURSOR_MCP_TOOLS,
// which includes the five memory_* notebook tools, so this prompt teaches that
// workflow too — otherwise those registered tools are unprompted dead weight
// the model never learns to call.
export function buildCursorBrowserInstructions(allowedToolNames?: Iterable<string>): string {
  return buildEmbeddedBrowserInstructions({
    allowedToolNames,
    runtimeLabel: 'Cursor Agent',
    nativeWorkLine:
      'Use Cursor native local repo, file, shell, and validation abilities for code work. After editing files, run the narrowest relevant local verification command before claiming success; if validation fails, fix it or say clearly why it cannot pass. If Gladdis feeds back a failed post-action verification result, treat that as actionable repair context, continue from the same workspace state, and do another validation pass before finishing. Use the attached Gladdis MCP tools for browser work.'
  })
}

export const CURSOR_BROWSER_INSTRUCTIONS = buildCursorBrowserInstructions(CURSOR_MCP_TOOL_NAMES)
