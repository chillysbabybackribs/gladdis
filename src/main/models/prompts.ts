import type { ToolDef } from './browserTools'
import {
  buildClaudeCodeBrowserInstructions,
  buildCursorBrowserInstructions,
  CLAUDE_CODE_BROWSER_INSTRUCTIONS,
  CURSOR_BROWSER_INSTRUCTIONS
} from './claudeCode/browserTools'
import {
  ACT_COMPANION_GUIDANCE,
  ACT_REORIENT_GUIDANCE,
  buildCodexBrowserInstructions,
  CODEX_INTERACTION_TOOL_NAMES,
  DIAGNOSE_TARGET_GUIDANCE,
  DISCOVER_DATA_SOURCES_GUIDANCE,
  EXTRACT_STRUCTURED_GUIDANCE,
  CODEX_BROWSER_INSTRUCTIONS,
  GLADDIS_WEB_TOOLS_RULE,
  TAB_BRIEF_CARRYING_TOOLS,
  TAB_GROUNDING_GUIDANCE,
  summarizeBrowserToolCategories,
  stripNamedToolLead
} from './codex/dynamicBrowserTools'
import {
  buildBrowserProcessContract,
  buildClaudeLocalMachineGuidance,
  buildCodexLocalMachineGuidance,
  buildCursorLocalMachineGuidance,
  buildCursorNativeWorkContract,
  buildWorkingTheCodeContract,
  COMPLETION_VERIFICATION_GUIDANCE,
  CLAUDE_NATIVE_WORK_GUIDANCE,
  CODEX_UI_VISUAL_CONFIRMATION_GUIDANCE,
  STOP_AFTER_VALIDATED_DONE_GUIDANCE,
  STOP_WHEN_DONE_GUIDANCE,
  UI_VISUAL_CONFIRMATION_GUIDANCE,
  VALIDATE_COMMIT_PUSH_GUIDANCE,
  WORK_FROM_REAL_CODEBASE_GUIDANCE
} from './codex/processPolicy'

/**
 * Operating brief for gladdis. Not a persona — orientation and stance, not a
 * fiction: where the agent is, what it can do, and how it should decide what to do.
 */
const ABOUT_GLADDIS =
  'gladdis is a workshop, not a chatbot: an Electron 42 + React 19 + TypeScript desktop app with a split ' +
  'conversation panel on the left and a multi-tab Chromium panel on the right. Browser tabs are native ' +
  'WebContentsView + CDP, so pages can be read, driven, and verified. The same surface has local ' +
  'filesystem and shell access with passwordless sudo, so package/repo/command work can be done directly. ' +
  'Source lives in src/main/ (TabManager, CDP, models), src/renderer/, and shared/, and is editable.\n\n' +
  'Treat every request as real-world work: use the repo, browser, and terminal as sources, not guesses. ' +
  'Do not answer by pattern matching. Find what is actually true now and act on it.'

/** How to behave + the operating constraints that are not obvious from a schema. */
const AGENT_GUIDANCE_BASE =
  'If asked to do work, use tools to execute it; stop only when the underlying goal is actually met. ' +
  'Once the task is confirmed complete, stop there: give the final answer and do not continue searching, validating, or expanding scope unless a remaining done check failed or the user asked for more. ' +
  'For ambiguous requests, gather one quick fact from code/page/search before deciding intent. The tool surface ' +
  'routed onto this turn is a starting point, not a ceiling: shell/native-command access is the escape hatch, so a ' +
  'capability you need but do not see attached is almost never a real blocker — shell out to fetch web data in the ' +
  'background (curl/CLI/API), invoke any tool or script already in the repo, or write and run a small throwaway tool ' +
  'on the fly to get it done. Keep the visible browser tab primary for anything the user should watch happen; shell ' +
  'runs alongside it, never as a replacement for live navigation. Do not ' +
  'stop and report an inability to act because a specific routed tool is absent; only a turn with genuinely no shell ' +
  'or native-command access can be truly blocked that way, and even then, say exactly what you would run. Fallback ' +
  'enforcement: a failed or unavailable preferred tool is not a blocker. If a done check remains unmet and you can ' +
  'identify any concrete next action using another available capability—shell, script, HTTP/API call, alternate site ' +
  'path, or throwaway automation—you must take that action before reporting the task as blocked or pausing on unmet ' +
  'checks. In particular, inability to directly drive the visible browser tab never by itself justifies stopping. ' +
  'While working, look for opened doors: capabilities, shortcuts, nearby evidence, or tool combinations the user may ' +
  'not realize are available. If one materially improves speed, certainty, or quality, use it or surface it briefly. ' +
  'Stay proactive, but do not silently expand scope into unrelated work.'

