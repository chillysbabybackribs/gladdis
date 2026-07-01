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
  'wait_for_load',
  'read_a11y',
  'grep_page',
  'diagnose_target',
  'extract_structured',
  'discover_data_sources',
  'watch_network',
  'screenshot',
  'screenshot_app',
  'set_field',
  'submit',
  'open_result',
  'act',
  'grep_click',
  'grep_type',
  'execute_in_browser',
  'cdp_command'
])

/**
 * The perception + drive verbs whose result carries the tab-grounding brief
 * (current tab id/index/count + live load state). Narrower than
 * CODEX_BROWSER_TOOL_NAMES: excludes memory, `search` (background web lookup
 * that leaves the visible tab unchanged), and `screenshot_app` (app self-image,
 * not a tab op). Single source of truth for both the runtime brief injection
 * (browserTools.ts) and the prompt gate below.
 */
export const TAB_BRIEF_CARRYING_TOOLS = [
  'read_page', 'wait_for_load', 'read_a11y', 'grep_page', 'diagnose_target', 'extract_structured',
  'watch_network', 'discover_data_sources', 'screenshot',
  'act', 'set_field', 'submit', 'open_result', 'execute_in_browser', 'navigate',
  'cdp_command', 'grep_click', 'grep_type'
] as const

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
  'WEB WORK — live tab is primary, shell is a background helper: the visible Chromium tab is the UX-mandatory ' +
  'surface for anything the user is meant to watch happen — live navigation, opening a result, filling and ' +
  'submitting a form, on-screen verification. Drive it with search (the user sees results in-tab; pass ' +
  'navigate_visible: true to open the best hit), navigate to load a known URL, then grep_page/read_a11y to read ' +
  'it. Shell/native commands are ALSO available for web work and are a first-class path for fetching data the ' +
  'user does not need to watch render — curl or a CLI hitting a page or JSON/GraphQL endpoint directly is fine, ' +
  'and often better than driving a flaky page. The one hard rule: shell must never SUPERSEDE live browser ' +
  'navigation. When the task is show/drive/verify-in-the-browser, the visible tab is required and shell runs ' +
  'alongside it in the background, never instead of it; when the task is just get-this-data, shell is free to ' +
  'fetch it directly. Never answer a question that needs live web facts from memory — search or fetch it. ' +
  'The attached browser tools ARE interactive control of that visible tab, usable right now: if your next step ' +
  'is a browser interaction (click a date grid, open a result, expand a filter, click through to another site), ' +
  'that interaction is the next action — do it this turn. Do not defer it to a hypothetical future turn or ask ' +
  'whether an interactive browser surface will be available later; if these tools are attached, it already is.'

export const BROWSER_SEMANTIC_VERBS_GUIDANCE = 'Prefer the semantic browser verbs when they fit'

export const ACT_COMPANION_GUIDANCE =
  '`act` is a companion action tool (click | type | key | select), not the orientation tool. Use `navigate`, `grep_page`, or `read_a11y` first to identify the target, then prefer `set_field`, `submit`, or `open_result` when they fit before dropping to `act`. ' +
  'Its `type` mode inserts the provided text in one shot, not letter-by-letter, and it returns a fresh `after` object with ' +
  '{url, title, readyState, activeElement, navigated, elements?}. Read that `after` object before deciding the next step instead of immediately re-reading the page. ' +
  'When the very next step after loading a page is an obvious action on it, you can fuse them: pass `navigate` (a URL) to act, which loads that page, waits for it to settle, then acts on it in one call — target by `query`/`coords` only (a @ref cannot predate the load). It fails safe: a failed load or an unfound target returns ok:false with the landed URL, never a guess-click.'

export const GREP_PAGE_GUIDANCE =
  '`grep_page` is SURGICAL, not exploratory: extract the subject from the user request and query 1–3 tight multi-word phrase variations ' +
  '(for example "Pro plan $20 per user" or "released on 14 March 2026"), never the whole prompt and never a single common word like "price" or "date". ' +
  'If the first phrasing misses, run 2–3 variations of the same meaning rather than broadening. The wording does not need to match exactly; if the same terms appear close together or clearly in the same section, inspect that section. Use type "selector" only with a specific CSS selector or XPath; never with bare tag names.'

export const EXTRACT_STRUCTURED_GUIDANCE =
  '`extract_structured` is for repeated DOM records, not exploration: use it for tables, cards, feed items, comments, or search results once you know the repeated row selector. ' +
  'Pass one specific `item_selector`/`item_xpath` and a small `fields` map. Avoid broad selectors like `div`, and prefer this over many repeated `grep_page` calls when you need multiple same-shaped records.'

