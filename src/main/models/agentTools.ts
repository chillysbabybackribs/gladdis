/**
 * agentTools — the deterministic tool surface for the LLM agent.
 *
 * ARCHITECTURE: Strict role separation between LLM and deterministic layer.
 *
 *   DRIVE tools   → blind actions (navigate / click / type / press / cdp).
 *                   Return only ack strings ("Navigated", "Clicked at …").
 *                   The LLM NEVER sees raw page data from these.
 *
 *   PERCEIVE tool → `read_page` (singular). The LLM calls it to read the page.
 *                   Internally runs the full deterministic PageExtractor, then
 *                   formats the result through PageDigest. The LLM receives a
 *                   clean, structured "paper" — no raw HTML, no base64 images.
 *
 *   SEARCH tools  → `search` (visible-tab web search + ranked results),
 *                   `fetch_page` (open a URL in the visible tab + read it), and
 *                   `background_web_search` (off-screen breadth, visible tab
 *                   untouched). The model drives the loop: query → open → read →
 *                   answer (or ask a clarifying question). No hidden scoring,
 *                   no app-side "is this good enough" gate.
 *
 *   TASK tool     → `browse_task`. Multi-step browser goal handled entirely by
 *                   the deterministic pipeline (Planner → Runner → finalResponse).
 *                   The LLM issues ONE call, the pipeline drives the browser
 *                   deterministically, then hands back a synthesised answer.
 *                   Use this whenever the goal requires more than 1–2 steps.
 *
 *   FS tools      → read_file / write_file / edit_file / list_dir / search_files /
 *                   run_validation / publish_changes.
 *   MEMORY tool   → recall_history.
 *
 * Token budget: the old free-form loop could inject 30–100 K tokens per turn
 * through extract_page + screenshot + get_browser_html. This surface caps
 * single-page perception at ~2 600 tokens and routes multi-step tasks through
 * the pipeline which returns a 1–3 sentence synthesis.
 */

import type { ToolDef } from './browserTools'
import {
  shouldUseDirectBrowserTools,
  shouldUseWebResearchTools,
  shouldUseWorkspaceContext
} from '../../../shared/types'

// ─── Drive tools ──────────────────────────────────────────────────────────────
// Blind: return only a short ack. The LLM drives; the page state is opaque
// until it calls read_page.

const DRIVE_TOOLS: ToolDef[] = [
  {
    name: 'navigate',
    description:
      'Navigate the active browser tab to a URL. ' +
      'Returns an ack when the page-load event fires. ' +
      'Call read_page afterwards to see the page content.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to load.' } },
      required: ['url']
    }
  },
  {
    name: 'click_xy',
    description:
      'Trusted mouse click at viewport coordinates (x, y). ' +
      'Get coordinates from the ACTIONS table in the last read_page digest.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y']
    }
  },
  {
    name: 'type_text',
    description:
      'Type text into the focused element. Click the target first.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'press_key',
    description:
      'Press a single key: Enter, Tab, Escape, Backspace, Delete, ' +
      'ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name, e.g. "Enter".' } },
      required: ['key']
    }
  },
  {
    name: 'execute_in_browser',
    description:
      'Run JavaScript in the active page. Use `return <expr>` to get a value. ' +
      'For reading page state prefer read_page (cheaper); use this for surgical ' +
      'DOM mutations, form fills, or extracting a specific scalar value.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript. Use `return` to yield a value.' }
      },
      required: ['code']
    }
  },
  {
    name: 'cdp_command',
    description:
      'Send a raw Chrome DevTools Protocol command. Escape hatch for advanced ' +
      'control (network interception, emulation, etc.).',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        params: { type: 'object', description: 'CDP params.' }
      },
      required: ['method']
    }
  }
]

// ─── Perceive tools ───────────────────────────────────────────────────────────
// All page-reading goes through one of these two bounded tools.
// Neither ever returns raw HTML or base64 images.

