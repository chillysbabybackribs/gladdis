import {
  type ChatRequest,
  type OptimizeAgentResult,
  type ChatStreamEvent,
  type ChatAgentSelection
} from '../../../shared/types'
import { BrowserTools, type ToolContext } from './browserTools'
import {
  selectAgentToolProfile,
  knownToolByName,
  normalizeToolName
} from './agentTools'
import { stripActivePagePreamble } from './routing'
import { taskIdForRequest } from './loopStateEmitter'
import { buildAgentSystem } from './prompts'
import { isBareContinuation } from '../../../shared/types'
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService'
import type { LlmComplete } from '../pipeline/Planner'

export class AgentConfigurationService {
  constructor(
    private tools: BrowserTools,
    private repoIntelligence: RepoIntelligenceService,
    private emit: (e: ChatStreamEvent) => void
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

  public agentToolProfile(req: ChatRequest): ReturnType<typeof selectAgentToolProfile> {
    const baseText = this.latestSubstantiveUserText(req)
    const profile = selectAgentToolProfile(baseText)
    return this.applyAgentToolPolicy(req, profile)
  }

  private applyAgentToolPolicy(
    req: ChatRequest,
    baseProfile: ReturnType<typeof selectAgentToolProfile>
  ): ReturnType<typeof selectAgentToolProfile> {
    const agent = req.agent
    if (!agent) return baseProfile

    const requested = this.agentBlueprintToolConstraints(agent)
    if (!requested) return baseProfile

    const withPolicy = [...baseProfile.tools]
    const used = new Set(withPolicy.map((tool) => tool.name))
    const keepRequestTools = withPolicy.some((tool) => tool.name === 'request_tools')

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
        if (tool && requested.toRemove.includes(tool.name) && tool.name !== 'request_tools') {
          withPolicy.splice(i, 1)
        }
      }
    }
    if (!withPolicy.some((tool) => tool.name === 'request_tools') && keepRequestTools) {
      const requestTools = knownToolByName('request_tools')
      if (requestTools) withPolicy.push(requestTools)
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
    tools: Parameters<typeof buildAgentSystem>[0]
  ): Promise<string> {
    const base = await buildAgentSystem(tools)
    const custom = this.customAgentSystemBlock(req)
    return [base, custom].filter(Boolean).join('\n\n')
  }

  public workspaceSystemBlock(profile?: ReturnType<typeof selectAgentToolProfile>): string | null {
    const folder = this.tools.getWorkspaceRoot()
    if (!folder) return null
    if (profile && profile.name !== 'filesystem' && profile.name !== 'full') {
      return `Workspace: ${folder}\nUse request_tools("filesystem") for repo and shell work.`
    }
    return `Workspace: ${folder}`
  }
}