export const DISCOVER_DATA_SOURCES_GUIDANCE =
  '`discover_data_sources` is the early network-intelligence pass: use it when repeated records may come from APIs. It classifies the page as server-rendered, API-backed, or mixed, ranks candidate JSON/GraphQL endpoints, and tells you whether to stay in the DOM or pivot to network capture.'

export const DIAGNOSE_TARGET_GUIDANCE =
  '`diagnose_target` explains WHY a click/type is not landing on hard interactive pages (booking widgets, custom date pickers, typeaheads, modals) — reach for it when an action seemed to do nothing instead of blindly retrying or brute-forcing coordinates. ' +
  'Give it a read_a11y @ref (best — it carries the owning frame), a `query`, or `coords`, and it hit-tests the point ACROSS FRAMES and reports the real blocker: an overlay is on top, the control is disabled by validation, pointer-events:none, inert behind a modal, offscreen, in a (cross-origin) iframe, or a visible fake control over a hidden real input that must be committed by selecting a suggestion. It is read-only — resolve the reason it gives, then act.'

export const ACT_REORIENT_GUIDANCE =
  'When `act` returns ok:false with "no visible element matched …", treat that as a re-orient signal: use one of the attached read tools ' +
  'such as `read_a11y` or `grep_page`, then target a fresh @ref or query instead of retrying the same action.'

export const TAB_GROUNDING_GUIDANCE =
  'TAB GROUNDING — every browser tool result ends with a "[tab N/M] <url>" line and carries a structured `tab` ' +
  '{id, index, count, url, title, loading, loadingMs, slowLoad}. Read it to know WHICH tab you are on (index of ' +
  'count) and whether it is still loading. If `loading` is true the page is not settled — its text/wireframe may ' +
  'be a half-rendered shell, so do not conclude "empty" or act on missing content yet. If `slowLoad` is true (or ' +
  'the line says LOADING LONGER THAN NORMAL) the tab has been loading past the healthy threshold: call ' +
  'wait_for_load, or re-navigate/report the stall, instead of retrying blindly. When `count` > 1 or the tab ' +
  'index/url changes unexpectedly (a click or window.open spawned or switched tabs), re-orient on the tab you are ' +
  'actually on before targeting anything.'

export const NATIVE_BROWSER_PROHIBITION =
  'Shell is a background tool, not a replacement for the visible tab. Do NOT drive a SEPARATE browser through the ' +
  'shell for work the user should watch — spinning up google-chrome/chromium, playwright/puppeteer sessions, or ' +
  'headless navigation runs the page where the user cannot see it, which defeats the point of the visible panel. ' +
  'For anything the user is meant to see (navigating, clicking, filling forms, on-screen checks) use the attached ' +
  'browser tools that act on the visible tab. Shell is still fully welcome in the background for fetching data ' +
  '(curl/CLI against a URL or API), scraping response bodies, or any web work whose result — not its rendering — ' +
  'is what matters. Rule of thumb: if the user should watch it happen, drive the visible tab; if you just need the ' +
  'bytes, shell is free to fetch them.'

export const GLADDIS_DEBUGGING_GUIDANCE =
  'When debugging Gladdis itself, use the current visible app/browser first. Do not launch a second Gladdis/dev app. Launch a separate instance only for startup/cold-boot/fresh-process validation, and say why first.'

export const CODEX_MEMORY_TOOL_NAMES = [
  'recall_history',
  'memory_write',
  'memory_read',
  'memory_list',
  'memory_forget',
  'memory_create_task'
] as const

export const CODEX_INTERACTION_TOOL_NAMES = [
  'navigate',
  'read_page',
  'wait_for_load',
  'read_a11y',
  'grep_page',
  'extract_structured',
  'discover_data_sources',
  'watch_network',
  'screenshot',
  'screenshot_app',
  'set_field',
  'submit',
  'open_result',
  'act',
  'grep_click',
  'grep_type',
  'execute_in_browser',
  'cdp_command'
] as const

export const BROWSER_TOOL_CATEGORY_ORDER = [
  'memory',
  'discovery',
  'orientation',
  'targeting',
  'structured-data',
  'network-intelligence',
  'semantic-actions',
  'advanced-actions',
  'visual-fallback'
] as const

export type BrowserToolCategory = (typeof BROWSER_TOOL_CATEGORY_ORDER)[number]

