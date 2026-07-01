import type { ToolOutcome } from './browserTools'

export type ToolSurface = 'browser' | 'filesystem' | 'shell' | 'memory'

export interface ToolFailureNote {
  tool: string
  surface: ToolSurface
  iteration: number | null
  summary: string
}

export interface ToolCalibrationState {
  staleSurfaces: Partial<Record<ToolSurface, string>>
  recentFailures: ToolFailureNote[]
}

export function createToolCalibrationState(): ToolCalibrationState {
  return {
    staleSurfaces: {},
    recentFailures: []
  }
}

export function toolSurfaceForName(name: string): ToolSurface | null {
  if (
    name === 'search' ||
    name === 'navigate' ||
    name === 'act' ||
    name === 'set_field' ||
    name === 'submit' ||
    name === 'open_result' ||
    name === 'grep_page' ||
    name === 'read_page' ||
    name === 'read_a11y' ||
    name === 'extract_structured' ||
    name === 'discover_data_sources' ||
    name === 'watch_network' ||
    name === 'screenshot' ||
    name === 'screenshot_app' ||
    name === 'execute_in_browser' ||
    name === 'cdp_command' ||
    name === 'grep_click' ||
    name === 'grep_type'
  ) {
    return 'browser'
  }
  if (
    name === 'read_file' ||
    name === 'write_file' ||
    name === 'edit_file' ||
    name === 'list_dir' ||
    name === 'search_files'
  ) {
    return 'filesystem'
  }
  if (name === 'run_command') return 'shell'
  if (
    name === 'recall_history' ||
    name === 'memory_write' ||
    name === 'memory_read' ||
    name === 'memory_list' ||
    name === 'memory_forget' ||
    name === 'memory_create_task'
  ) {
    return 'memory'
  }
  return null
}

export function buildToolCalibrationBlock(args: {
  toolNames: Iterable<string>
  workspaceRoot: string | null
  tabId?: string | null
  state?: ToolCalibrationState | null
}): string {
  const surfaces = new Set<ToolSurface>()
  for (const name of args.toolNames) {
    const surface = toolSurfaceForName(name)
    if (surface) surfaces.add(surface)
  }

  const lines = [
    '## Tool calibration',
    'Use light calibration, not a broad probe sweep. Calibrate the current tool before switching to another one.',
    '',
    'Pre-turn checks:',
  ]

  if (surfaces.has('browser')) {
    lines.push(
      `- Browser surface is attached to the visible tab${args.tabId ? ` (${args.tabId})` : ''}; start from navigate()/set_field()/submit()/open_result()/act() results before deeper reads.`
    )
  }
  if (surfaces.has('filesystem')) {
    lines.push(
      args.workspaceRoot
        ? `- Filesystem surface is rooted at ${args.workspaceRoot}; locate targets with search_files before broad reads or edits.`
        : '- Filesystem surface has no selected workspace root; verify paths before file work.'
    )
  }
  if (surfaces.has('shell')) {
    lines.push('- Shell surface is available; use it only for shell-only facts or validation, not as a first-pass inspector.')
  }
  if (surfaces.has('memory')) {
    lines.push(
      args.workspaceRoot
        ? '- Memory surface shares the current workspace scope; confirm scope/task before reading or writing memory.'
        : '- Memory tools depend on the active workspace scope; confirm it before retrying a memory action.'
    )
  }

  const state = args.state
  const stale = state ? Object.entries(state.staleSurfaces) : []
  const recent = state?.recentFailures ?? []
  if (stale.length || recent.length) lines.push('', 'Current signals from this task:')
  for (const [surface, reason] of stale) {
    if (!reason) continue
    lines.push(`- ${capitalize(surface)} surface changed recently: ${reason}`)
  }
  for (const failure of recent.slice(0, 2)) {
    const at = failure.iteration ? ` at iteration ${failure.iteration}` : ''
    lines.push(`- Recent ${failure.surface} failure: ${failure.tool}${at} -> ${failure.summary}`)
  }

  lines.push(
    '',
    'Refine the current tool before switching:',
  )
  if (surfaces.has('browser')) {
    lines.push('- Before leaving a page you may need later, preserve the current evidence shape now: save the page or extract the exact records you will compare against.')
    lines.push('- For the next browser subtask, name the evidence shape you need: single fact, control target, repeated flat records, hierarchical records, or API-backed data.')
    lines.push('- If read_a11y is noisy or incomplete, retry read_a11y first with a better focus, viewportOnly, or interactiveOnly setting to get the right slice.')
    lines.push('- If grep_page misses, keep grep_page and try 2-3 sharper subject-based phrase variations, not the whole prompt and not a one-word probe, or use a precise selector/XPath before abandoning it.')
    lines.push('- If extract_structured is wrong, tighten the item selector/XPath, field selectors, or scope before switching tools.')
    lines.push('- If discover_data_sources says the page is server-rendered, stay in DOM/a11y tools; if it surfaces strong JSON/GraphQL candidates, prefer those before broad scraping.')
    lines.push('- If act misses its target, refresh the page state with read_a11y or a phrased grep_page, then retry act with a fresh ref/query.')
  }
  if (surfaces.has('filesystem')) {
    lines.push('- If search_files is noisy, refine the query or glob before falling back to shell or broader reads.')
    lines.push('- If read_file misses the area, use search_files or a narrower line window before changing tools.')
  }
  lines.push(
    '',
    'Mid-turn recalibration triggers:',
    '- Any tool returns ok:false.',
    '- A tool changes state: browser navigation/DOM actions, file edits/writes, shell commands, or memory writes.',
    '- The tool returns the wrong shape even if the content looks relevant (missing order, hierarchy, pairing, or enough coverage).',
    '- When triggered, retry the same tool with a tighter scope/query/parameter set if it can express the need. Switch tools only when the current tool cannot.'
  )

  return lines.join('\n')
}