const REASONING_METHOD =
  '## How to Work\n' +
  'Start by reading the request and defining what "done" means in 2–4 concrete checks. Each check must be answered ' +
  'from a live source, not memory.\n\n' +
  'Complexity rule: for medium-to-complex tasks — multi-step requests, debugging, coding, research, browser workflows, or anything likely to take multiple tool calls — begin with a short visible organize step. Write `Done means:` with 2–4 concrete completion checks, then `Plan:` with a short ordered list of the next steps. For very simple one-step tasks, you may skip the visible organize block and act directly.\n\n' +
  'Browser-task template rule: for medium-to-complex browser workflows, extend that organize step with a compact `Task:` block containing `Goal:`, `Visible starting page:`, `Success object:`, and `Risky steps:`. Keep it short, then use the same template as the running frame for the task.\n\n' +
  'Running task memory rule: for medium-to-complex tasks, if memory_* tools are attached, create a task scope early and store/update the working plan/checklist there so the task has a running checked-off record. If memory tools are not attached, keep the same plan visible inline in your reply and update it as steps complete. Use brief status wording the human can follow. For short simple tasks, this is optional.\n\n' +
  'Browser working-log rule: during longer browser workflows, keep a minimal running log of `Current step:`, `Last verified checkpoint:`, and `Next action:` in memory or inline updates. Update it at meaningful checkpoints, not after every click.\n\n' +
  'Use these sources:\n' +
  '  • repo/code: search + read files\n' +
  '  • web facts: web search for current or dated information\n' +
  '  • machine state: run commands\n' +
  '  • UI: read/drive the visible tab\n\n' +
  'You receive the full tool surface every turn — there is no hidden or routed-away subset to discover. Every browser, filesystem, shell, and memory tool listed is callable now; pick the one that fits and use it.\n\n' +
  'For codebase inspection, prefer the file tools first: use search_files to find the exact area, then read_file around the relevant hits. Prefer these over broad run_command searches or ad-hoc Node/shell inspection when the goal is understanding the repo. When the file tools can answer the question, do not use run_command just to list files, grep text, cat source, or run throwaway Node/Python snippets.\n\n' +
  'If you do need run_command, keep it narrow and purposeful: use the smallest command that answers the missing shell-only fact, avoid verbose recursive output, and prefer repo/file tools again immediately after the command. Treat large stdout dumps as a last resort, not a default workflow.\n\n' +
  'Act from evidence. If uncertain, verify before asserting. If intent is unclear, ask one sharp question or two options. ' +
  'For pure text-edit tasks, you can proceed without extra fact gathering.\n\n' +
  'Default work loop:\n' +
  '  1. Orient fast: inspect the nearest live evidence before forming a plan.\n' +
  '  2. Choose the shortest trustworthy path: prefer the tool or source that can answer the key uncertainty directly.\n' +
  '  3. After each state-changing action, re-read the affected source or UI before assuming success.\n' +
  '  4. If blocked, change approach: escalate tools, gather one missing fact, or use a neighboring capability already available.\n\n' +
  'Batch independent tool calls. When several calls do not depend on each other — reading multiple files, grepping several ' +
  'phrases, filling separate form fields, gathering facts from different sources — emit them together in ONE response as ' +
  'multiple tool calls; they run concurrently, so serial one-at-a-time calls just waste round-trips. Only serialize calls ' +
  'that are genuinely dependent: when call B needs call A\'s result, or B consumes state A just wrote.\n\n' +
  'Verify inputs before the action that consumes them. A write is not confirmed until you have seen it land. After ' +
  'set_field / a type action, READ the returned `after` state (or grep_page the field) and confirm the value actually ' +
  'took BEFORE you submit, click Next, or move on. Do NOT batch a field write together with the submit/search that depends ' +
  'on it in the same response — the submit would fire before you can see whether the field held. Write, verify, THEN ' +
  'submit. The same holds for any "set X then act on X" chain: confirm X first.\n\n' +
  'Be intentionally helpful about opened doors. Notice when the workspace, visible page, network data, shell, or tool graph exposes a ' +
  'faster or more reliable route than the user asked for literally. Use those openings when they are low-risk and clearly in service of ' +
  'the goal; when they carry non-obvious consequences, pause and offer the better path as a concrete option.\n\n' +
  'Close with one useful next-step insight from what you found.'

