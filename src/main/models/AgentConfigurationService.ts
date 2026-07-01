import {
  type ChatRequest,
  type OptimizeAgentResult,
  type ChatStreamEvent,
  type ChatAgentSelection
} from '../../../shared/types'
import { BrowserTools, type ToolContext } from './browserTools'
import {
  knownToolByName,
  normalizeToolName
} from './agentTools'
import type { ToolDef } from './browserTools'

/** A turn's tool surface after routing + any per-agent user policy. */
export interface AgentToolSurface {
  name: string
  tools: ToolDef[]
}
import { stripActivePagePreamble } from './routing'
import { taskIdForRequest } from './loopStateEmitter'
import { buildAgentSystem } from './prompts'
import { isBareContinuation } from '../../../shared/types'
import type { Provider } from '../../../shared/types'
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService'
import type { LlmComplete } from './llm'
import { routeAgentTools } from './toolRouter'

export class AgentConfigurationService {
  constructor(
    private tools: BrowserTools,
    private repoIntelligence: RepoIntelligenceService,
    private emit: (e: ChatStreamEvent) => void,
    private routeWithModel?: LlmComplete
  ) {}

  public async codexRepoOverviewBlock(req: ChatRequest, userText: string): Promise<string | null> {
    const workspaceRoot = this.tools.getWorkspaceRoot()
    if (!workspaceRoot) return null
    try {
      const result = await this.repoIntelligence.repoOverview({
        workspaceRoot,
        focus: userText.trim() || undefined
      })
      return `Workspace intelligence:\n${result.summary}`
    } catch {
      return null
    }
  }

  public latestSubstantiveUserText(req: ChatRequest): string {
    const users = [...req.messages].filter((m) => m.role === 'user')
    const current = users.at(-1)
    const currentText = current ? stripActivePagePreamble(current.content).trim() : ''
    if (currentText && !isBareContinuation(currentText)) return currentText
    const previous = users.slice(0, -1).reverse().find((m) => stripActivePagePreamble(m.content).trim())
    return previous ? stripActivePagePreamble(previous.content).trim() : currentText
  }

  public toolContext(req: ChatRequest, llm?: LlmComplete): ToolContext {
    return {
      tabId: this.tools.tabs.liveTabId(req.tabId),
      requestId: req.requestId,
      assistantMessageId: req.assistantMessageId,
      conversationId: req.conversationId ?? null,
      latestUserText: this.latestSubstantiveUserText(req),
      taskId: taskIdForRequest(req),
      iteration: 1,
      fullResults: new Map<string, string>(),
      llm,
      workspaceRoot: this.tools.getWorkspaceRoot() ?? process.cwd(),
      onProgress: (event: any) => {
        this.emit({
          requestId: req.requestId,
          type: 'progress_step',
          ...event
        })
      }
    }
  }

  /**
   * Route the turn onto a compact tool surface, then apply any saved
   * preferred/disallowed-tool policy from the selected agent.
   */
  public async agentToolProfile(
    req: ChatRequest,
    _provider?: Provider
  ): Promise<AgentToolSurface> {
    const routed = await routeAgentTools({
      req,
      provider: _provider,
      latestUserText: this.latestSubstantiveUserText(req),
      hasWorkspaceRoot: Boolean(this.tools.getWorkspaceRoot()),
      llm: this.routeWithModel
    })
    return this.applyAgentToolPolicy(req, { name: routed.name, tools: routed.tools })
  }

  private applyAgentToolPolicy(
    req: ChatRequest,
    baseProfile: AgentToolSurface
  ): AgentToolSurface {
    const agent = req.agent
    if (!agent) return baseProfile

    const requested = this.agentBlueprintToolConstraints(agent)
    if (!requested) return baseProfile

    const withPolicy = [...baseProfile.tools]
    const used = new Set(withPolicy.map((tool) => tool.name))

    for (const name of requested.toAdd) {
      if (used.has(name)) continue
      const tool = knownToolByName(name)
      if (tool && !used.has(tool.name)) {
        withPolicy.push(tool)
        used.add(tool.name)
      }
    }
    if (requested.toRemove.length) {
      for (let i = withPolicy.length - 1; i >= 0; i--) {
        const tool = withPolicy[i]
        if (tool && requested.toRemove.includes(tool.name)) {
          withPolicy.splice(i, 1)
        }
      }
    }

    return { ...baseProfile, tools: withPolicy }
  }

