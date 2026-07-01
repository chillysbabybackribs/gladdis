import { AGENT_TOOLS } from '../agentTools'
import {
  ACT_COMPANION_GUIDANCE,
  ACT_REORIENT_GUIDANCE,
  CODEX_BROWSER_TOOL_NAMES,
  CODEX_MEMORY_TOOL_NAMES,
  CODEX_INTERACTION_TOOL_NAMES,
  DISCOVER_DATA_SOURCES_GUIDANCE,
  EXTRACT_STRUCTURED_GUIDANCE,
  GLADDIS_DEBUGGING_GUIDANCE,
  GLADDIS_WEB_TOOLS_RULE,
  GREP_PAGE_GUIDANCE,
  NATIVE_BROWSER_PROHIBITION,
  TAB_BRIEF_CARRYING_TOOLS,
  TAB_GROUNDING_GUIDANCE,
  describeSemanticVerbPreference
} from '../codex/dynamicBrowserTools'
import { buildCursorNativeWorkContract } from '../codex/processPolicy'

export const CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME = 'gladdis'

export const CLAUDE_CODE_BROWSER_TOOL_NAMES = new Set(CODEX_BROWSER_TOOL_NAMES)

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
export const CURSOR_MCP_TOOL_NAMES = new Set(CODEX_BROWSER_TOOL_NAMES)

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

  const hasBrowserInteraction = CODEX_INTERACTION_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasBrowserInteraction) {
    const browserTools = CODEX_INTERACTION_TOOL_NAMES.filter((name) => allowed.has(name))
    lines.push(`For browser work beyond search, stay within the attached MCP tools: ${browserTools.join(', ')}.`)
  }

  const semanticVerbLine = describeSemanticVerbPreference(allowed)
  if (semanticVerbLine) {
    lines.push(semanticVerbLine
      .replace('inputs/textareas/selects', 'fields')
      .replace('form submission/search/send/save intent', 'search/send/save intent')
      .replace('result/card/headline', 'result'))
  }

  if (allowed.has('act')) {
    lines.push(ACT_COMPANION_GUIDANCE)
  }

  if (allowed.has('grep_page')) {
    lines.push(GREP_PAGE_GUIDANCE)
  }

  if (allowed.has('extract_structured')) {
    lines.push(EXTRACT_STRUCTURED_GUIDANCE)
  }

  if (allowed.has('discover_data_sources')) {
    lines.push(DISCOVER_DATA_SOURCES_GUIDANCE)
  }

  if (allowed.has('act') && (allowed.has('read_a11y') || allowed.has('grep_page'))) {
    lines.push(ACT_REORIENT_GUIDANCE)
  }

  if (TAB_BRIEF_CARRYING_TOOLS.some((name) => allowed.has(name))) {
    lines.push(TAB_GROUNDING_GUIDANCE)
  }

  const hasMemoryTools = CODEX_MEMORY_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasMemoryTools) {
    const notebookLine = buildMemoryNotebookLine(allowed)
    if (notebookLine) lines.push(notebookLine)
  }

  lines.push(NATIVE_BROWSER_PROHIBITION)
  lines.push(GLADDIS_DEBUGGING_GUIDANCE.replace('Do not launch a second Gladdis/dev app.', 'Do not launch a second Gladdis/dev app unless you need startup/cold-boot/fresh-process validation, and say why first.'))
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
    nativeWorkLine: buildCursorNativeWorkContract({ includeBrowserWorkLine: true })
  })
}

export const CURSOR_BROWSER_INSTRUCTIONS = buildCursorBrowserInstructions(CURSOR_MCP_TOOL_NAMES)