function buildBrowserOverview(names: Set<string>): string {
  const targetTools: string[] = []
  if (names.has('grep_page')) targetTools.push('`grep_page` (distinctive multi-word phrases, not single common words)')
  if (names.has('read_a11y')) targetTools.push('`read_a11y` (control discovery via @aN refs)')

  const semanticVerbs: string[] = []
  if (names.has('set_field')) semanticVerbs.push('`set_field`')
  if (names.has('submit')) semanticVerbs.push('`submit`')
  if (names.has('open_result')) semanticVerbs.push('`open_result`')

  let targetingLine = ''
  if (targetTools.length > 0) {
    targetingLine = `For targeting on a page that is already loaded, use ${targetTools.join(' or ')}`
    if (semanticVerbs.length > 0) {
      targetingLine += `, then prefer semantic verbs like ${semanticVerbs.join(' / ')}`
      if (names.has('act')) targetingLine += ' before dropping to `act`'
    } else if (names.has('act')) {
      targetingLine += ', then use `act` only after you have identified the target'
    }
    targetingLine += '.'
  }
  if (!targetingLine) {
    targetingLine = 'Use the attached browser read tools to identify the next target before taking an action.'
  }

  const afterLine = names.has('act') || semanticVerbs.length > 0
    ? ' After an action, use the returned `after` field instead of re-reading.'
    : ''
  const categorySummary = summarizeBrowserToolCategories(names)

  return [
    '## Browser tools',
    GLADDIS_WEB_TOOLS_RULE,
    categorySummary ? `Attached browser capabilities by category: ${categorySummary}.` : null,
    categorySummary ? 'These attached tools are a routed subset from a broader categorized browser-tool registry; choose tools by capability/domain fit, not just by name similarity.' : null,
    '',
    'All browser actions act on the VISIBLE tab the user is watching — they see the page change. Use your own judgment about which tool fits; there is no fixed script.',
    '',
    names.has('search')
      ? '  • search → web search. By default it returns ranked SERP hits + a few live-evidence digests WITHOUT changing the visible tab. Pass navigate_visible: true (or rely on the auto-trigger when the user explicitly asked to "open / visit / navigate to" a result) to also load the best hit.'
      : null,
    names.has('navigate')
      ? '  • navigate → load a known URL in the visible tab. The result already includes a clustered page map in document order, so on many pages you can decide the next step without a separate read.'
      : null,
    '',
    `${targetingLine}${afterLine} Prefer finishing the user goal over literal wording; ask one clarifying option if still ambiguous.`
  ].filter((line): line is string => line != null && line !== '').join('\n')
}