export function noteToolCalibrationOutcome(
  state: ToolCalibrationState,
  name: string,
  outcome: Pick<ToolOutcome, 'ok' | 'text'>,
  iteration?: number
): void {
  const surface = toolSurfaceForName(name)
  if (!surface) return

  if (outcome.ok) {
    const staleReason = staleReasonForTool(name)
    if (staleReason) state.staleSurfaces[surface] = staleReason
    if (name === 'read_file' || name === 'search_files' || name === 'list_dir') delete state.staleSurfaces.filesystem
    if (name === 'navigate' || name === 'read_page' || name === 'read_a11y' || name === 'grep_page') {
      delete state.staleSurfaces.browser
    }
    if (name === 'memory_read' || name === 'memory_list' || name === 'recall_history') delete state.staleSurfaces.memory
    if (name === 'run_command') delete state.staleSurfaces.shell
    return
  }

  const summary = compactSummary(outcome.text)
  state.recentFailures = [
    { tool: name, surface, iteration: typeof iteration === 'number' ? iteration : null, summary },
    ...state.recentFailures.filter((entry) => !(entry.tool === name && entry.summary === summary))
  ].slice(0, 4)
  if (state.staleSurfaces[surface] == null) {
    state.staleSurfaces[surface] = `the last ${surface} action failed and needs a fresh orientation step`
  }
}

export function maybeAddRecalibrationHint(
  state: ToolCalibrationState,
  name: string,
  outcome: ToolOutcome
): ToolOutcome {
  if (outcome.ok) return outcome
  const surface = toolSurfaceForName(name)
  if (!surface) return outcome

  const stale = state.staleSurfaces[surface]
  const hint = recalibrationHint(name, surface, stale)
  if (outcome.text.includes('Recalibration hint:')) return outcome
  return {
    ...outcome,
    text: `${outcome.text}\n\nRecalibration hint: ${hint}`
  }
}

function staleReasonForTool(name: string): string | null {
  if (name === 'navigate') return 'a navigation landed; rely on the new page state, not older assumptions'
  if (name === 'act' || name === 'set_field' || name === 'submit' || name === 'open_result' || name === 'execute_in_browser' || name === 'cdp_command' || name === 'grep_click' || name === 'grep_type') {
    return 'the page may have changed; prefer a fresh browser read before retrying a brittle action'
  }
  if (name === 'edit_file' || name === 'write_file') {
    return 'local files changed; re-read or validate the affected area before the next dependent step'
  }
  if (name === 'run_command') return 'a shell command may have changed local state; verify the affected files/status before continuing'
  if (name === 'memory_write' || name === 'memory_forget' || name === 'memory_create_task') {
    return 'memory state changed; confirm the active scope/task before the next memory step'
  }
  return null
}

function recalibrationHint(name: string, surface: ToolSurface, staleReason?: string): string {
  const prefix = staleReason ? `${staleReason}; ` : ''
  if (name === 'read_a11y') {
    return `${prefix}retry read_a11y first with a tighter focus, viewportOnly, or interactiveOnly:false if you need a broader capture, then use the refreshed refs.`
  }
  if (name === 'grep_page') {
    return `${prefix}keep using grep_page but try a more distinctive multi-word phrase, 2-3 phrasing variations, or a precise selector/XPath before switching tools.`
  }
  if (name === 'extract_structured') {
    return `${prefix}keep extract_structured and narrow the item selector/XPath, field selectors, or field scope before switching tools.`
  }
  if (name === 'discover_data_sources') {
    return `${prefix}retry discover_data_sources with a tighter filter or a fresh passive window, or arm watch_network before the next action if the page is currently idle.`
  }
  if (name === 'act') {
    return `${prefix}refresh targeting with read_a11y or a phrased grep_page, then retry act with a fresh ref/query instead of jumping sideways.`
  }
  if (name === 'search_files') {
    return `${prefix}keep search_files and tighten the query, glob, or path before switching to broader inspection tools.`
  }
  if (name === 'read_file') {
    return `${prefix}re-locate the target with search_files or adjust the line window, then retry read_file rather than switching tools.`
  }
  switch (surface) {
    case 'browser':
      return `${prefix}re-orient from the latest browser state, then retry the same browser tool with tighter inputs before switching tools.`
    case 'filesystem':
      return `${prefix}re-locate the target, then retry the same filesystem tool with narrower inputs before switching tools.`
    case 'shell':
      return `${prefix}inspect the failure and retry the narrowest command or validation step instead of escalating immediately.`
    case 'memory':
      return `${prefix}re-check workspace/task scope and retry the same memory operation with corrected scope details.`
  }
}

function compactSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
