import {
  type ChatRequest,
  type OptimizeAgentResult,
  type ChatStreamEvent,
  type ChatAgentSelection
} from '../../../shared/types'
import { BrowserTools, type ToolContext } from './browserTools'
import {
  AGENT_TOOLS,
  selectAgentToolProfile,
  knownToolByName,
  normalizeToolName
} from './agentTools'
import { stripActivePagePreamble } from './routing'
import { taskIdForRequest } from './loopStateEmitter'
import { buildAgentSystem } from './prompts'
import { isBareContinuation } from '../../../shared/types'
import type { Provider } from '../../../shared/types'
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

  public agentToolProfile(
    req: ChatRequest,
    provider?: Provider
  ): ReturnType<typeof selectAgentToolProfile> {
    const baseText = this.latestSubstantiveUserText(req)
    let profile = selectAgentToolProfile(baseText, {
      hasWorkspaceFolder: !!this.tools.getWorkspaceRoot()
    })
    profile = this.applyProviderToolPolicy(profile, provider)
    return this.applyAgentToolPolicy(req, profile)
  }

  private applyProviderToolPolicy(
    profile: ReturnType<typeof selectAgentToolProfile>,
    provider?: Provider
  ): ReturnType<typeof selectAgentToolProfile> {
    if (provider !== 'openai' || !this.tools.getWorkspaceRoot()) return profile

    // OpenAI's direct API path does not have a separate native CLI runtime
    // like Codex/Cursor/Claude Code. On workspace turns, promote browser /
    // research profiles to a workshop-style surface so OpenAI can inspect and
    // edit local code without first burning a request_tools round-trip.
    if (profile.name !== 'browser' && profile.name !== 'research') return profile

    const requestTools = knownToolByName('request_tools')
    const tools = requestTools ? [...AGENT_TOOLS, requestTools] : [...AGENT_TOOLS]
    return { name: 'full', tools }
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
    tools: Parameters<typeof buildAgentSystem>[0],
    provider?: Provider
  ): Promise<string> {
    const base = await buildAgentSystem(tools)
    const providerBlock = provider === 'openai' || provider === 'grok' ? DIRECT_API_WORKSHOP_BLOCK : null
    const custom = this.customAgentSystemBlock(req)
    return [base, providerBlock, custom].filter(Boolean).join('\n\n')
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

const DIRECT_API_WORKSHOP_BLOCK =
  '## Direct API local-work contract\n' +
  'This direct API turn does local repo, file, edit, validation, and shell work through Gladdis tools. ' +
  'Use them as your primary local environment for this turn.\n\n' +
  'For codebase inspection, stay surgical: prefer repo_overview, search_repo, repo_grep_task, and read_spans ' +
  'before raw read_file. Batch related file windows into one read_spans({items:[...]}) call when possible instead of ' +
  'many sequential one-off reads. When you do use read_spans, prefer the multi-span items form over repeated single-path calls. ' +
  'When you do use read_file, prefer explicit start_line/end_line windows and avoid ' +
  'full:true unless the file is small, config-like, or the user explicitly asked for the whole file.\n\n' +
  'For local work, use run_command for commands, edit_file for exact patches, write_file only when creating or ' +
  'fully replacing a file, and verify_change for validation. Keep Gladdis browser tools first-class for web search ' +
  'and page work inside the visible Chromium tab; do not treat shell/browser commands as substitutes for web tasks.'
