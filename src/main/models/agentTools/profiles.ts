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

const REQUEST_TOOLS_DEF: ToolDef = {
  name: 'request_tools',
  description:
    'Pull in a group of tools you need but were not given yet, then continue the task. ' +
    'Call this the moment you realize you need to act — never say you will do something you lack the tool for; ask for the tool instead. ' +
    'Groups: "filesystem" (repo overview/search, read/edit files, run shell commands, install packages), ' +
    '"browser" (read/navigate/click/screenshot the visible page), ' +
    '"research" (web search and page fetch). After the tools are granted, use them in your next step.',
  parameters: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        enum: ['filesystem', 'browser', 'research'],
        description: 'Which tool group to add for the rest of this turn.'
      }
    },
    required: ['group']
  }
}

/** Tool names contained in a requestable group (empty for an unknown group). */
export function toolGroupNames(group: string): string[] {
  return (TOOL_GROUPS[group] ?? []).map((t) => t.name)
}

/** Every profile carries request_tools so the model can always escalate. */
function withEscalation(tools: ToolDef[]): ToolDef[] {
  return tools.some((t) => t.name === REQUEST_TOOLS_DEF.name) ? tools : [...tools, REQUEST_TOOLS_DEF]
}

/**
 * The tool list for a turn: the starting profile plus any groups the model has
 * pulled in via request_tools this turn. Deduped by name, order preserved.
 */
export function resolveTurnTools(profileTools: ToolDef[], granted?: Set<string>): ToolDef[] {
  const base = withEscalation(profileTools)
  if (!granted || granted.size === 0) return base
  const have = new Set(base.map((t) => t.name))
  const extra = Object.values(TOOL_GROUPS)
    .flat()
    .filter((t) => granted.has(t.name) && !have.has(t.name))
  return extra.length ? [...base, ...extra] : base
}

/**
 * Pick the lean starting profile based on the user's prompt. The model can
 * always escalate to a richer profile via `request_tools`, so getting this
 * exactly right matters less than keeping the starting tool set small.
 */
export function selectAgentToolProfile(userText: string): AgentToolProfile {
  const text = userText.toLowerCase()
  const wantsFilesystem = shouldUseWorkspaceContext(text)
  const wantsBrowser = shouldUseDirectBrowserTools(text)
  const wantsResearch = shouldUseWebResearchTools(text)

  if (wantsFilesystem && !wantsBrowser && !wantsResearch) {
    return { name: 'filesystem', tools: withEscalation(FILESYSTEM_PROFILE_TOOLS) }
  }
  if (wantsBrowser && !wantsFilesystem) {
    return { name: 'browser', tools: withEscalation(BROWSER_PROFILE_TOOLS) }
  }
  if (wantsResearch && !wantsFilesystem) {
    return { name: 'research', tools: withEscalation(RESEARCH_PROFILE_TOOLS) }
  }
  if (wantsFilesystem || wantsBrowser || wantsResearch) {
    return { name: 'full', tools: withEscalation(AGENT_TOOLS) }
  }
  return { name: 'conversation', tools: withEscalation(CONVERSATION_PROFILE_TOOLS) }
}