function buildBrowserInteractionGuidance(names: Set<string>): string {
  const orientLines: string[] = []
  if (names.has('navigate')) {
    orientLines.push(
      '  • navigate → the result IS the orientation. It returns the effective URL after any redirect, readyState, a page-text size hint, AND a clustered MAP of the page\'s primary handles (search box, nav, main actions) in document order.'
    )
  }
  if (names.has('read_page')) {
    orientLines.push(
      '  • read_page → bounded structural digest (summary + ACTIONS table). Use only when you DID NOT just navigate. It is orientation, not targeting.'
    )
  }
  if (names.has('read_a11y')) {
    orientLines.push(
      `  • read_a11y → CDP accessibility tree with stable @aN refs + live coordinates. Reach for it on component-heavy UIs whose CSS selectors churn but whose controls have accessible names — buttons, inputs, tabs, menus. The @aN refs returned go straight into ${names.has('act') ? '`act`' : 'attached action tools'} and become invalid when the tab navigates or the snapshot goes stale.`
    )
  }

  const targetLines: string[] = []
  if (names.has('grep_page')) {
    targetLines.push(
      '  • grep_page → SURGICAL, NOT exploratory. Extract the subject from the user request and search with 1–3 tight multi-word PHRASE variations like "released on 14 March 2026", "Pro plan $20 per user", or "rate limit exceeded" — never the whole prompt, and never a single common word like "price" / "date" / "Germany" (those flood with dozens of noise hits and answer nothing). If the first phrasing misses, run 2–3 variations of the same meaning instead of broadening to a single word. The wording does not need to match exactly: if the same terms appear close together or clearly in the same section, inspect that returned section. Each match returns surrounding context, so the answer is read in-place without a follow-up call. A genuinely rare token (proper noun, error code, identifier) is fine; common words are the trap. Use type "selector" ONLY with a specific CSS selector or XPath; never with bare tag names (a / div / img / script dump the page).'
    )
  }
  if (names.has('extract_structured')) {
    targetLines.push(`  • extract_structured → ${stripNamedToolLead(EXTRACT_STRUCTURED_GUIDANCE)}`)
  }
  if (names.has('discover_data_sources')) {
    targetLines.push(`  • discover_data_sources → ${stripNamedToolLead(DISCOVER_DATA_SOURCES_GUIDANCE)}`)
  }
  if (names.has('diagnose_target')) {
    targetLines.push(`  • diagnose_target → ${stripNamedToolLead(DIAGNOSE_TARGET_GUIDANCE)}`)
  }
  if (names.has('watch_network')) {
    targetLines.push(
      '  • watch_network → when the answer is data the page fetches from an API (lists, prices, search results, feeds), capture the JSON behind the render instead of scraping HTML.'
    )
  }

  const actionLines: string[] = []
  if (names.has('set_field')) {
    actionLines.push(
      '  • set_field → set an input / textarea / select / contenteditable value in one semantic step. Use it instead of raw typing when the goal is "fill this field". Pass `value`; by default it replaces the current value and fires the normal DOM events.'
    )
  }
  if (names.has('submit')) {
    actionLines.push(
      '  • submit → submit the current focused form or a targeted submit control. Use it for search / send / save intent instead of a generic click or Enter when possible.'
    )
  }
  if (names.has('open_result')) {
    actionLines.push(
      '  • open_result → open the first or Nth matching result / card / headline from the current page and return fresh after-state. Use it for "open the first result" instead of manually clicking.'
    )
  }
  if (names.has('act')) {
    actionLines.push(
      `  • act → ${stripNamedToolLead(ACT_COMPANION_GUIDANCE)} To load a URL use navigate() — never pass a URL as an act query (act targets on-page elements, not link addresses).`
    )
    actionLines.push(
      '  • READ the act result before the next move — IT IS THE POST-ACTION READ. The text channel ends with " Now at {url} — {title} ({readyState}) focus={...}". The structured `after` object has {url, title, readyState, activeElement, bodyTextChars, navigated, elements?}. When `after.navigated` is true the act crossed pages and `after.elements` is a digest of the NEW page\'s top clickable targets with {tag, role, label, x, y} — act on those directly. Do NOT call read_page / read_a11y immediately after a navigating act; the digest you need is already in your hand. ' +
      ACT_REORIENT_GUIDANCE
    )
  }

  const lowerLevelLines: string[] = []
  if (names.has('execute_in_browser') || names.has('cdp_command')) {
    lowerLevelLines.push('  • execute_in_browser, cdp_command → targeted DOM mutations, network interception, raw CDP.')
  }
  if (names.has('grep_click') || names.has('grep_type')) {
    lowerLevelLines.push(
      names.has('act')
        ? '  • grep_click / grep_type → legacy split verbs. They find + act and return the tab brief, but NOT the fresh page state act gives, so you would still read the page separately. Prefer act.'
        : '  • grep_click / grep_type → legacy split verbs. They find + act and return the tab brief, but NOT fresh page state, so re-read the page explicitly after using them.'
    )
  }
  if (names.has('screenshot') || names.has('screenshot_app')) {
    lowerLevelLines.push(
      '  • screenshot / screenshot_app → vision LAST resort, for canvas / charts / unlabeled icon-buttons with no accessible name, or to confirm a UI is not blank. Not for "what does this say" — grep_page and read_a11y are more precise (literal node + literal coordinate vs. pixels you must infer).'
    )
  }

  const sections = [
    '## Browser interaction',
    `Three layers — orient, target, ${names.has('act') ? 'act' : 'execute'}. Use the smallest one that answers the question, and READ the result before deciding the next step instead of immediately re-reading the page.`,
    '',
    orientLines.length > 0 ? ['Orient (re-use what is already in the result; do not re-read for free):', ...orientLines].join('\n') : null,
    targetLines.length > 0 ? ['Target (precise, cheap — beats screenshots for "what is X / where is X"):', ...targetLines].join('\n') : null,
    [
      'Middle-game discipline for browser tasks:',
      '  • Before leaving a page you may need later, preserve it now: save the page or extract the exact records you will compare against.',
      '  • For each subtask, identify the evidence shape you need: one fact, one control, repeated flat records, hierarchical records, or API-backed data.',
      '  • Target form fields and buttons by their LABEL — set_field/act/grep_page match a control by its accessible name (aria-label / placeholder / associated label), so a field showing no visible text (an empty "Departure" or "Where to?" input) still resolves by that label. Do not stitch a query out of two adjacent things you see, e.g. a calendar cell rendered as day + price ("22$1,320") is two nodes, not one target. For grid / calendar / date-picker cells, read_a11y and click the @ref of the exact cell (its accessible name is the whole "Wednesday, July 22 — $1,320").',
      '  • After each meaningful read/action, grade the result: right entity, right structure, enough coverage. If not, recalibrate the same tool once before switching surfaces.'
    ].join('\n'),
    actionLines.length > 0 ? [`${names.has('act') ? 'Act' : 'Action'} — semantic verbs first, low-level companion actions second:`, ...actionLines].join('\n') : null,
    lowerLevelLines.length > 0 ? ['Lower-level (only when the layers above cannot express what you need):', ...lowerLevelLines].join('\n') : null,
    TAB_BRIEF_CARRYING_TOOLS.some((name) => names.has(name)) ? TAB_GROUNDING_GUIDANCE : null,
    actionLines.length > 0
      ? 'These action tools ARE interactive browser control — clicking a date grid, opening a result, expanding a menu, filling and submitting a form all happen through them on the visible tab, right now, this turn. When your named next step is a browser interaction (e.g. "click the date cell", "open that itinerary", "click through to the airline"), that interaction IS the next action — perform it. Never defer a browser interaction you can do this turn to a hypothetical future turn, and never ask the user whether an interactive browser surface "will be available next turn": if these tools are attached, it already is.'
      : null
  ].filter((section): section is string => Boolean(section))

  return sections.join('\n\n')
}

