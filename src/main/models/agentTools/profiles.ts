import type { ToolDef } from '../browserTools'
import {
  shouldUseDirectBrowserTools,
  shouldUseWebResearchTools,
  shouldUseWorkspaceContext
} from '../../../../shared/types'
import { CAPTURE_TOOLS, PERCEIVE_TOOLS } from './perceive'
import { DRIVE_TOOLS } from './drive'
import { FS_TOOLS } from './fs'
import { MEMORY_TOOLS } from './memory'
import { REPO_TOOLS } from './repo'
import { SEARCH_TOOLS } from './search'
import { TASK_TOOLS } from './task'

const TOOL_NAME_NORMALIZE_CACHE = new Map<string, string>()
const TOOL_GROUP_NAME_NORMALIZE_CACHE = new Map<string, string>()
const TOOL_LIST_CACHE = new Map<string, ToolDef[]>()
const TOOL_LIST_CACHE_LIMIT = 64
const NORMALIZED_NAME_CACHE_LIMIT = 128
const PROFILE_TOOL_SIGNATURES = new WeakMap<ToolDef[], string>()

/** The complete agent tool surface — ordered by call frequency. */
export const AGENT_TOOLS: ToolDef[] = [
  ...REPO_TOOLS,       // repo overview + bounded workspace search
  ...SEARCH_TOOLS,     // search, fetch_page, deep_search
  ...TASK_TOOLS,       // browse_task for multi-step browser work
  ...PERCEIVE_TOOLS,   // read_page
  ...CAPTURE_TOOLS,    // screenshot, screenshot_app
  ...DRIVE_TOOLS,      // navigate, click, type, press, execute_in_browser, cdp
  ...FS_TOOLS,         // read_file, write_file, edit_file, list_dir, search_files, …
  ...MEMORY_TOOLS      // recall_history + memory_*
]

export type AgentToolProfileName = 'conversation' | 'browser' | 'filesystem' | 'research' | 'full'

export interface AgentToolProfile {
  name: AgentToolProfileName
  tools: ToolDef[]
}

const BROWSER_PROFILE_TOOLS: ToolDef[] = [
  ...SEARCH_TOOLS,
  ...TASK_TOOLS,
  ...PERCEIVE_TOOLS,
  ...CAPTURE_TOOLS,
  ...DRIVE_TOOLS,
  ...MEMORY_TOOLS
]

const CONVERSATION_PROFILE_TOOLS: ToolDef[] = [
  ...MEMORY_TOOLS
]

const FILESYSTEM_PROFILE_TOOLS: ToolDef[] = [
  ...REPO_TOOLS,
  ...FS_TOOLS,
  ...MEMORY_TOOLS
]

const RESEARCH_PROFILE_TOOLS: ToolDef[] = [
  ...SEARCH_TOOLS,
  ...PERCEIVE_TOOLS,
  ...MEMORY_TOOLS
]

// ── On-demand tool escalation ───────────────────────────────────────────────
// The lean starting profile is a GUESS. When it guesses wrong, the model would
// otherwise narrate "I need to read the project" and stop, having no
// filesystem tool. request_tools removes that failure: it is in every profile,
// and calling it pulls in a whole group for the rest of the turn. The model
// asks instead of giving up — and we still only pay for the heavy tool defs
// once they are actually needed.

/** Tool groups the model can pull in mid-turn via request_tools. */
const TOOL_GROUPS: Record<string, ToolDef[]> = {
  filesystem: [...REPO_TOOLS, ...FS_TOOLS],
  browser: [...PERCEIVE_TOOLS, ...CAPTURE_TOOLS, ...DRIVE_TOOLS],
  research: [...SEARCH_TOOLS, ...TASK_TOOLS]
}
const KNOWN_TOOL_GROUPS = new Set(Object.keys(TOOL_GROUPS))

const TOOL_NAME_ALIASES: Record<string, string> = {
  runcommand: 'run_command',
  runcommandtool: 'run_command',
  readfile: 'read_file',
  writefile: 'write_file',
  editfile: 'edit_file',
  listdir: 'list_dir',
  searchfiles: 'search_files',
  runvalidation: 'run_validation',
  readclipboard: 'read_clipboard',
  writeclipboard: 'write_clipboard',
  requesttools: 'request_tools',
  recallhistory: 'recall_history',
  launchwebdevserver: 'launch_web_dev_server',
  auditcodebase: 'audit_codebase',
  memorywrite: 'memory_write',
  memoryread: 'memory_read',
  memorylist: 'memory_list',
  memoryforget: 'memory_forget',
  memorycreatetask: 'memory_create_task',
  browsetask: 'browse_task',
  readpage: 'read_page',
  reada11y: 'read_a11y',
  execinbrowser: 'execute_in_browser',
  screenshotapp: 'screenshot_app'
}

