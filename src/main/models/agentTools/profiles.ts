import type { ToolDef } from '../browserTools'
import { CAPTURE_TOOLS, PERCEIVE_TOOLS } from './perceive'
import { DRIVE_TOOLS } from './drive'
import { FS_TOOLS } from './fs'
import { MEMORY_TOOLS } from './memory'
import { SEARCH_TOOLS } from './search'

const TOOL_NAME_NORMALIZE_CACHE = new Map<string, string>()
const NORMALIZED_NAME_CACHE_LIMIT = 128

/**
 * The complete dispatchable tool registry — ordered by call frequency.
 *
 * This is the single source of truth for what Gladdis can dispatch. Individual
 * turns now receive a routed subset of this registry, with per-agent user
 * policy (preferred/disallowed tools) applied afterwards in
 * AgentConfigurationService.
 */
export const AGENT_TOOLS: ToolDef[] = [
  ...SEARCH_TOOLS,     // search
  ...PERCEIVE_TOOLS,   // read_page, read_a11y, grep_page, watch_network
  ...CAPTURE_TOOLS,    // screenshot (vision fallback), screenshot_app
  ...DRIVE_TOOLS,      // act, navigate, grep_click, grep_type, execute_in_browser, cdp_command
  ...FS_TOOLS,         // read_file, write_file, edit_file, list_dir, search_files, run_command
  ...MEMORY_TOOLS      // recall_history + memory_*
]

const TOOL_NAME_ALIASES: Record<string, string> = {
  runcommand: 'run_command',
  runcommandtool: 'run_command',
  readfile: 'read_file',
  writefile: 'write_file',
  editfile: 'edit_file',
  listdir: 'list_dir',
  searchfiles: 'search_files',
  recallhistory: 'recall_history',
  memorywrite: 'memory_write',
  memoryread: 'memory_read',
  memorylist: 'memory_list',
  memoryforget: 'memory_forget',
  memorycreatetask: 'memory_create_task',
  readpage: 'read_page',
  reada11y: 'read_a11y',
  execinbrowser: 'execute_in_browser',
  screenshotapp: 'screenshot_app'
}

/** Canonical tool-name normalizer for agent-policy lookups. */
export function normalizeToolName(raw: string): string {
  if (!raw) return ''
  const key = raw.trim().toLowerCase()
  const existing = TOOL_NAME_NORMALIZE_CACHE.get(key)
  if (existing !== undefined) return existing

  const compacted = key
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const normalized = TOOL_NAME_ALIASES[compacted] ?? compacted

  if (TOOL_NAME_NORMALIZE_CACHE.size >= NORMALIZED_NAME_CACHE_LIMIT && !TOOL_NAME_NORMALIZE_CACHE.has(key)) {
    const first = TOOL_NAME_NORMALIZE_CACHE.keys().next()
    if (!first.done && first.value !== undefined) TOOL_NAME_NORMALIZE_CACHE.delete(first.value)
  }
  TOOL_NAME_NORMALIZE_CACHE.set(key, normalized)
  return normalized
}

const KNOWN_TOOL_BY_NORMALIZED_NAME = new Map<string, ToolDef>(
  AGENT_TOOLS.map((tool) => [normalizeToolName(tool.name), tool] as const)
)

/** Look up a tool def by name (alias-normalized). Used by per-agent tool policy. */
export function knownToolByName(name: string): ToolDef | undefined {
  return KNOWN_TOOL_BY_NORMALIZED_NAME.get(normalizeToolName(name))
}

/** True when `name` resolves to a real tool in the surface. */
export function isKnownToolName(name: string): boolean {
  return KNOWN_TOOL_BY_NORMALIZED_NAME.has(normalizeToolName(name))
}
