import { AGENT_TOOLS } from '../agentTools'
import type { BrowserTools, ToolContext, ToolOutcome } from '../browserTools'
import type { LlmComplete } from '../llm'
import type { ChatStreamEvent } from '../../../../shared/types'
import type { JsonValue, RequestId, ServerRequest } from './protocol'

// Codex keeps its native FS/shell for code work, so this surface omits raw
// filesystem/shell tools. It DOES include Gladdis's memory notebook: Codex's own
// cross-session memory is disabled (see CODEX_DISABLED_NATIVE_CONFIG) so that the
// only durable memory channel is Gladdis's — which requires the memory_* writers
// to actually be attached. Kept in parity with CURSOR_MCP_TOOL_NAMES — see the
// surface-parity guard in toolSurfaceCoverage.test.ts.
export const CODEX_BROWSER_TOOL_NAMES = new Set([
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

export function selectCodexDynamicToolNames(toolNames: Iterable<string>): ReadonlySet<string> {
  const allowed = new Set<string>()
  for (const name of toolNames) {
    if (CODEX_BROWSER_TOOL_NAMES.has(name)) allowed.add(name)
  }
  return allowed
}

export function buildCodexBrowserTools(allowedToolNames?: Iterable<string>): JsonValue[] {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : CODEX_BROWSER_TOOL_NAMES
  return AGENT_TOOLS
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      namespace: 'gladdis',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as unknown as JsonValue,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as unknown as JsonValue } : {})
    })) as JsonValue[]
}

export const CODEX_BROWSER_TOOLS = buildCodexBrowserTools(CODEX_BROWSER_TOOL_NAMES)

// The single source of truth — for EVERY provider, not just Codex — for the hard
// rule that web/search work goes through Gladdis's own tools, never the model's
// built-in/native web search or grounding. Direct providers (Gemini, OpenAI,
// Anthropic, Grok) get this via prompts.ts (BROWSER_OVERVIEW); Codex composes it
// with its own shell-specific lines below. Worded as a binding rule because a
// soft "prefer" nudge let Gemini fall back to its native search.
export const GLADDIS_WEB_TOOLS_RULE =
  'WEB SEARCH RULE — binding, not a preference: every web/search action goes through Gladdis\'s own ' +
  'tools, which drive the visible Chromium tab the user is watching. Use search for web ' +
  'search (the user sees the results in-tab; pass navigate_visible: true to also open the best hit), and use navigate to load a known URL then grep_page to read it. ' +
  'You do NOT have a working built-in/native web search or grounding here: it is disabled and its results ' +
  'do not reach the user. If your runtime exposes a native search/fetch tool anyway, such as WebSearch, ' +
  'WebFetch, web_search, web_fetch, browser_search, or browser_fetch, do not call it; it is outside the ' +
  'Gladdis contract for this turn. Treat any urge to "search the web" or answer a current/dated/online question ' +
  'from your own knowledge as a signal to call search instead. Never answer a question that needs live web ' +
  'facts from memory, and never claim you cannot search — the search tool is always available for that. ' +
  'Gladdis\'s search is the only web search that exists for this turn.'

const CODEX_MEMORY_TOOL_NAMES = [
  'recall_history',
  'memory_write',
  'memory_read',
  'memory_list',
  'memory_forget',
  'memory_create_task'
] as const

const CODEX_INTERACTION_TOOL_NAMES = [
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
  if (allowed.has('memory_read')) parts.push('memory_read before re-asking for context that may already be known')
  if (allowed.has('memory_write')) parts.push('memory_write for durable decisions/constraints/identifiers')
  if (allowed.has('memory_list')) parts.push('memory_list for a quick inventory')
  if (allowed.has('memory_create_task')) parts.push('memory_create_task for task-specific notes')
  if (allowed.has('memory_forget')) parts.push('memory_forget to clear stale notes')
  if (parts.length === 0) return null
  return `For longer or multi-step tasks, use the memory_* notebook tools (your native cross-session memory is disabled here, so this is the only durable channel): ${parts.join(', ')}. Store concise, reusable facts rather than large transcript dumps.`
}

// The single source of truth for how Codex is told to do web/browser work.
// Injected into CODEX_SYSTEM (see prompts.ts) so it actually reaches the model
// on every turn. Native web search is already disabled via config; the trap
// this closes is Codex reaching for a browser through its NATIVE SHELL tool
// (which stays on for code work) during "visual validation" — hence the
// explicit "even via your shell" line.
export function buildCodexBrowserInstructions(allowedToolNames?: Iterable<string>): string {
  const allowed = new Set(allowedToolNames ?? CODEX_BROWSER_TOOL_NAMES)
  const lines: string[] = [
    GLADDIS_WEB_TOOLS_RULE,
    `Attached Gladdis tools this turn: ${describeToolList(allowed)}.`
  ]

  if (allowed.has('search')) {
    lines.push('Use `search` for live web lookup, and use `navigate` to load a known URL in the visible tab when you already know where to go.')
  }

  const hasBrowserInteraction = CODEX_INTERACTION_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasBrowserInteraction) {
    const browserTools = CODEX_INTERACTION_TOOL_NAMES.filter((name) => allowed.has(name))
    lines.push(`For browser work beyond search use the attached gladdis.* tools: ${browserTools.join(', ')}.`)
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
      '(for example "Pro plan $20 per user" or "released on 14 March 2026"), never a single common word like "price" or "date". ' +
      'If the first phrasing misses, run 2–3 variations of the same meaning rather than broadening. Use type "selector" only with a specific CSS selector or XPath; never with bare tag names.'
    )
  }

  if (allowed.has('act') && (allowed.has('read_a11y') || allowed.has('grep_page'))) {
    lines.push(
      'When `act` returns ok:false with "no visible element matched …", treat that as a re-orient signal: use one of the attached read tools ' +
      'such as `read_a11y` or `grep_page`, then target a fresh @ref or query instead of retrying the same action.'
    )
  }

  const hasMemoryTools = CODEX_MEMORY_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasMemoryTools) {
    const notebookLine = buildMemoryNotebookLine(allowed)
    if (notebookLine) lines.push(notebookLine)
  }

  lines.push(
    'NEVER reach for a browser through your native shell or any other path. Do not run google-chrome, chromium, chrome, xdg-open/open on a URL, playwright (screenshot/open/codegen/test/show-report), ' +
    'puppeteer scripts, or curl/wget against localhost:9222 DevTools — not even to "just take a screenshot" or check a dev server. These bypass Gladdis, hide the page from the user, and skip Gladdis\'s superior search. The attached gladdis.* tools are always the right tool; a native browser command is always wrong here.'
  )
  lines.push(
    'When debugging Gladdis itself, use the current visible app/browser first. Do not launch a second Gladdis/dev app. Launch a separate instance only for startup/cold-boot/fresh-process validation, and say why first.'
  )
  lines.push('Use Codex-native shell and file tools for local code, package, and command work — just never for browsing.')

  return lines.join('\n')
}