const BROWSER_TOOL_CATEGORY_LABELS: Record<BrowserToolCategory, string> = {
  memory: 'memory notebook',
  discovery: 'web discovery',
  orientation: 'page orientation',
  targeting: 'precise targeting',
  'structured-data': 'structured extraction',
  'network-intelligence': 'network/data discovery',
  'semantic-actions': 'semantic actions',
  'advanced-actions': 'advanced browser control',
  'visual-fallback': 'visual fallback'
}

const BROWSER_TOOL_CATEGORY_CAPABILITIES: Record<BrowserToolCategory, string> = {
  memory: 'recover context and keep task state',
  discovery: 'find live web sources or open known URLs',
  orientation: 'understand the visible page before acting',
  targeting: 'pinpoint the exact control or text to use',
  'structured-data': 'extract repeated records into fields',
  'network-intelligence': 'inspect API-backed pages and fetched data',
  'semantic-actions': 'fill, submit, and open results at the intent level',
  'advanced-actions': 'drive complex widgets or raw browser internals when needed',
  'visual-fallback': 'inspect pixel-only or unlabeled UI as a last resort'
}

const BROWSER_TOOL_CATEGORY_MEMBERS: Record<BrowserToolCategory, readonly string[]> = {
  memory: CODEX_MEMORY_TOOL_NAMES,
  discovery: ['search', 'navigate'],
  orientation: ['read_page', 'wait_for_load', 'read_a11y', 'diagnose_target'],
  targeting: ['grep_page'],
  'structured-data': ['extract_structured'],
  'network-intelligence': ['discover_data_sources', 'watch_network'],
  'semantic-actions': ['set_field', 'submit', 'open_result'],
  'advanced-actions': ['act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command'],
  'visual-fallback': ['screenshot', 'screenshot_app']
}

export function categorizeBrowserTools(toolNames: Iterable<string>): Array<{
  category: BrowserToolCategory
  label: string
  capability: string
  tools: string[]
}> {
  const allowed = new Set(toolNames)
  return BROWSER_TOOL_CATEGORY_ORDER
    .map((category) => {
      const tools = BROWSER_TOOL_CATEGORY_MEMBERS[category].filter((name) => allowed.has(name))
      if (tools.length === 0) return null
      return {
        category,
        label: BROWSER_TOOL_CATEGORY_LABELS[category],
        capability: BROWSER_TOOL_CATEGORY_CAPABILITIES[category],
        tools
      }
    })
    .filter((entry): entry is {
      category: BrowserToolCategory
      label: string
      capability: string
      tools: string[]
    } => entry != null)
}

export function summarizeBrowserToolCategories(toolNames: Iterable<string>): string | null {
  const categories = categorizeBrowserTools(toolNames)
  if (categories.length === 0) return null
  return categories
    .map(({ label, capability, tools }) => `${label} (${capability}): ${tools.join(', ')}`)
    .join(' | ')
}

export interface BrowserToolRegistryEntry {
  name: string
  category: BrowserToolCategory
  label: string
  capability: string
  domains: string[]
  capabilities: string[]
  whenToUse: string
  prerequisites: string[]
}

export interface BrowserToolDiscoveryQuery {
  query?: string
  categories?: BrowserToolCategory[]
  domains?: string[]
  names?: string[]
}

export interface BrowserToolDiscoveryMatch extends BrowserToolRegistryEntry {
  score: number
  reasons: string[]
}

const BROWSER_TOOL_CATEGORY_BY_NAME: Record<string, BrowserToolCategory> = Object.fromEntries(
  Object.entries(BROWSER_TOOL_CATEGORY_MEMBERS).flatMap(([category, names]) =>
    names.map((name) => [name, category as BrowserToolCategory])
  )
)

export const BROWSER_TOOL_REGISTRY: BrowserToolRegistryEntry[] = [...CODEX_BROWSER_TOOL_NAMES].map((name) => {
  const category = BROWSER_TOOL_CATEGORY_BY_NAME[name] ?? 'advanced-actions'
  return {
    name,
    category,
    label: BROWSER_TOOL_CATEGORY_LABELS[category],
    capability: BROWSER_TOOL_CATEGORY_CAPABILITIES[category],
    domains: inferBrowserToolDomains(name),
    capabilities: inferBrowserToolCapabilities(name),
    whenToUse: inferBrowserToolWhenToUse(name),
    prerequisites: inferBrowserToolPrerequisites(name)
  }
})

