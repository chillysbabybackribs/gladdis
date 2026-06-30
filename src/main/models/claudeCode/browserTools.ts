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
  'repo_overview',
  'search_repo',
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

export const CLAUDE_CODE_BROWSER_TOOLS = AGENT_TOOLS
  .filter((tool) => CLAUDE_CODE_BROWSER_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: tool.outputSchema
  }))

export const CLAUDE_CODE_BROWSER_INSTRUCTIONS =
  `${GLADDIS_WEB_TOOLS_RULE}\n` +
  'For browser work beyond search use the Gladdis MCP tools too: search_open, navigate, browse_task, read_page, grep_page, ' +
  'grep_click, grep_type, execute_in_browser, screenshot, and screenshot_app. For Gladdis-native repo/context ' +
  'helpers use recall_history, memory_write, memory_read, memory_list, memory_forget, memory_create_task, repo_overview, ' +
  'search_repo, read_spans, research_dossier, and verify_change.\n' +
  'Prefer grep_click and grep_type for direct discovery + action; drop to lower-level drive tools only when needed.\n' +
  'NEVER reach for a browser through Claude Code\'s native shell or any other path. Do not run google-chrome, ' +
  'chromium, chrome, xdg-open/open on a URL, playwright (screenshot/open/codegen/test/show-report), puppeteer ' +
  'scripts, or curl/wget against localhost:9222 DevTools — not even to "just take a screenshot" or check a dev ' +
  'server. These bypass Gladdis, hide the page from the user, and skip Gladdis\'s search. The Gladdis MCP tools ' +
  'are always the right tool; a native browser command is always wrong here.\n' +
  'When debugging Gladdis itself, use the current visible app/browser first. Do not launch a second Gladdis/dev ' +
  'app unless you need startup/cold-boot/fresh-process validation, and say why first.\n' +
  'Keep Claude Code\'s native local repo, file, and shell abilities for code work; use the Gladdis MCP tools ' +
  'for browser work and Gladdis-specific context helpers.'