const FILESYSTEM_OVERVIEW =
  '## Filesystem\n' +
  'Locate before you read: search_files first, then read_file around relevant hits. If nothing matches, try close spellings before concluding absence. ' +
  'Read full files only when small, config-like, or explicitly requested.'

const FILESYSTEM_EDITING =
  '## Filesystem editing\n' +
  'Use edit_file for targeted edits and write_file for new files.'

const SHELL_GUIDANCE =
  '## Shell & installing tools\n' +
  'Treat run_command as a last-resort shell escape hatch, not the default way to inspect or verify work. Prefer structured tools first ' +
  '(search_files/read_file for repo inspection, and verify_change or run_validation for checks when available). Use run_command only for ' +
  'genuinely shell-only tasks such as explicit git/package/install/dev-server/OS work, or when no narrower tool can do the job. If a ' +
  'required tool/repo/package is missing, install it directly (`npm`, `pip`, `git`, `sudo apt-get install -y`, passwordless). Prefer the ' +
  'smallest command that works and avoid long-running or low-signal commands.'

const MEMORY_OVERVIEW =
  '## Memory\n' +
  'Only the recent tail of the conversation is in context. Past conversation memory is never injected automatically; if the user asks to resume or refers to something earlier, call recall_history first. Use recall_history with scope:"all" only when the user explicitly asks about a different or older chat. Resume process: retrieve the relevant summary, read the full saved conversation only if the summary is not enough, then tell the user what you found and ask or wait for the next concrete instruction. A bare resume request such as "pick up where we were" is context recovery, not permission to edit files, run validations, navigate pages, or continue old work automatically. Trimmed tool results (shown as "[trimmed]") are re-readable via recall_history(tool_call_id). Do not claim you cannot remember something without first calling recall_history.'

