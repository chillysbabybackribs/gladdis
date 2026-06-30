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
  'read_a11y',
  'grep_page',
  'watch_network',
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
  'read_a11y',
  'grep_page',
  'watch_network',
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

export const CURSOR_MCP_TOOLS = AGENT_TOOLS
  .filter((tool) => CURSOR_MCP_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: tool.outputSchema
  }))

export const CLAUDE_CODE_BROWSER_INSTRUCTIONS =
  `${GLADDIS_WEB_TOOLS_RULE}\n` +
  'For browser work beyond search use the Gladdis MCP tools too: search_open, navigate, browse_task, read_page, read_a11y, grep_page, ' +
  'watch_network (read the JSON behind a page instead of scraping its HTML), ' +
  'grep_click, grep_type, execute_in_browser, screenshot, and screenshot_app. For Gladdis-native repo/context ' +
  'helpers use recall_history, memory_write, memory_read, memory_list, memory_forget, memory_create_task, repo_overview, ' +
  'repo_grep_task, search_repo, read_spans, research_dossier, and verify_change.\n' +
  'When reading code, start with search_repo or repo_grep_task; use read_spans only as the follow-up bounded read, and batch related windows into one read_spans({items:[...]}) call instead of a long chain of single-span reads.\n' +
  'For longer or multi-step tasks, use the memory_* tools as a lightweight notebook: call memory_read before re-asking for ' +
  'context that may already be known, use memory_write for durable decisions/constraints/identifiers, use memory_list for a ' +
  'quick inventory, use memory_create_task for task-specific notes, and use memory_forget to clear stale notes when plans change. ' +
  'Store concise, reusable facts rather than large transcript dumps.\n' +
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

// Cursor Agent MCP browser contract. Cursor's bridge registers CURSOR_MCP_TOOLS,
// which includes the five memory_* notebook tools, so this prompt teaches that
// workflow too — otherwise those registered tools are unprompted dead weight
// the model never learns to call.
export const CURSOR_BROWSER_INSTRUCTIONS =
  `${GLADDIS_WEB_TOOLS_RULE}\n` +
  'For browser work beyond search use the Gladdis MCP tools too: navigate, browse_task, read_page, read_a11y, grep_page, ' +
  'watch_network (read the JSON behind a page instead of scraping its HTML), ' +
  'grep_click, grep_type, execute_in_browser, screenshot, and screenshot_app. For Gladdis-native repo/context ' +
  'helpers use recall_history, memory_write, memory_read, memory_list, memory_forget, and memory_create_task.\n' +
  'For longer or multi-step tasks, use the memory_* tools as a lightweight notebook: call memory_read before re-asking for ' +
  'context that may already be known, use memory_write for durable decisions/constraints/identifiers, use memory_list for a ' +
  'quick inventory, use memory_create_task for task-specific notes, and use memory_forget to clear stale notes when plans change. ' +
  'Store concise, reusable facts rather than large transcript dumps.\n' +
  'Prefer grep_click/grep_type for direct discovery + action; drop to lower-level drive tools only when needed.\n' +
  'NEVER reach for a browser through Cursor Agent native shell or any other path. Do not run google-chrome, chromium, ' +
  'chrome, xdg-open/open on a URL, playwright (screenshot/open/codegen/test/show-report), puppeteer scripts, ' +
  'or curl/wget against localhost:9222 DevTools — not even to "just take a screenshot" or check a dev server. ' +
  'These bypass Gladdis, hide the page from the user, and skip Gladdis search. The Gladdis MCP tools ' +
  'are always the right tool; a native browser command is always wrong here.\n' +
  'When debugging Gladdis itself, use the current visible app/browser first. Do not launch a second Gladdis/dev ' +
  'app unless you need startup/cold-boot/fresh-process validation, and say why first.\n' +
  'Use Cursor native local repo, file, shell, and validation abilities for code work. After editing files, run the narrowest ' +
  'relevant local verification command before claiming success; if validation fails, fix it or say clearly why it cannot pass. ' +
  'If Gladdis feeds back a failed post-action verification result, treat that as actionable repair context, continue from the ' +
  'same workspace state, and do another validation pass before finishing. Use the Gladdis MCP tools for browser work.'