export function discoverBrowserTools(query: BrowserToolDiscoveryQuery = {}): BrowserToolDiscoveryMatch[] {
  const normalizedQuery = (query.query ?? '').trim().toLowerCase()
  const queryTokens = normalizedQuery.split(/[^a-z0-9]+/i).filter(Boolean)
  const requestedCategories = new Set(query.categories ?? [])
  const requestedDomains = new Set((query.domains ?? []).map((value) => value.toLowerCase()))
  const requestedNames = new Set((query.names ?? []).map((value) => value.toLowerCase()))

  return BROWSER_TOOL_REGISTRY
    .map((entry) => {
      let score = 0
      const reasons: string[] = []

      if (requestedNames.size > 0 && requestedNames.has(entry.name.toLowerCase())) {
        score += 10
        reasons.push('explicitly requested by name')
      }
      if (requestedCategories.size > 0 && requestedCategories.has(entry.category)) {
        score += 6
        reasons.push(`matches requested category ${entry.category}`)
      }
      const matchedDomains = entry.domains.filter((domain) => requestedDomains.has(domain.toLowerCase()))
      if (matchedDomains.length > 0) {
        score += matchedDomains.length * 4
        reasons.push(`matches domain ${matchedDomains.join(', ')}`)
      }
      if (queryTokens.length > 0) {
        const haystacks = [
          entry.name,
          entry.category,
          entry.label,
          entry.capability,
          ...entry.domains,
          ...entry.capabilities,
          entry.whenToUse,
          ...entry.prerequisites
        ].map((value) => value.toLowerCase())
        const matchedTokens = queryTokens.filter((token) => haystacks.some((value) => value.includes(token)))
        if (matchedTokens.length > 0) {
          score += matchedTokens.length
          reasons.push(`query matched ${matchedTokens.join(', ')}`)
        }
      }

      return { ...entry, score, reasons }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

export function summarizeBrowserToolDiscovery(matches: Iterable<BrowserToolDiscoveryMatch>): string | null {
  const list = [...matches]
  if (list.length === 0) return null
  return list
    .map((match) => `${match.name} [${match.label.toLowerCase()}; domains: ${match.domains.join(', ')}]`)
    .join(' | ')
}

function inferBrowserToolDomains(name: string): string[] {
  if (name.startsWith('memory_')) return ['memory', 'task-state']
  if (['search', 'navigate'].includes(name)) return ['web', 'research', 'discovery']
  if (['read_page', 'wait_for_load', 'read_a11y'].includes(name)) return ['web', 'page-understanding']
  if (['grep_page'].includes(name)) return ['web', 'targeting']
  if (['extract_structured'].includes(name)) return ['web', 'data-extraction', 'verification']
  if (['discover_data_sources', 'watch_network'].includes(name)) return ['web', 'data-extraction', 'verification', 'dynamic-ui']
  if (['set_field', 'submit', 'open_result'].includes(name)) return ['web', 'automation', 'forms']
  if (['act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command'].includes(name)) return ['web', 'automation', 'advanced-automation']
  if (['screenshot', 'screenshot_app'].includes(name)) return ['web', 'visual-debugging']
  return ['web']
}

function inferBrowserToolCapabilities(name: string): string[] {
  if (name === 'search') return ['find live web sources', 'open known URLs']
  if (name === 'navigate') return ['open the chosen page', 'move to a result URL']
  if (['read_page', 'wait_for_load', 'read_a11y'].includes(name)) return ['understand the visible page', 'capture state before acting']
  if (name === 'grep_page') return ['pinpoint exact text or controls', 'act on a surgically matched target']
  if (name === 'extract_structured') return ['extract repeated DOM records', 'normalize listing results']
  if (['discover_data_sources', 'watch_network'].includes(name)) return ['inspect app-backed data sources', 'read network/API payloads structurally']
  if (['set_field', 'submit', 'open_result'].includes(name)) return ['perform semantic actions', 'drive forms/results at intent level']
  if (['act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command'].includes(name)) return ['perform advanced actions', 'fallback when standard actions are insufficient']
  if (name.startsWith('memory_')) return ['recover context', 'persist task state']
  if (['screenshot', 'screenshot_app'].includes(name)) return ['capture visual state', 'debug non-text UI state']
  return ['specialized browser action']
}

function inferBrowserToolWhenToUse(name: string): string {
  if (name === 'search') return 'When current web facts or candidate URLs are needed.'
  if (name === 'navigate') return 'When you already know which page to open.'
  if (['read_page', 'wait_for_load', 'read_a11y'].includes(name)) return 'When you need orientation on the current page before deciding the next action.'
  if (name === 'grep_page') return 'When exploratory reading is done and you need precise page targeting.'
  if (name === 'extract_structured') return 'When the page shows repeated cards, rows, or listing records to normalize.'
  if (['discover_data_sources', 'watch_network'].includes(name)) return 'When the page is dynamic and underlying data may be easier to inspect than the DOM.'
  if (['set_field', 'submit', 'open_result'].includes(name)) return 'When you know the intent and want a higher-level action primitive.'
  if (['act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command'].includes(name)) return 'When standard interaction tools are insufficient and a controlled advanced fallback is required.'
  if (name.startsWith('memory_')) return 'When multi-step work needs continuity across turns.'
  if (['screenshot', 'screenshot_app'].includes(name)) return 'When the visible UI state matters and textual extraction is insufficient.'
  return 'When this specialized tool is attached and relevant.'
}

function inferBrowserToolPrerequisites(name: string): string[] {
  if (name === 'navigate') return ['known URL or chosen search result']
  if (['grep_page', 'set_field', 'submit', 'open_result', 'act', 'grep_click', 'grep_type'].includes(name)) return ['visible page loaded', 'target identified']
  if (['extract_structured', 'discover_data_sources', 'watch_network', 'screenshot', 'screenshot_app'].includes(name)) return ['relevant page open']
  if (['execute_in_browser', 'cdp_command'].includes(name)) return ['standard browser tools were insufficient or too lossy']
  return []
}

export function describeSemanticVerbPreference(allowed: ReadonlySet<string>): string | null {
  if (!allowed.has('set_field') && !allowed.has('submit') && !allowed.has('open_result')) return null
  const verbs: string[] = []
  if (allowed.has('set_field')) verbs.push('`set_field` for filling inputs/textareas/selects semantically')
  if (allowed.has('submit')) verbs.push('`submit` for form submission/search/send/save intent')
  if (allowed.has('open_result')) verbs.push('`open_result` for opening the 1st/Nth matching result/card/headline')
  return `${BROWSER_SEMANTIC_VERBS_GUIDANCE}: ${verbs.join(', ')}.`
}

export function stripNamedToolLead(text: string): string {
  return text.replace(/^`[^`]+`\s+is\s+/, '')
}

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

  const categorySummary = summarizeBrowserToolCategories(allowed)
  if (categorySummary) {
    lines.push(`Attached browser capabilities by category: ${categorySummary}.`)
    lines.push('These attached tools are a routed subset from a broader categorized browser-tool registry; choose tools by capability/domain fit, not just by name similarity.')
  }

  if (allowed.has('search')) {
    lines.push('Use `search` for live web lookup, and use `navigate` to load a known URL in the visible tab when you already know where to go.')
  }

  const hasBrowserInteraction = CODEX_INTERACTION_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasBrowserInteraction) {
    const browserTools = CODEX_INTERACTION_TOOL_NAMES.filter((name) => allowed.has(name))
    lines.push(`For browser work beyond search use the attached gladdis.* tools: ${browserTools.join(', ')}.`)
  }

  const semanticVerbLine = describeSemanticVerbPreference(allowed)
  if (semanticVerbLine) lines.push(semanticVerbLine)

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

  if (allowed.has('diagnose_target')) {
    lines.push(DIAGNOSE_TARGET_GUIDANCE)
  }

  if (allowed.has('act') && (allowed.has('read_a11y') || allowed.has('grep_page'))) {
    lines.push(ACT_REORIENT_GUIDANCE)
  }

  // Any perception/drive verb carries the tab-grounding brief, so teach the
  // model to read it whenever it has at least one such tool.
  if (TAB_BRIEF_CARRYING_TOOLS.some((name) => allowed.has(name))) {
    lines.push(TAB_GROUNDING_GUIDANCE)
  }

  const hasMemoryTools = CODEX_MEMORY_TOOL_NAMES.some((name) => allowed.has(name))
  if (hasMemoryTools) {
    const notebookLine = buildMemoryNotebookLine(allowed)
    if (notebookLine) lines.push(notebookLine)
  }

  lines.push(NATIVE_BROWSER_PROHIBITION)
  lines.push(GLADDIS_DEBUGGING_GUIDANCE)
  lines.push('Use Codex-native shell and file tools for local code, package, and command work, and for background web fetching (curl/CLI/API) — just never to drive a separate browser for work the user should watch happen in the visible tab.')

  return lines.join('\n')
}

export const CODEX_BROWSER_INSTRUCTIONS = buildCodexBrowserInstructions(CODEX_BROWSER_TOOL_NAMES)

export const CODEX_DISABLED_NATIVE_CONFIG = {
  web_search: 'disabled',
  features: {
    standalone_web_search: false,
    web_search_request: false,
    web_search_cached: false,
    search_tool: true,
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