const PERCEIVE_TOOLS: ToolDef[] = [
  {
    name: 'read_page',
    description:
      'Read the current page. Returns a structured, token-bounded digest:\n' +
      '  • URL, title, word count\n' +
      '  • Content summary (first ~450 tokens of readable text)\n' +
      '  • Headings outline\n' +
      '  • OG / meta structured data\n' +
      '  • Interactive actions table (up to 80 rows): index, role, label, ' +
      '    viewport coordinates (x, y), selector — everything needed to drive\n' +
      '  • Key links\n' +
      'Use the ACTIONS table to get (x, y) coords for click_xy. Call this once ' +
      'per page; re-call only after an action that changes the page structure.\n' +
      'opts.focus: optional keyword — ranks relevant actions higher in the table.\n' +
      'opts.viewportOnly: true → only show actions visible on screen.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Keyword to rank relevant actions higher (e.g. "login", "search").'
        },
        viewportOnly: {
          type: 'boolean',
          description: 'If true, only include actions currently visible in the viewport.'
        }
      }
    }
  }
]

// ─── Capture tools ────────────────────────────────────────────────────────────
// Return an actual PNG to the model (vision). Prefer read_page for understanding
// page content cheaply; use these when a visual is genuinely needed (verify a
// render, inspect layout, confirm a local preview looks right).

const CAPTURE_TOOLS: ToolDef[] = [
  {
    name: 'screenshot',
    description:
      'Capture a PNG of the active browser tab and return it as an image. ' +
      'Use to visually confirm a page rendered as expected. ' +
      'opts.fullPage: true → capture the whole scrollable page (default: visible viewport).',
    parameters: {
      type: 'object',
      properties: {
        fullPage: {
          type: 'boolean',
          description: 'If true, capture the entire scrollable page instead of just the viewport.'
        }
      }
    }
  },
  {
    name: 'screenshot_app',
    description:
      "Capture a PNG of the entire Gladdis app window (the chat UI plus the " +
      'embedded browser) and return it as an image. Use to see the whole app ' +
      'state at once — e.g. to check the chat panels and browser together.',
    parameters: { type: 'object', properties: {} }
  }
]

// ─── Task tool ────────────────────────────────────────────────────────────────
// Multi-step pipeline: Planner → deterministic Runner → synthesized answer.
// The LLM issues ONE tool call; the browser work happens without any further
// model calls unless a step's post-condition fails (replan).

const SEARCH_TOOLS: ToolDef[] = [
  {
    name: 'search',
    description: 'Web search (hidden lookup). Open best result with fetch_page/navigate.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Max results. Default 8.' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_page',
    description:
      'Open a URL in the visible tab, wait for navigation to settle, and return a bounded page digest. ' +
      'Use this after search/background_web_search when you need to inspect the chosen result.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open in the visible tab.' },
        focus: {
          type: 'string',
          description: 'Optional keyword to rank relevant actions and links in the digest.'
        },
        viewportOnly: {
          type: 'boolean',
          description: 'If true, only include visible-on-screen actions in the digest.'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'background_web_search',
    description:
      'Off-screen web search for breadth. Does not change the visible tab; open useful results with fetch_page/navigate.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Max results. Default 8.' }
      },
      required: ['query']
    }
  }
]

const TASK_TOOLS: ToolDef[] = [
  {
    name: 'browse_task',
    description:
      'Execute a multi-step browser task end-to-end using a deterministic pipeline.\n' +
      'The pipeline:\n' +
      '  1. Reads the current page once (deterministic)\n' +
      '  2. Asks the model to plan ALL steps up front\n' +
      '  3. Executes each step with CDP, verifying post-conditions deterministically\n' +
      '  4. Returns a concise synthesis of what was found/done\n\n' +
      'Use this instead of manually sequencing navigate/click/read_page calls ' +
      'whenever the task requires 2+ interactions (form fills, searches, ' +
      'multi-page flows, login sequences, scraping a list, etc.).\n\n' +
      'The returned answer contains only synthesized facts — no raw HTML, ' +
      'no action tables, no screenshots.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Plain-language description of what to accomplish. Be specific: include target URLs, search terms, values to fill, data to extract.'
        },
        site: {
          type: 'string',
          description: 'Optional human label for the site (e.g. "GitHub"). Helps the planner.'
        }
      },
      required: ['task']
    }
  }
]

// ─── Filesystem + validation tools ────────────────────────────────────────────

