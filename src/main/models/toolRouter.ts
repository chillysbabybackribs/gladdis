import type { ChatRequest, Provider } from '../../../shared/types'
import type { ToolDef } from './browserTools'
import type { LlmComplete } from './llm'
import { knownToolByName } from './agentTools'

type BrowserMode = 'none' | 'essential' | 'advanced'
type FilesystemMode = 'none' | 'essential' | 'expanded'
type MemoryMode = 'none' | 'history' | 'notebook' | 'write'

export interface ToolRouterDecision {
  name: string
  tools: ToolDef[]
  usedRouterModel: boolean
  reason: string
}

interface RouterJsonDecision {
  browser?: BrowserMode
  filesystem?: FilesystemMode
  memory?: MemoryMode
  needsShell?: boolean
  reason?: string
}

export interface RouteAgentToolsArgs {
  req: ChatRequest
  provider?: Provider
  latestUserText: string
  hasWorkspaceRoot: boolean
  llm?: LlmComplete
}

const BROWSER_ESSENTIAL = ['search', 'navigate', 'grep_page', 'act'] as const
const BROWSER_ADVANCED = [
  'read_page',
  'read_a11y',
  'watch_network',
  'grep_click',
  'grep_type',
  'execute_in_browser',
  'cdp_command',
  'screenshot',
  'screenshot_app'
] as const
const FILESYSTEM_ESSENTIAL = ['search_files', 'read_file', 'edit_file'] as const
const FILESYSTEM_EXPANDED = ['write_file', 'list_dir'] as const
const SHELL_ESSENTIAL = ['run_command'] as const
const MEMORY_HISTORY = ['recall_history'] as const
const MEMORY_NOTEBOOK = ['memory_read', 'memory_list', 'memory_create_task'] as const
const MEMORY_WRITE = ['memory_write', 'memory_forget'] as const

const BROWSER_SIGNAL_RE =
  /\b(active page|browser|page|tab|website|web site|site|url|open\b|visit\b|navigate\b|search the web|google|duckduckgo|bing|click|type into|selector|xpath|dom|a11y|accessibility|screenshot|canvas|chart)\b/i
const FILESYSTEM_SIGNAL_RE =
  /\b(file|files|repo|repository|workspace|code|component|function|class|typescript|javascript|tsx|react|electron|src\/|package\.json|tsconfig|build|test|lint|refactor|fix|implement|edit|patch)\b/i
const SHELL_SIGNAL_RE =
  /\b(run|terminal|shell|command|install|npm|pnpm|yarn|bun|pip|cargo|go test|pytest|apt-get|brew|git|dev server|start server|typecheck|build|test|lint)\b/i
const FILE_CREATE_SIGNAL_RE =
  /\b(create|add|scaffold|generate|new)\b.{0,24}\b(file|folder|directory|component|module|test)\b|\bnew file\b/i
const BROWSER_ADVANCED_SIGNAL_RE =
  /\b(accessibility|a11y|aria|selector|xpath|shadow dom|canvas|chart|network|xhr|fetch|graphql|api response|json payload|intercept|devtools|cdp|execute script|screenshot|unlabeled icon)\b/i
const MEMORY_SIGNAL_RE =
  /\b(resume|continue where|pick up where|previous chat|earlier chat|history|remember|memory|task notebook|save note|store this)\b/i
const MEMORY_WRITE_SIGNAL_RE =
  /\b(save this|remember this|store this|write memory|persist this|task notebook|scratchpad)\b/i

const ROUTER_SYSTEM =
  'You are Gladdis tool router. Choose the smallest safe tool bundle for the next turn. ' +
  'Prefer 2-4 essential tools per domain. Avoid memory notebook tools unless the user explicitly asks to resume, remember, or keep a task notebook. ' +
  'Return only JSON with keys: browser, filesystem, memory, needsShell, reason. ' +
  'browser: none|essential|advanced. filesystem: none|essential|expanded. memory: none|history|notebook|write.'

export async function routeAgentTools(args: RouteAgentToolsArgs): Promise<ToolRouterDecision> {
  const heuristic = heuristicDecision(args.latestUserText, args.hasWorkspaceRoot)
  const llmDecision = await maybeRouteWithModel(args.llm, args.latestUserText, args.hasWorkspaceRoot)
  const merged = mergeDecisions(heuristic, llmDecision)
  const tools = toolsForDecision(merged)
  return {
    name: routeName(merged),
    tools,
    usedRouterModel: llmDecision !== null,
    reason: merged.reason || heuristic.reason
  }
}