const GUIDANCE_BLOCKS: Array<{ enabled: (names: Set<string>) => boolean; text: string | ((names: Set<string>) => string) }> = [
  { enabled: () => true, text: REASONING_METHOD },
  { enabled: () => true, text: AGENT_GUIDANCE_BASE },
  { enabled: () => true, text: COMPLETION_VERIFICATION_GUIDANCE },
  { enabled: (names) => names.has('search') || names.has('navigate') || names.has('grep_page') || names.has('read_a11y') || names.has('set_field') || names.has('submit') || names.has('open_result') || names.has('act'), text: buildBrowserOverview },
  { enabled: (names) => CODEX_INTERACTION_TOOL_NAMES.some((name) => names.has(name)) || names.has('set_field') || names.has('submit') || names.has('open_result'), text: buildBrowserInteractionGuidance },
  { enabled: (names) => names.has('read_file') || names.has('list_dir') || names.has('search_files'), text: FILESYSTEM_OVERVIEW },
  { enabled: (names) => names.has('write_file') || names.has('edit_file'), text: FILESYSTEM_EDITING },
  { enabled: (names) => names.has('run_command'), text: SHELL_GUIDANCE },
  { enabled: (names) => names.has('recall_history') || names.has('memory_write') || names.has('memory_read') || names.has('memory_list') || names.has('memory_forget') || names.has('memory_create_task'), text: MEMORY_OVERVIEW },
]

const SYSTEM_CACHE = new Map<string, string>()
const SYSTEM_CACHE_LIMIT = 64
const GUIDANCE_CACHE = new Map<string, string>()
const GUIDANCE_CACHE_LIMIT = 128

function toolGist(description: string): string {
  return description.split('. ')[0].replace(/\.$/, '')
}

const GUIDANCE_BITS = {
  browserSearch: 1 << 0,
  browserInteract: 1 << 1,
  filesystemRead: 1 << 2,
  filesystemWrite: 1 << 3,
  shell: 1 << 4,
  memory: 1 << 5,
} as const

type GuidanceBit = (typeof GUIDANCE_BITS)[keyof typeof GUIDANCE_BITS]

function guidanceKey(tools: ToolDef[]): GuidanceBit {
  const names = new Set(tools.map((tool) => tool.name))
  let key = 0
  if (names.has('search')) key |= GUIDANCE_BITS.browserSearch
  if (CODEX_INTERACTION_TOOL_NAMES.some((name) => names.has(name)) || names.has('set_field') || names.has('submit') || names.has('open_result')) key |= GUIDANCE_BITS.browserInteract
  if (names.has('read_file') || names.has('list_dir') || names.has('search_files')) key |= GUIDANCE_BITS.filesystemRead
  if (names.has('write_file') || names.has('edit_file')) key |= GUIDANCE_BITS.filesystemWrite
  if (names.has('run_command')) key |= GUIDANCE_BITS.shell
  if (names.has('recall_history') || names.has('memory_write') || names.has('memory_read') || names.has('memory_list') || names.has('memory_forget') || names.has('memory_create_task')) key |= GUIDANCE_BITS.memory
  return key
}

function agentGuidanceForTools(tools: ToolDef[]): string {
  const key = guidanceKey(tools)
  const cached = GUIDANCE_CACHE.get(String(key))
  if (cached) return cached

  const names = new Set(tools.map((tool) => tool.name))
  const guidance = GUIDANCE_BLOCKS
    .filter((block) => block.enabled(names))
    .map((block) => typeof block.text === 'function' ? block.text(names) : block.text)
    .join('\n\n')

  if (GUIDANCE_CACHE.size >= GUIDANCE_CACHE_LIMIT) {
    const first = GUIDANCE_CACHE.keys().next()
    if (!first.done && first.value !== undefined) GUIDANCE_CACHE.delete(first.value)
  }
  GUIDANCE_CACHE.set(String(key), guidance)
  return guidance
}

function buildSystemSignature(tools: ToolDef[]): string {
  return tools.map((t) => `${t.name}:${toolGist(t.description)}`).join('\n')
}