const FS_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 file from the local filesystem. Small files return whole by default; ' +
      'large files return a bounded preview with total-line metadata. For unknown code, ' +
      'use search_files first, then read the exact start_line / end_line range around hits. ' +
      'Pass full: true only when the entire file is genuinely needed. Large outputs are capped.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number', description: 'First line (1-based).' },
        end_line: { type: 'number', description: 'Last line (inclusive).' },
        full: { type: 'boolean', description: 'Return the whole file up to the hard cap.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description:
      'Create or completely overwrite a file. Parent dirs are created automatically. ' +
      'Prefer edit_file for surgical changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'Full file contents.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must be unique and match byte-for-byte. ' +
      'Use replace_all: true to replace every occurrence.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_dir',
    description: 'List immediate entries of a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description:
      'Ripgrep-backed recursive search before reading unknown files. Fixed-string queries use ' +
      'smart-case matching and also surface strong file-path/name hits alongside content hits; ' +
      'set regex: true for patterns. Returns ranked hits, compact context, and a suggested ' +
      'read_file follow-up. Skips node_modules/.git/build. Optional glob filter (e.g. "*.ts").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Root dir to search. Defaults to ".".' },
        glob: { type: 'string', description: 'File-name glob, e.g. "*.ts".' },
        context_lines: {
          type: 'number',
          description: 'Nearby lines to include around each hit. Defaults to 2; max 8.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum hits to return. Defaults to 1000; use smaller values for broad queries.'
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a regular expression instead of a fixed substring.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'run_validation',
    description:
      'Run a fixed project validation command after code edits. ' +
      'Use typecheck for most TypeScript changes, test for behavioral changes, build for packaging/runtime confidence, ' +
      'or check for the full local gate. Do not claim code edits are complete until relevant validation passes.',
    parameters: {
      type: 'object',
      properties: {
        check: {
          type: 'string',
          enum: ['typecheck', 'test', 'build', 'check'],
          description: 'Validation command to run: typecheck, test, build, or check.'
        }
      },
      required: ['check']
    }
  },
  {
    name: 'publish_changes',
    description:
      'Commit and push local repository changes after successful code edits and validation. ' +
      'Stages changes according to .gitignore, creates one commit, and pushes the current branch to the configured Git remote. ' +
      'Use this automatically at the end of coding tasks when validation has passed, unless the user explicitly says not to push.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Short commit message. Defaults to "Update Gladdis app".'
        },
        remote: {
          type: 'string',
          description: 'Git remote to push. Defaults to origin.'
        },
        branch: {
          type: 'string',
          description: 'Branch to push. Defaults to the current branch.'
        }
      }
    }
  },
  {
    name: 'run_command',
    description:
      'Run an arbitrary shell command on the local machine and return its combined stdout/stderr. ' +
      'Use this to install or update whatever the task needs — packages (npm/pnpm/pip/apt-get/brew), ' +
      'repos (git clone), CLIs, or any other tool — and to run build/setup steps that run_validation does not cover. ' +
      'The command runs as the current OS user with full access; there is no approval prompt. ' +
      'For system packages that need root (e.g. apt-get/dpkg), prefix the command with "sudo" — passwordless sudo is configured, so "sudo apt-get install -y <pkg>" runs unattended. ' +
      'Prefer run_validation for the fixed typecheck/test/build checks; use this for everything else.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The full shell command line to execute, e.g. "npm install -g pnpm" or "git clone <url>".'
        },
        cwd: {
          type: 'string',
          description: 'Working directory. Defaults to the workspace root.'
        }
      },
      required: ['command']
    }
  }
]

// ─── Memory tool ──────────────────────────────────────────────────────────────

const MEMORY_TOOLS: ToolDef[] = [
  {
    name: 'recall_history',
    description:
      'Retrieve earlier parts of saved chat history from disk. ' +
      'By default this searches the current conversation chain. Pass scope:"all" ' +
      'without a query to list recent saved chat summaries, or with a query to search older chats. ' +
      'Pass conversation_id ' +
      'to read a saved conversation in full when the summary is not enough. ' +
      'For a bare resume request, use this to recover context, then summarize what you found and wait for the next concrete instruction before taking state-changing actions. ' +
      'Pass tool_call_id to re-read a specific earlier tool result in full.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for in earlier turns.' },
        conversation_id: { type: 'string', description: 'Saved Gladdis conversation id to read in full.' },
        tool_call_id: { type: 'string', description: 'Id of an earlier tool call to re-read verbatim.' },
        scope: {
          type: 'string',
          enum: ['conversation', 'all'],
          description: 'Search the current conversation chain, or all saved chats when explicitly needed.'
        }
      }
    }
  }
]

