import { AGENT_TOOLS } from '../agentTools'
import type { BrowserTools, ToolContext, ToolOutcome } from '../browserTools'
import type { LlmComplete } from '../../pipeline/Planner'
import type { ChatStreamEvent } from '../../../../shared/types'
import type { JsonValue, RequestId, ServerRequest } from './protocol'

export const CODEX_BROWSER_TOOL_NAMES = new Set([
  'recall_history',
  'repo_overview',
  'search_repo',
  'read_spans',
  'research_dossier',
  'verify_change',
  'search',
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
    inputSchema: tool.parameters as unknown as JsonValue
  })) as JsonValue[]

export const CODEX_BROWSER_INSTRUCTIONS =
  'Use gladdis.* tools for web, browser, and repo-intel work on the visible tab: search, deep_search, repo_overview, search_repo, read_spans, research_dossier, verify_change, fetch_page, navigate, browse_task, read_page, grep_page, grep_click, grep_type, execute_in_browser, screenshot, and screenshot_app. ' +
  'Never run external browser commands for viewing or visual checks: google-chrome, chromium, chrome, xdg-open/open URLs, playwright screenshot/open/codegen/test/show-report, puppeteer scripts, or localhost:9222 DevTools probing. These are blocked because they bypass Gladdis and interrupt the turn. ' +
  'Prefer grep_click/grep_type for direct discovery + action; use lower-level drive tools only if needed. ' +
  'For Gladdis debugging, use the current visible app/browser first. do not launch a second Gladdis/dev app. Launch only for startup/fresh-process validation and explain why. ' +
  'Use Codex-native shell/file tools for local code work.'

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