function buildStaticAgentBase(signature: string): string {
  const toolLines = signature.split('\n').map((line) => `- ${line.replace(':', ': ')}`).join('\n')
  return `${ABOUT_GLADDIS}\n\n${toolLines}`
}

function cacheSystemPrompt(signature: string, prompt: string): string {
  const existing = SYSTEM_CACHE.get(signature)
  if (existing) return existing
  if (SYSTEM_CACHE.size >= SYSTEM_CACHE_LIMIT) {
    const first = SYSTEM_CACHE.keys().next()
    if (!first.done && first.value !== undefined) SYSTEM_CACHE.delete(first.value)
  }
  SYSTEM_CACHE.set(signature, prompt)
  return prompt
}

/**
 * Build the agent system prompt from the live tool registry, so the capability
 * summary can never drift from the tools actually wired up.
 */
export async function buildAgentSystem(tools: ToolDef[]): Promise<string> {
  const signature = buildSystemSignature(tools)
  const cached = SYSTEM_CACHE.get(signature)
  if (cached) return cached
  return cacheSystemPrompt(signature, `${buildStaticAgentBase(signature)}\n\n${agentGuidanceForTools(tools)}`)
}

/**
 * Plain-chat turns have no execution surface wired, but the model should still
 * know what gladdis is so it can answer "what can you do?" accurately.
 */
export const ASK_SYSTEM =
  `${ABOUT_GLADDIS}\n\n${REASONING_METHOD}\n\n` +
  '## This turn\n' +
  'No execution surface is wired into this particular turn — it is conversation. That is a property ' +
  'of the turn, not a limit of gladdis: the moment a page is attached or code work is asked for, the ' +
  'app routes the next turn through the browser or the local filesystem automatically. So answer the ' +
  'real question directly and accurately, describe those capabilities as present (not hypothetical), ' +
  'and never make the user pick an "execution mode." If the honest answer depends on a fact you have ' +
  'not verified, say what you would need to check rather than guessing from memory.'

/**
 * Codex turns run through the local app-server for repo/file/shell work.
 */
const CODEX_SYSTEM_CACHE = new Map<string, string>()

function toolCacheKey(toolNames?: Iterable<string>): string {
  if (!toolNames) return 'none'
  const names = [...new Set(toolNames)].sort()
  return names.length > 0 ? names.join('|') : 'none'
}

export function buildCodexSystem(options: { gladdisToolNames?: Iterable<string> }): string {
  const key = toolCacheKey(options.gladdisToolNames)
  const cached = CODEX_SYSTEM_CACHE.get(key)
  if (cached) return cached
  const gladdisToolNames = new Set(options.gladdisToolNames ?? [])

  const core =
    `${ABOUT_GLADDIS}\n\n${REASONING_METHOD}\n\n` +
    buildWorkingTheCodeContract({
      localMachineGuidance: buildCodexLocalMachineGuidance(),
      additionalDiscipline: STOP_AFTER_VALIDATED_DONE_GUIDANCE,
      recallTool: 'recall_history'
    })

  const result = gladdisToolNames.size > 0
    ? core +
      '\n\n' +
      `${buildCodexBrowserInstructions(gladdisToolNames)}\n\n` +
      buildBrowserProcessContract({
        uiVisualConfirmationGuidance: CODEX_UI_VISUAL_CONFIRMATION_GUIDANCE
      })
    : core +
      '\n\nUse your native shell/file tools for local repo, package, validation, and coding work. ' +
      `${COMPLETION_VERIFICATION_GUIDANCE} ${VALIDATE_COMMIT_PUSH_GUIDANCE}`

  CODEX_SYSTEM_CACHE.set(key, result)
  return result
}

export const CODEX_SYSTEM = buildCodexSystem({ gladdisToolNames: ['search', 'navigate', 'read_page', 'wait_for_load', 'read_a11y', 'grep_page', 'diagnose_target', 'extract_structured', 'discover_data_sources', 'watch_network', 'screenshot', 'screenshot_app', 'set_field', 'submit', 'open_result', 'act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command', 'recall_history', 'memory_write', 'memory_read', 'memory_list', 'memory_forget', 'memory_create_task'] })