export const CODEX_BROWSER_INSTRUCTIONS = buildCodexBrowserInstructions(CODEX_BROWSER_TOOL_NAMES)

export const CODEX_DISABLED_NATIVE_CONFIG = {
  web_search: 'disabled',
  features: {
    standalone_web_search: false,
    web_search_request: false,
    web_search_cached: false,
    search_tool: false,
    in_app_browser: false,
    browser_use: false,
    browser_use_external: false,
    computer_use: false
  },
  // Gladdis owns conversation memory (recall_history over its own ChatStore).
  // Codex's native cross-session memory reads/writes the shared ~/.codex store,
  // so a fresh in-app "let's continue" could otherwise surface the user's
  // terminal Codex sessions. Disable Codex's own memory + history persistence so
  // the only memory channel is gladdis's. (Auth stays in ~/.codex, untouched.)
  memories: {
    use_memories: false,
    generate_memories: false
  },
  history: {
    persistence: 'none'
  }
}

export function codexDynamicToolResponse(outcome: ToolOutcome): {
  contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>
  success: boolean
} {
  const textPayload: Record<string, unknown> = { ok: outcome.ok, text: outcome.text }
  // Codex only consumes the text channel, so fold the structured payload into it.
  // Without this, structuredContent-only data (search results/digests, network
  // telemetry, memory indices, grep matches) is invisible to Codex. Tools that
  // also put their digest in `text` will repeat it here, but the digest is
  // already bounded by digestPage, and Codex being blind to the data is worse.
  if (outcome.structuredContent !== undefined) {
    textPayload.structuredContent = outcome.structuredContent
  }
  const contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }> = [
    { type: 'inputText', text: JSON.stringify(textPayload) }
  ]
  if (outcome.imageBase64) {
    contentItems.push({ type: 'inputImage', imageUrl: `data:image/png;base64,${outcome.imageBase64}` })
  }
  return { contentItems, success: outcome.ok }
}

export async function respondToCodexBrowserToolCall(args: {
  msg: ServerRequest
  respond: (id: RequestId, result: unknown) => void
  tools: BrowserTools
  llm?: LlmComplete | null
  conversationId?: string | null
  requestId?: string
  allowedToolNames?: ReadonlySet<string>
  emit: (e: ChatStreamEvent) => void
}): Promise<void> {
  const params = record(args.msg.params)
  const namespace = str(params.namespace)
  const tool = str(params.tool)
  const toolArgs = record(params.arguments)
  const callId = str(params.itemId) || `codex-dynamic-${String(args.msg.id)}`
  const allowedToolNames = args.allowedToolNames ?? CODEX_BROWSER_TOOL_NAMES
  if (namespace !== 'gladdis' || !allowedToolNames.has(tool)) {
    args.respond(args.msg.id, codexDynamicToolResponse({ ok: false, text: `Unsupported Gladdis browser tool: ${namespace}.${tool}` }))
    return
  }
  if (args.requestId) args.emit({ requestId: args.requestId, type: 'tool_call', tool: `gladdis.${tool}`, args: toolArgs, callId })
  const tabsApi = args.tools.tabs as { liveTabId?: (id?: string | null) => string; activeTabId?: string | null; create: () => { id: string } }
  const tabId = typeof tabsApi.liveTabId === 'function' ? tabsApi.liveTabId() : tabsApi.activeTabId || tabsApi.create().id
  const ctx: ToolContext = {
    tabId,
    requestId: args.requestId,
    conversationId: args.conversationId ?? undefined,
    llm: args.llm ?? undefined,
    taskId: args.conversationId ?? undefined,
    fullResults: new Map(),
    onProgress: args.requestId
      ? (event) =>
          args.emit({
            requestId: args.requestId!,
            type: 'progress_step',
            ...event
          })
      : undefined
  }
  const outcome = await args.tools.run(tool, toolArgs, ctx)
  args.respond(args.msg.id, codexDynamicToolResponse(outcome))
  if (args.requestId) {
    args.emit({
      requestId: args.requestId,
      type: 'tool_result',
      callId,
      ok: outcome.ok,
      preview: outcome.text,
      imageDataUrl: outcome.imageBase64 ? `data:image/png;base64,${outcome.imageBase64}` : undefined
    })
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