const TOOL_GROUP_ALIASES: Record<string, string> = {
  fs: 'filesystem',
  file: 'filesystem',
  files: 'filesystem',
  filesys: 'filesystem',
  filesystem: 'filesystem',
  file_system: 'filesystem',
  browser: 'browser',
  browse: 'browser',
  research: 'research',
  search: 'research',
  web: 'research',
  web_search: 'research',
  web_research: 'research',
  websearch: 'research',
  websearch_tools: 'research'
}

const KNOWN_TOOL_NAMES = new Set(AGENT_TOOLS.map((tool) => normalizeToolName(tool.name)))
const KNOWN_TOOL_BY_NORMALIZED_NAME = new Map<string, ToolDef>(
  AGENT_TOOLS.map((tool) => [normalizeToolName(tool.name), tool] as const)
)

const REQUEST_TOOLS_DEF: ToolDef = {
  name: 'request_tools',
  description:
    'Pull missing tools mid-turn by `group` (filesystem/browser/research) or exact `tools`.',
  parameters: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        enum: ['filesystem', 'browser', 'research'],
        description: 'Optional group name to add for the rest of this turn.'
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional exact tool names to add, e.g. ["read_file", "run_command"].'
      }
    },
    required: []
  }
}

/** Tool names contained in a requestable group (empty for an unknown group). */
export function toolGroupNames(group: string): string[] {
  const normalized = normalizeRequestedGroupName(group)
  return (TOOL_GROUPS[normalized] ?? []).map((t) => t.name)
}

/** Every profile carries request_tools so the model can always escalate. */
function withEscalation(tools: ToolDef[]): ToolDef[] {
  return tools.some((t) => t.name === REQUEST_TOOLS_DEF.name) ? tools : [...tools, REQUEST_TOOLS_DEF]
}

/** Pre-built profile tool lists so we avoid re-allocating on every message. */
const PROFILE_TOOLS: Record<AgentToolProfileName, ToolDef[]> = {
  conversation: withEscalation(CONVERSATION_PROFILE_TOOLS),
  browser: withEscalation(BROWSER_PROFILE_TOOLS),
  filesystem: withEscalation(FILESYSTEM_PROFILE_TOOLS),
  research: withEscalation(RESEARCH_PROFILE_TOOLS),
  full: withEscalation(AGENT_TOOLS)
}

function toolListSignature(toolDefs: ToolDef[]): string {
  let sig = PROFILE_TOOL_SIGNATURES.get(toolDefs)
  if (!sig) {
    sig = toolDefs.map((tool) => tool.name).join('\u0000')
    PROFILE_TOOL_SIGNATURES.set(toolDefs, sig)
  }
  return sig
}

function cacheResolvedTools(cacheKey: string, toolDefs: ToolDef[]): ToolDef[] {
  if (TOOL_LIST_CACHE.has(cacheKey)) return TOOL_LIST_CACHE.get(cacheKey)!
  if (TOOL_LIST_CACHE.size >= TOOL_LIST_CACHE_LIMIT) {
    const first = TOOL_LIST_CACHE.keys().next()
    if (!first.done && first.value !== undefined) TOOL_LIST_CACHE.delete(first.value)
  }
  TOOL_LIST_CACHE.set(cacheKey, toolDefs)
  return toolDefs
}

function normalizeCachedName(value: string, cache: Map<string, string>): string {
  const key = value.trim().toLowerCase()
  const existing = cache.get(key)
  if (existing !== undefined) return existing

  const compacted = key
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  let normalized = compacted
  if (cache === TOOL_NAME_NORMALIZE_CACHE) {
    normalized = TOOL_NAME_ALIASES[compacted] ?? compacted
  } else {
    normalized = TOOL_GROUP_ALIASES[compacted] ?? (KNOWN_TOOL_GROUPS.has(compacted) ? compacted : '')
  }

  if (cache.size >= NORMALIZED_NAME_CACHE_LIMIT && !cache.has(key)) {
    const first = cache.keys().next()
    if (!first.done && first.value !== undefined) cache.delete(first.value)
  }
  cache.set(key, normalized)
  return normalized
}

function splitIncomingList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((value) => String(value))
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,;\n]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function normalizeRequestedGroupName(raw: string): string {
  if (!raw) return ''
  return normalizeCachedName(raw, TOOL_GROUP_NAME_NORMALIZE_CACHE)
}

function normalizeRequestedToolName(raw: string): string {
  if (!raw) return ''
  return normalizeCachedName(raw, TOOL_NAME_NORMALIZE_CACHE)
}

/** Canonical tool-name normalizer for request args and grants. */
export function normalizeToolName(raw: string): string {
  return normalizeRequestedToolName(raw)
}

/** Public normalizer for request_tools `tools` arguments. */
export function normalizeRequestedTools(raw: unknown): string[] {
  const result = new Set<string>()
  for (const value of splitIncomingList(raw)) {
    const normalized = normalizeRequestedToolName(value)
    if (normalized) result.add(normalized)
  }
  return [...result]
}