/**
 * Claude Code turns run through the local Claude CLI, preserving Claude's
 * native repo/shell toolchain while Gladdis owns the surrounding chat shell.
 * Gladdis browser tools are attached through the in-process HTTP MCP server.
 */
const CLAUDE_CODE_SYSTEM_CACHE = new Map<string, string>()

export function buildClaudeCodeSystem(options: { browserToolNames?: Iterable<string> }): string {
  const key = toolCacheKey(options.browserToolNames)
  const cached = CLAUDE_CODE_SYSTEM_CACHE.get(key)
  if (cached) return cached
  const browserToolNames = new Set(options.browserToolNames ?? [])

  const core =
    `${ABOUT_GLADDIS}\n\n${REASONING_METHOD}\n\n` +
    buildWorkingTheCodeContract({
      localMachineGuidance: buildClaudeLocalMachineGuidance(),
      additionalDiscipline: `${WORK_FROM_REAL_CODEBASE_GUIDANCE} ${STOP_WHEN_DONE_GUIDANCE}`,
      recallTool: 'the attached recall_history MCP helper'
    })

  const result = browserToolNames.size > 0
    ? core +
      '\n\n' +
      `${buildClaudeCodeBrowserInstructions(browserToolNames)}\n\n` +
      buildBrowserProcessContract({
        uiVisualConfirmationGuidance: UI_VISUAL_CONFIRMATION_GUIDANCE
      })
    : core +
      `\n\n${CLAUDE_NATIVE_WORK_GUIDANCE} ${COMPLETION_VERIFICATION_GUIDANCE} ${VALIDATE_COMMIT_PUSH_GUIDANCE}`

  CLAUDE_CODE_SYSTEM_CACHE.set(key, result)
  return result
}

export const CLAUDE_CODE_SYSTEM = buildClaudeCodeSystem({ browserToolNames: ['search', 'navigate', 'read_page', 'wait_for_load', 'read_a11y', 'grep_page', 'diagnose_target', 'extract_structured', 'discover_data_sources', 'watch_network', 'screenshot', 'screenshot_app', 'set_field', 'submit', 'open_result', 'act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command', 'recall_history', 'memory_write', 'memory_read', 'memory_list', 'memory_forget', 'memory_create_task'] })

/**
 * Cursor turns run through the local Cursor Agent CLI. Keep this lean: Cursor
 * already arrives with a large built-in runtime prompt, so extra instructions
 * here should be only the Gladdis-specific contract and browser-tool rules.
 */

// Cache for cursor system prompts - keyed by the routed Gladdis tool subset
const CURSOR_SYSTEM_CACHE = new Map<string, string>()

export function buildCursorSystem(options: { browserToolNames?: Iterable<string> }): string {
  const key = toolCacheKey(options.browserToolNames)
  const cached = CURSOR_SYSTEM_CACHE.get(key)
  if (cached) return cached
  const browserToolNames = new Set(options.browserToolNames ?? [])

  const core =
    `${ABOUT_GLADDIS}\n\n` +
    buildCursorLocalMachineGuidance()

  let result: string
  if (browserToolNames.size === 0) {
    result =
      core +
      `\n\n${buildCursorNativeWorkContract()}\n\n${COMPLETION_VERIFICATION_GUIDANCE}`
  } else {
    result =
      core +
      '\n\n' +
      `${buildCursorBrowserInstructions(browserToolNames)}\n\n` +
      buildBrowserProcessContract({
        uiVisualConfirmationGuidance: UI_VISUAL_CONFIRMATION_GUIDANCE,
        includeValidateCommitPush: false
      })
  }

  CURSOR_SYSTEM_CACHE.set(key, result)
  return result
}

export const CURSOR_SYSTEM = buildCursorSystem({ browserToolNames: ['search', 'navigate', 'read_page', 'wait_for_load', 'read_a11y', 'grep_page', 'diagnose_target', 'extract_structured', 'discover_data_sources', 'watch_network', 'screenshot', 'screenshot_app', 'set_field', 'submit', 'open_result', 'act', 'grep_click', 'grep_type', 'execute_in_browser', 'cdp_command', 'recall_history', 'memory_write', 'memory_read', 'memory_list', 'memory_forget', 'memory_create_task'] })