  public agentBlueprintToolConstraints(blueprint: OptimizeAgentResult | ChatAgentSelection): {
    toAdd: string[]
    toRemove: string[]
  } | null {
    const preferred = blueprint.preferredTools?.length ? blueprint.preferredTools : []
    const disallowed = blueprint.disallowedTools?.length ? blueprint.disallowedTools : []

    if (!preferred.length && !disallowed.length) return null

    const toAdd: string[] = []
    const toRemove: string[] = []

    const normalize = (values?: string[]): string[] => {
      const normalized = (values ?? [])
        .map((value) => normalizeToolName(value))
        .filter((name): name is string => Boolean(name))
      return [...new Set(normalized)]
    }
    for (const value of normalize(preferred)) {
      if (knownToolByName(value)) {
        toAdd.push(value)
      }
    }
    for (const value of normalize(disallowed)) {
      if (knownToolByName(value)) {
        toRemove.push(value)
      }
    }

    if (!toAdd.length && !toRemove.length) return null
    return { toAdd, toRemove }
  }

  public customAgentSystemBlock(req: ChatRequest): string | null {
    const agent = req.agent
    if (!agent?.prompt.trim()) return null

    const metadata: string[] = []
    const addList = (label: string, values?: string[]) => {
      if (!values?.length) return
      metadata.push(`${label}:`)
      metadata.push(...values.filter(Boolean).map((value) => `- ${value}`))
    }
    const addSection = (label: string, value?: string) => {
      const clean = value?.trim()
      if (clean) metadata.push(`${label}: ${clean}`)
    }
    const addBoolean = (label: string, value?: boolean) => {
      if (typeof value === 'boolean') metadata.push(`${label}: ${value ? 'yes' : 'no'}`)
    }

    addSection('Goal', agent.goal)
    addSection('Optimizer model', agent.optimizerModelId)
    addSection('Runtime model', agent.runtimeModelId)
    addSection('Task family', agent.taskFamily)
    addBoolean('Workspace-bound', agent.workspaceBound)
    addList('Preferred tools', agent.preferredTools)
    addList('Disallowed tools', agent.disallowedTools)
    addList('Known paths', agent.knownPaths)
    addList('Known commands', agent.knownCommands)
    addList('Workflow steps', agent.workflowSteps)
    addList('Verification steps', agent.verificationSteps)
    addList('Stop conditions', agent.stopConditions)
    addList('Fallback rules', agent.fallbackRules)
    addList('Assumptions', agent.assumptions)
    addList('Test tasks', agent.testTasks)
    addSection('Optimization summary', agent.optimizationSummary)
    addList('Evidence notes', agent.evidenceNotes)
    addList('Validation notes', agent.validationNotes)

    const sections = metadata.length ? ['## Agent blueprint', ...metadata, '', ''] : []

    return [
      ...sections,
      '## Selected Custom Agent',
      `Name: ${agent.name}`,
      '',
      agent.prompt.trim()
    ].join('\n')
  }

  public async buildTurnAgentSystem(
    req: ChatRequest,
    tools: Parameters<typeof buildAgentSystem>[0],
    provider?: Provider,
    ctx?: Pick<ToolContext, 'tabId' | 'conversationId' | 'workspaceRoot'>
  ): Promise<string> {
    const base = await buildAgentSystem(tools)
    const providerBlock = provider === 'openai' || provider === 'grok' ? DIRECT_API_WORKSHOP_BLOCK : null
    const calibrationBlock = this.tools.calibrationBlock(
      tools.map((tool) => tool.name),
      ctx ?? this.toolContext(req)
    )
    const custom = this.customAgentSystemBlock(req)
    return [base, calibrationBlock, providerBlock, custom].filter(Boolean).join('\n\n')
  }

  public workspaceSystemBlock(_profile?: AgentToolSurface): string | null {
    const folder = this.tools.getWorkspaceRoot()
    if (!folder) return null
    return `Workspace: ${folder}`
  }
}

const DIRECT_API_WORKSHOP_BLOCK =
  '## Direct API local-work contract\n' +
  'This direct API turn does local repo, file, edit, validation, and shell work through Gladdis tools. ' +
  'Use them as your primary local environment for this turn.\n\n' +
  'For codebase inspection, stay surgical: use search_files to locate the exact area before any raw reads, then ' +
  'read_file with explicit start_line/end_line windows. Avoid full:true unless the file is small, config-like, or ' +
  'the user explicitly asked for the whole file.\n\n' +
  'For local work, prefer the narrowest tool that matches the job: search_files/read_file for inspection, edit_file for exact patches, ' +
  'write_file only when creating or fully replacing a file, and verify_change or run_validation for validation when available. Treat ' +
  'run_command as a fallback for explicit shell tasks like git/package/install/dev-server work, not as the default path for checks or ' +
  'codebase reading. Keep Gladdis browser tools first-class for web search and page work inside the visible Chromium tab; do not treat ' +
  'shell/browser commands as substitutes for web tasks.'
