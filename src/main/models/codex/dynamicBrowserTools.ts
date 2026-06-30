import { AGENT_TOOLS } from '../agentTools'
import type { BrowserTools, ToolContext, ToolOutcome } from '../browserTools'
import type { LlmComplete } from '../../pipeline/Planner'
import type { ChatStreamEvent } from '../../../../shared/types'
import type { JsonValue, RequestId, ServerRequest } from './protocol'

export const CODEX_BROWSER_TOOL_NAMES = new Set([
  'recall_history',
  'repo_overview',
  'search_repo',
  'repo_grep_task',
  'read_spans',
  'research_dossier',
  'verify_change',
  'search',
  'search_open',
  'deep_search',
  'fetch_page',
  'navigate',
  'browse_task',
  'read_page',
  'grep_page',
  'grep_click',
  'grep_type',
  'screenshot',
  'screenshot_app',
  'click_xy',
  'type_text',
  'press_key',
  'execute_in_browser',
  'cdp_command'
])

export const CODEX_BROWSER_TOOLS = AGENT_TOOLS
  .filter((tool) => CODEX_BROWSER_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    namespace: 'gladdis',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as JsonValue,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as unknown as JsonValue } : {})
  })) as JsonValue[]

// The single source of truth — for EVERY provider, not just Codex — for the hard
// rule that web/search work goes through Gladdis's own tools, never the model's
// built-in/native web search or grounding. Direct providers (Gemini, OpenAI,
// Anthropic, Grok) get this via prompts.ts (BROWSER_OVERVIEW); Codex composes it
// with its own shell-specific lines below. Worded as a binding rule because a
// soft "prefer" nudge let Gemini fall back to its native search.
export const GLADDIS_WEB_TOOLS_RULE =
  'WEB SEARCH RULE — binding, not a preference: every web/search action goes through Gladdis\'s own ' +
  'tools, which drive the visible Chromium tab the user is watching. Use search and deep_search for web ' +
  'search (the user sees the results in-tab), use search_open when you have both a search query and a likely direct URL to check in parallel, and use fetch_page to read a known URL. ' +
  'You do NOT have a working built-in/native web search or grounding here: it is disabled and its results ' +
  'do not reach the user. Treat any urge to "search the web" or answer a current/dated/online question ' +
  'from your own knowledge as a signal to call search instead. Never answer a question that needs live web ' +
  'facts from memory, and never claim you cannot search — the search tool is always available for that. ' +
  'Gladdis\'s search is the only web search that exists for this turn.'

// The single source of truth for how Codex is told to do web/browser work.
// Injected into CODEX_SYSTEM (see prompts.ts) so it actually reaches the model
// on every turn. Native web search is already disabled via config; the trap
// this closes is Codex reaching for a browser through its NATIVE SHELL tool
// (which stays on for code work) during "visual validation" — hence the
// explicit "even via your shell" line.
export const CODEX_BROWSER_INSTRUCTIONS =
  `${GLADDIS_WEB_TOOLS_RULE}\n` +
  'For browser work beyond search use the gladdis.* tools too: navigate, browse_task, read_page, grep_page, ' +
  'grep_click, grep_type, execute_in_browser, screenshot, and screenshot_app. For repo intel use ' +
  'recall_history, repo_overview, repo_grep_task, search_repo, read_spans, research_dossier, and verify_change. ' +
  'Prefer grep_click/grep_type for direct discovery + action; drop to lower-level drive tools only when needed.\n' +
  'NEVER reach for a browser through your native shell or any other path. Do not run google-chrome, chromium, ' +
  'chrome, xdg-open/open on a URL, playwright (screenshot/open/codegen/test/show-report), puppeteer scripts, ' +
  'or curl/wget against localhost:9222 DevTools — not even to "just take a screenshot" or check a dev server. ' +
  'These bypass Gladdis, hide the page from the user, and skip Gladdis\'s superior search. The gladdis.* tools ' +
  'are always the right tool; a native browser command is always wrong here.\n' +
  'When debugging Gladdis itself, use the current visible app/browser first. Do not launch a second Gladdis/dev ' +
  'app. Launch a separate instance only for startup/cold-boot/fresh-process validation, and say why first.\n' +
  'Use Codex-native shell/file tools for local code, package, and command work — just never for browsing.'

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
  emit: (e: ChatStreamEvent) => void
}): Promise<void> {
  const params = record(args.msg.params)
  const namespace = str(params.namespace)
  const tool = str(params.tool)
  const toolArgs = record(params.arguments)
  const callId = str(params.itemId) || `codex-dynamic-${String(args.msg.id)}`
  if (namespace !== 'gladdis' || !CODEX_BROWSER_TOOL_NAMES.has(tool)) {
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