/** Public normalizer for request_tools `group` arguments. */
export function normalizeRequestedGroups(raw: unknown): string[] {
  const result = new Set<string>()
  for (const rawGroup of splitIncomingList(raw)) {
    const group = normalizeRequestedGroupName(rawGroup)
    if (group) result.add(group)
  }
  return [...result]
}

/**
 * The tool list for a turn: the starting profile plus any groups or exact tools
 * granted via request_tools. Deduped by name, order preserved.
 */
export function resolveTurnTools(profileTools: ToolDef[], granted?: Set<string>): ToolDef[] {
  const base = profileTools.some((t) => t.name === REQUEST_TOOLS_DEF.name) ? profileTools : [...profileTools, REQUEST_TOOLS_DEF]
  const cacheBaseKey = `base:${toolListSignature(base)}`
  if (!granted || granted.size === 0) {
    const cached = TOOL_LIST_CACHE.get(cacheBaseKey)
    return cached ?? cacheResolvedTools(cacheBaseKey, base)
  }

  const requestedTools = new Set<string>()
  for (const raw of granted) {
    const tool = normalizeRequestedToolName(raw)
    if (tool && KNOWN_TOOL_BY_NORMALIZED_NAME.has(tool)) {
      requestedTools.add(tool)
    }
  }
  if (requestedTools.size === 0) {
    const cached = TOOL_LIST_CACHE.get(cacheBaseKey)
    return cached ?? cacheResolvedTools(cacheBaseKey, base)
  }

  const normalized = [...requestedTools].sort()
  const cacheKey = `${cacheBaseKey}|${normalized.join(',')}`
  const cached = TOOL_LIST_CACHE.get(cacheKey)
  if (cached) return cached

  const have = new Set(base.map((tool) => tool.name))
  const extra = AGENT_TOOLS.filter((tool) => requestedTools.has(tool.name) && !have.has(tool.name))
  return cacheResolvedTools(cacheKey, extra.length ? [...base, ...extra] : base)
}

/**
 * Pick the lean starting profile based on the user's prompt. The model can
 * always escalate to a richer profile via `request_tools`, so getting this
 * exactly right matters less than keeping the starting tool set small.
 *
 * When a workspace folder is selected the user is working inside a project, so
 * the toolless `conversation` baseline is upgraded to `filesystem` — file and
 * coding tools are then present from the first step instead of being gated
 * behind a request_tools round-trip. Explicit browser/research intent still
 * wins (those turns reach filesystem via request_tools when needed), and with
 * no folder open pure chat stays lean.
 */
export function selectAgentToolProfile(
  userText: string,
  options?: { hasWorkspaceFolder?: boolean }
): AgentToolProfile {
  const profile = selectBaseAgentToolProfile(userText)
  if (options?.hasWorkspaceFolder && profile.name === 'conversation') {
    return { name: 'filesystem', tools: PROFILE_TOOLS.filesystem }
  }
  return profile
}

function selectBaseAgentToolProfile(userText: string): AgentToolProfile {
  const text = userText.toLowerCase()
  const wantsFilesystem = shouldUseWorkspaceContext(text)
  const wantsBrowser = shouldUseDirectBrowserTools(text)
  const wantsResearch = shouldUseWebResearchTools(text)
  const isBroad = /\b(?:full|complete|entire|all\s+of\s+it|end-?to-?end|from start to finish)\b/i.test(userText)

  if (wantsFilesystem && !wantsBrowser && !wantsResearch) {
    return { name: 'filesystem', tools: PROFILE_TOOLS.filesystem }
  }
  if (wantsBrowser && !wantsFilesystem) {
    return { name: 'browser', tools: PROFILE_TOOLS.browser }
  }
  if (wantsResearch && !wantsFilesystem) {
    return { name: 'research', tools: PROFILE_TOOLS.research }
  }
  if (wantsFilesystem || wantsBrowser || wantsResearch) {
    if (isBroad) return { name: 'full', tools: PROFILE_TOOLS.full }
    if (wantsFilesystem && wantsBrowser) return { name: 'filesystem', tools: PROFILE_TOOLS.filesystem }
    if (wantsFilesystem && wantsResearch) return { name: 'filesystem', tools: PROFILE_TOOLS.filesystem }
    if (wantsBrowser && wantsResearch) return { name: 'research', tools: PROFILE_TOOLS.research }
    return { name: 'full', tools: PROFILE_TOOLS.full }
  }
  return { name: 'conversation', tools: PROFILE_TOOLS.conversation }
}

/** Exported for request_tools runtime validation. */
export function isKnownToolName(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(normalizeRequestedToolName(name))
}

export function isKnownToolGroup(group: string): boolean {
  return KNOWN_TOOL_GROUPS.has(normalizeRequestedGroupName(group))
}

export function knownToolByName(name: string): ToolDef | undefined {
  return KNOWN_TOOL_BY_NORMALIZED_NAME.get(normalizeRequestedToolName(name))
}
