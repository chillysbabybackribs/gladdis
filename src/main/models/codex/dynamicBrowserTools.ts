import { AGENT_TOOLS } from '../agentTools'
import type { BrowserTools, ToolContext, ToolOutcome } from '../browserTools'
import type { LlmComplete } from '../../pipeline/Planner'
import type { ChatStreamEvent } from '../../../../shared/types'
import type { JsonValue, RequestId, ServerRequest } from './protocol'

export const CODEX_BROWSER_TOOL_NAMES = new Set([
  'recall_history',
  'search',
  'fetch_page',
  'navigate',
  'background_web_search',
  'browse_task',
  'read_page',
  'screenshot',
  'screenshot_app'
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
  'All browser and web work goes through the gladdis.* tools, which drive the visible tab the ' +
  'user is watching: gladdis.search (hidden web lookup), gladdis.fetch_page/gladdis.navigate ' +
  '(open a URL in the visible tab), gladdis.background_web_search (off-screen breadth, visible tab ' +
  'unchanged — pair it with fetch_page or navigate so the user still sees the page), gladdis.browse_task ' +
  '(multi-step flows), gladdis.read_page, and gladdis.screenshot/screenshot_app. ' +
  'When debugging Gladdis itself, use the current visible app/browser first; do not launch a second ' +
  'Gladdis/dev app just to view UI or browser behavior. Only launch a separate instance for startup ' +
  'or fresh-process validation, and explain why before doing it. ' +
  'Keep using Codex native shell/file tools for local code work.'

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
  const tabId = args.tools.tabs.activeTabId || args.tools.tabs.create().id
  const ctx: ToolContext = {
    tabId,
    conversationId: args.conversationId ?? undefined,
    llm: args.llm ?? undefined,
    fullResults: new Map()
  }
  const outcome = await args.tools.run(tool, toolArgs, ctx)
  args.respond(args.msg.id, codexDynamicToolResponse(outcome))
  if (args.requestId) {
    args.emit({ requestId: args.requestId, type: 'tool_result', callId, ok: outcome.ok, preview: outcome.text.slice(0, 200) })
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
