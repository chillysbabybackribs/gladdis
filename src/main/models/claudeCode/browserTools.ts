import { AGENT_TOOLS } from '../agentTools'
import { GLADDIS_WEB_TOOLS_RULE } from '../codex/dynamicBrowserTools'

export const CLAUDE_CODE_BROWSER_TOOL_NAMES = new Set([
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

export const CLAUDE_CODE_BROWSER_TOOLS = AGENT_TOOLS
  .filter((tool) => CLAUDE_CODE_BROWSER_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters
  }))

export const CLAUDE_CODE_BROWSER_INSTRUCTIONS =
  `${GLADDIS_WEB_TOOLS_RULE}\n` +
  'For browser work use the Gladdis MCP tools: search, deep_search, fetch_page, navigate, browse_task, ' +
  'read_page, grep_page, grep_click, grep_type, screenshot, screenshot_app, click_xy, type_text, ' +
  'press_key, execute_in_browser, and cdp_command.\n' +
  'These act on the visible Gladdis browser tab the user is watching, so always prefer them over native ' +
  'web tools or external browsers.\n' +
  'Start with read_page or grep_page before acting. Prefer grep_click and grep_type for direct discovery ' +
  '+ action, and use browse_task for multi-step browser workflows.\n' +
  'Keep Claude Code\'s native local repo, file, and shell abilities for code work; use the Gladdis MCP ' +
  'tools only for browser/web actions.'