/** The complete agent tool surface — ordered by call frequency. */
export const AGENT_TOOLS: ToolDef[] = [
  ...SEARCH_TOOLS,     // search, fetch_page, background_web_search
  ...TASK_TOOLS,       // browse_task for multi-step browser work
  ...PERCEIVE_TOOLS,   // read_page
  ...CAPTURE_TOOLS,    // screenshot, screenshot_app
  ...DRIVE_TOOLS,      // navigate, click, type, press, execute_in_browser, cdp
  ...FS_TOOLS,         // read_file, write_file, edit_file, list_dir, search_files
  ...MEMORY_TOOLS      // recall_history
]

export type AgentToolProfileName = 'conversation' | 'browser' | 'filesystem' | 'research' | 'full'

export interface AgentToolProfile {
  name: AgentToolProfileName
  tools: ToolDef[]
}

const BROWSER_TOOLS: ToolDef[] = [
  ...SEARCH_TOOLS,
  ...TASK_TOOLS,
  ...PERCEIVE_TOOLS,
  ...CAPTURE_TOOLS,
  ...DRIVE_TOOLS,
  ...MEMORY_TOOLS
]

const CONVERSATION_TOOLS: ToolDef[] = [
  ...MEMORY_TOOLS
]

const FILESYSTEM_TOOLS: ToolDef[] = [
  ...FS_TOOLS,
  ...MEMORY_TOOLS
]

const RESEARCH_TOOLS: ToolDef[] = [
  ...SEARCH_TOOLS,
  ...PERCEIVE_TOOLS,
  ...MEMORY_TOOLS
]

// ─── On-demand tool escalation ────────────────────────────────────────────────
// The lean starting profile is a GUESS. When it guesses wrong, the model would
// otherwise narrate "I need to read the project" and stop, having no filesystem
// tool. request_tools removes that failure: it is in every profile, and calling
// it pulls in a whole group for the rest of the turn. The model asks instead of
// giving up — and we still only pay for the heavy tool defs once they're needed.

/** Tool groups the model can pull in mid-turn via request_tools. */
const TOOL_GROUPS: Record<string, ToolDef[]> = {
  filesystem: FS_TOOLS,
  browser: [...PERCEIVE_TOOLS, ...CAPTURE_TOOLS, ...DRIVE_TOOLS],
  research: [...SEARCH_TOOLS, ...TASK_TOOLS]
}

const REQUEST_TOOLS_DEF: ToolDef = {
  name: 'request_tools',
  description:
    'Pull in a group of tools you need but were not given yet, then continue the task. ' +
    'Call this the moment you realize you need to act — never say you will do something you lack the tool for; ask for the tool instead. ' +
    'Groups: "filesystem" (read/search/edit files, run shell commands, install packages), ' +
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

export function selectAgentToolProfile(userText: string): AgentToolProfile {
  const text = userText.toLowerCase()
  const wantsFilesystem = shouldUseWorkspaceContext(text)
  const wantsBrowser = shouldUseDirectBrowserTools(text)
  const wantsResearch = shouldUseWebResearchTools(text)

  if (wantsFilesystem && !wantsBrowser && !wantsResearch) {
    return { name: 'filesystem', tools: withEscalation(FILESYSTEM_TOOLS) }
  }
  if (wantsBrowser && !wantsFilesystem) {
    return { name: 'browser', tools: withEscalation(BROWSER_TOOLS) }
  }
  if (wantsResearch && !wantsFilesystem) {
    return { name: 'research', tools: withEscalation(RESEARCH_TOOLS) }
  }
  if (wantsFilesystem || wantsBrowser || wantsResearch) {
    return { name: 'full', tools: withEscalation(AGENT_TOOLS) }
  }
  return { name: 'conversation', tools: withEscalation(CONVERSATION_TOOLS) }
}
