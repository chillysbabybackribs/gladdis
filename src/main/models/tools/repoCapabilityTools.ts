import type { CapabilityBroker } from '../capabilities/CapabilityBroker'
import type { ToolContext, ToolOutcome } from '../browserTools'

export interface RepoCapabilityToolsDeps {
  capabilityBroker: CapabilityBroker | null
  getWorkspaceRoot: () => string | null
}

type CapabilityName = 'repo_overview' | 'search_repo' | 'repo_grep_task' | 'read_spans' | 'research_dossier' | 'verify_change'

/** Build the broker's per-call context from a {@link ToolContext}. */
function brokerCtx(name: CapabilityName, ctx: ToolContext) {
  return {
    requestId: ctx.requestId ?? `${name.replace(/_/g, '-')}:${ctx.conversationId ?? ctx.tabId}`,
    assistantMessageId: ctx.assistantMessageId,
    taskId: ctx.taskId ?? ctx.conversationId ?? `task-${ctx.tabId}`,
    iteration: ctx.iteration ?? 1
  }
}

function ensureWired(deps: RepoCapabilityToolsDeps, name: CapabilityName): { workspaceRoot: string } | ToolOutcome {
  const workspaceRoot = deps.getWorkspaceRoot()
  if (!workspaceRoot) {
    return { ok: false, text: `${name}: no workspace root selected. Pick a project folder first.` }
  }
  if (!deps.capabilityBroker) {
    return { ok: false, text: `${name}: capability broker not configured.` }
  }
  return { workspaceRoot }
}

export async function runRepoOverview(
  deps: RepoCapabilityToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const wired = ensureWired(deps, 'repo_overview')
  if ('ok' in wired) return wired
  const result = await deps.capabilityBroker!.repoOverview(brokerCtx('repo_overview', ctx), {
    workspaceRoot: wired.workspaceRoot,
    focus: typeof args.focus === 'string' ? args.focus : undefined
  })
  return {
    ok: result.ok,
    text: result.summary,
    structuredContent: asStructuredContent(result.structuredPayload)
  }
}

export async function runSearchRepo(
  deps: RepoCapabilityToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const wired = ensureWired(deps, 'search_repo')
  if ('ok' in wired) return wired
  const query = String(args.query ?? args.pattern ?? '').trim()
  if (!query) {
    return { ok: false, text: 'search_repo: "query" is required.' }
  }
  const result = await deps.capabilityBroker!.searchRepo(brokerCtx('search_repo', ctx), {
    workspaceRoot: wired.workspaceRoot,
    query,
    path: typeof args.path === 'string' ? args.path : undefined,
    glob: typeof args.glob === 'string' ? args.glob : undefined,
    maxResults: Number.isFinite(Number(args.max_results)) ? Number(args.max_results) : undefined
  })
  return {
    ok: result.ok,
    text: result.summary,
    structuredContent: asStructuredContent(result.structuredPayload)
  }
}

export async function runRepoGrepTask(
  deps: RepoCapabilityToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const wired = ensureWired(deps, 'repo_grep_task')
  if ('ok' in wired) return wired
  const task = String(args.task ?? args.query ?? '').trim()
  if (!task) {
    return { ok: false, text: 'repo_grep_task: "task" is required.' }
  }
  const result = await deps.capabilityBroker!.repoGrepTask(brokerCtx('repo_grep_task', ctx), {
    workspaceRoot: wired.workspaceRoot,
    task,
    path: typeof args.path === 'string' ? args.path : undefined,
    glob: typeof args.glob === 'string' ? args.glob : undefined,
    maxVariations: Number.isFinite(Number(args.max_variations)) ? Number(args.max_variations) : undefined,
    maxResults: Number.isFinite(Number(args.max_results)) ? Number(args.max_results) : undefined
  })
  return {
    ok: result.ok,
    text: result.summary,
    structuredContent: asStructuredContent(result.structuredPayload)
  }
}

export async function runReadSpans(
  deps: RepoCapabilityToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const wired = ensureWired(deps, 'read_spans')
  if ('ok' in wired) return wired
  const items = normalizeReadSpanArgs(args)
  if (items.length === 0) {
    return { ok: false, text: 'read_spans: provide "items" or at least a "path".' }
  }
  const result = await deps.capabilityBroker!.readSpans(brokerCtx('read_spans', ctx), {
    workspaceRoot: wired.workspaceRoot,
    items
  })
  return {
    ok: result.ok,
    text: result.summary,
    structuredContent: asStructuredContent(result.structuredPayload)
  }
}

export async function runResearchDossier(
  deps: RepoCapabilityToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const wired = ensureWired(deps, 'research_dossier')
  if ('ok' in wired) return wired
  const query = String(args.query ?? args.focus ?? '').trim()
  if (!query) {
    return { ok: false, text: 'research_dossier: "query" is required.' }
  }
  const result = await deps.capabilityBroker!.researchDossier(brokerCtx('research_dossier', ctx), {
    workspaceRoot: wired.workspaceRoot,
    query,
    glob: typeof args.glob === 'string' ? args.glob : undefined,
    maxResults: Number.isFinite(Number(args.max_results)) ? Number(args.max_results) : undefined
  })
  return {
    ok: result.ok,
    text: result.summary,
    structuredContent: asStructuredContent(result.structuredPayload)
  }
}

export async function runVerifyChange(
  deps: RepoCapabilityToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const wired = ensureWired(deps, 'verify_change')
  if ('ok' in wired) return wired
  const rawChecks = Array.isArray(args.checks) ? args.checks : args.check ? [args.check] : []
  const checks = rawChecks
    .map((value) => String(value).trim())
    .filter(Boolean) as Array<'typecheck' | 'test' | 'build' | 'check'>
  const goal = String(args.goal ?? '').trim() || undefined
  const result = await deps.capabilityBroker!.verifyChange(brokerCtx('verify_change', ctx), {
    workspaceRoot: wired.workspaceRoot,
    ...(checks.length ? { checks } : {}),
    ...(goal ? { goal } : {})
  })
  return {
    ok: result.ok,
    text: result.summary,
    structuredContent: asStructuredContent(result.structuredPayload)
  }
}

function asStructuredContent(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeReadSpanArgs(args: Record<string, any>): Array<{
  path: string
  startLine?: number
  endLine?: number
}> {
  const rawItems = Array.isArray(args.items) ? args.items : []
  const normalized = rawItems
    .map((item) => {
      const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, any> : {}
      const path = String(record.path ?? '').trim()
      if (!path) return null
      const startLine = Number.isFinite(Number(record.start_line)) ? Number(record.start_line) : undefined
      const endLine = Number.isFinite(Number(record.end_line)) ? Number(record.end_line) : undefined
      return { path, ...(startLine != null ? { startLine } : {}), ...(endLine != null ? { endLine } : {}) }
    })
    .filter((item): item is { path: string; startLine?: number; endLine?: number } => Boolean(item))
  if (normalized.length > 0) return normalized

  const path = String(args.path ?? '').trim()
  if (!path) return []
  const startLine = Number.isFinite(Number(args.start_line)) ? Number(args.start_line) : undefined
  const endLine = Number.isFinite(Number(args.end_line)) ? Number(args.end_line) : undefined
  return [{ path, ...(startLine != null ? { startLine } : {}), ...(endLine != null ? { endLine } : {}) }]
}