function heuristicDecision(text: string, hasWorkspaceRoot: boolean): Required<RouterJsonDecision> {
  const clean = text.trim()
  const browser = BROWSER_SIGNAL_RE.test(clean)
  const filesystem = FILESYSTEM_SIGNAL_RE.test(clean) || hasWorkspaceRoot
  const advancedBrowser = BROWSER_ADVANCED_SIGNAL_RE.test(clean)
  const needsShell = SHELL_SIGNAL_RE.test(clean)
  const wantsCreate = FILE_CREATE_SIGNAL_RE.test(clean)
  const memorySignal = MEMORY_SIGNAL_RE.test(clean)
  const memoryWrite = MEMORY_WRITE_SIGNAL_RE.test(clean)

  const browserMode: BrowserMode = browser ? (advancedBrowser ? 'advanced' : 'essential') : 'none'
  let filesystemMode: FilesystemMode = filesystem ? 'essential' : 'none'
  if (wantsCreate) filesystemMode = 'expanded'
  if (!filesystem && wantsCreate) filesystemMode = 'expanded'

  let memoryMode: MemoryMode = 'none'
  if (/\b(resume|continue where|pick up where|previous chat|history)\b/i.test(clean)) memoryMode = 'history'
  else if (memorySignal) memoryMode = memoryWrite ? 'write' : 'notebook'

  const reasons: string[] = []
  if (browserMode !== 'none') reasons.push(browserMode === 'advanced' ? 'advanced browser intent' : 'browser intent')
  if (filesystemMode !== 'none') reasons.push(filesystemMode === 'expanded' ? 'file creation/edit intent' : 'repo/code intent')
  if (needsShell) reasons.push('shell/validation intent')
  if (memoryMode !== 'none') reasons.push(memoryMode === 'history' ? 'history lookup intent' : 'explicit memory intent')
  if (reasons.length === 0) reasons.push(hasWorkspaceRoot ? 'workspace available' : 'minimal fallback')

  return {
    browser: browserMode,
    filesystem: filesystemMode,
    memory: memoryMode,
    needsShell,
    reason: reasons.join(', ')
  }
}

async function maybeRouteWithModel(
  llm: LlmComplete | undefined,
  latestUserText: string,
  hasWorkspaceRoot: boolean
): Promise<Required<RouterJsonDecision> | null> {
  if (!llm) return null
  try {
    const raw = await llm(
      ROUTER_SYSTEM,
      JSON.stringify({
        latestUserText,
        hasWorkspaceRoot
      }),
      {
        stage: 'tool_router',
        maxOutputTokens: 160,
        conversationId: null
      }
    )
    const parsed = parseRouterDecision(raw)
    if (!parsed) return null
    return {
      browser: parsed.browser ?? 'none',
      filesystem: parsed.filesystem ?? 'none',
      memory: parsed.memory ?? 'none',
      needsShell: parsed.needsShell === true,
      reason: parsed.reason?.trim() || 'router-model'
    }
  } catch {
    return null
  }
}

function parseRouterDecision(raw: string): RouterJsonDecision | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as RouterJsonDecision
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function mergeDecisions(
  heuristic: Required<RouterJsonDecision>,
  llmDecision: Required<RouterJsonDecision> | null
): Required<RouterJsonDecision> {
  if (!llmDecision) return heuristic
  return {
    browser: maxBrowserMode(heuristic.browser, llmDecision.browser),
    filesystem: maxFilesystemMode(heuristic.filesystem, llmDecision.filesystem),
    memory: maxMemoryMode(heuristic.memory, llmDecision.memory),
    needsShell: heuristic.needsShell || llmDecision.needsShell,
    reason: llmDecision.reason || heuristic.reason
  }
}

function toolsForDecision(decision: Required<RouterJsonDecision>): ToolDef[] {
  const names: string[] = []
  if (decision.browser !== 'none') names.push(...BROWSER_ESSENTIAL)
  if (decision.browser === 'advanced') names.push(...BROWSER_ADVANCED)
  if (decision.filesystem !== 'none') names.push(...FILESYSTEM_ESSENTIAL)
  if (decision.filesystem === 'expanded') names.push(...FILESYSTEM_EXPANDED)
  if (decision.needsShell) names.push(...SHELL_ESSENTIAL)
  if (decision.memory === 'history') names.push(...MEMORY_HISTORY)
  if (decision.memory === 'notebook' || decision.memory === 'write') names.push(...MEMORY_NOTEBOOK)
  if (decision.memory === 'write') names.push(...MEMORY_WRITE)

  if (names.length === 0) {
    if (decision.filesystem !== 'none') names.push(...FILESYSTEM_ESSENTIAL)
    else names.push(...BROWSER_ESSENTIAL)
  }

  const resolved: ToolDef[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    const tool = knownToolByName(name)
    if (!tool) continue
    seen.add(name)
    resolved.push(tool)
  }
  return resolved
}

function routeName(decision: Required<RouterJsonDecision>): string {
  const parts: string[] = []
  if (decision.browser !== 'none') parts.push(decision.browser === 'advanced' ? 'browser-advanced' : 'browser-core')
  if (decision.filesystem !== 'none') parts.push(decision.filesystem === 'expanded' ? 'filesystem-expanded' : 'filesystem-core')
  if (decision.needsShell) parts.push('shell')
  if (decision.memory !== 'none') parts.push(`memory-${decision.memory}`)
  return parts.length ? parts.join('+') : 'browser-core'
}

function maxBrowserMode(left: BrowserMode, right: BrowserMode): BrowserMode {
  return browserRank(left) >= browserRank(right) ? left : right
}

function maxFilesystemMode(left: FilesystemMode, right: FilesystemMode): FilesystemMode {
  return filesystemRank(left) >= filesystemRank(right) ? left : right
}

function maxMemoryMode(left: MemoryMode, right: MemoryMode): MemoryMode {
  return memoryRank(left) >= memoryRank(right) ? left : right
}

function browserRank(mode: BrowserMode): number {
  return mode === 'advanced' ? 2 : mode === 'essential' ? 1 : 0
}

function filesystemRank(mode: FilesystemMode): number {
  return mode === 'expanded' ? 2 : mode === 'essential' ? 1 : 0
}

function memoryRank(mode: MemoryMode): number {
  switch (mode) {
    case 'write':
      return 3
    case 'notebook':
      return 2
    case 'history':
      return 1
    default:
      return 0
  }
}
