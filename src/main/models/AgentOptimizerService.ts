import {
  type ModelOption,
  type OptimizeAgentInput,
  type OptimizeAgentResult,
  type CodexStatus
} from '../../../shared/types'
import { KeyStore } from './KeyStore'
import { CodexClient } from './codex/CodexClient'
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService'
import { ResearchDossierService } from './capabilities/ResearchDossierService'
import { BrowserTools } from './browserTools'

const AGENT_OPTIMIZER_MAX_OUTPUT_TOKENS = 2_800

const QUICK_OPTIMIZER_MODEL_ORDER = [
  'openai-gpt-4o-mini',
  'openai-gpt-4-1-mini',
  'openai-gpt-5.4-mini',
  'openai-gpt-5.4-nano',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'grok-build-0.1',
  'grok-4.3',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.5'
] as const

const DEEP_OPTIMIZER_MODEL_ORDER = [
  'claude-opus-4-8',
  'openai-gpt-5.5',
  'openai-gpt-5.4-pro',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'claude-sonnet-4-6',
  'grok-4.3',
  'openai-gpt-5.4',
  'openai-gpt-5.4-mini',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'openai-gpt-4.1-mini',
  'openai-gpt-4o-mini',
  'grok-build-0.1',
  'claude-haiku-4-5',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex'
] as const

interface ParsedAgentOptimizerResult {
  name?: string
  prompt: string
  goal?: string
  optimizerModelId?: string
  runtimeModelId?: string
  taskFamily?: string
  workspaceBound?: boolean
  preferredTools?: string[]
  disallowedTools?: string[]
  knownPaths?: string[]
  knownCommands?: string[]
  workflowSteps?: string[]
  verificationSteps?: string[]
  stopConditions?: string[]
  fallbackRules?: string[]
  assumptions?: string[]
  testTasks?: string[]
  optimizationSummary?: string
  evidenceNotes?: string[]
  testTask?: string
  contextSummary?: string
  notes?: string[]
  validationNotes?: string[]
}

export class AgentOptimizerService {
  constructor(
    private keys: KeyStore,
    private codex: () => CodexClient,
    private repoIntelligence: RepoIntelligenceService,
    private researchDossier: ResearchDossierService,
    private tools: BrowserTools,
    private model: (id: string) => ModelOption | undefined,
    private complete: (
      modelId: string,
      system: string,
      user: string,
      options: { stage: string; maxOutputTokens: number }
    ) => Promise<string>
  ) {}

  async optimizeAgent(input: OptimizeAgentInput): Promise<OptimizeAgentResult> {
    const roughPrompt = input.roughPrompt?.trim() || ''
    const workspaceRoot = this.tools.getWorkspaceRoot()
    const optimizationMode = input.optimizationMode || 'quick'

    const model = await this.resolveOptimizerModel(input.modelId || 'openai-gpt-4o-mini', optimizationMode)

    let contextSummary = 'No workspace context available.'
    if (workspaceRoot) {
      contextSummary = await this.agentOptimizerWorkspaceSummary(workspaceRoot, roughPrompt, optimizationMode)
    }

    const schemaCompliance =
      'Ensure the prompt and testTask are complete, self-contained, and specialized for the detected task family.'
    const deepNote =
      optimizationMode === 'deep'
        ? 'Run a distillation pass with deep workspace discovery before drafting the final JSON.'
        : 'Run a lightweight optimization pass focused on stable prompt and command guidance.'

    const system = [
      'You are Gladdis Agent Builder, an expert designer of compact, high-leverage AI agents.',
      'Convert a rough user goal into a saved agent definition that makes the model excellent at directly completing that task.',
      '',
      'Design priorities:',
      '- Optimize for direct task completion at the highest practical quality.',
      '- Minimize token use by front-loading only durable context, constraints, exact targets, and decision rules.',
      '- Do not make the agent rediscover information already supplied by workspace evidence or the user goal.',
      '- Treat exact paths, component names, commands, schemas, domains, APIs, and acceptance checks as valuable context when they are known.',
      '- Keep the agent general enough for the intended task family; do not hard-code a single file workflow unless the goal truly requires it.',
      '- Prefer precise action policy over motivational prose.',
      '- Preserve user intent. Do not invent repository files, APIs, product facts, or requirements.',
      `- Optimize mode: ${optimizationMode}. ${deepNote}`,
      'Schema checks:',
      schemaCompliance,
      '',
      'Return only valid JSON with this shape:',
      '{"name":"short agent name","goal":"user goal","prompt":"system prompt for the saved agent","testTask":"one concise test task","contextSummary":"one sentence on what context was used","notes":["optional short note"],"validationNotes":["optional note"],"preferredTools":["filesystem","shell"],"disallowedTools":[],"knownPaths":["src/"],"knownCommands":["pnpm test"],"workflowSteps":["1) ..."],"verificationSteps":["check ..."],"stopConditions":["..."],"fallbackRules":["..."],"assumptions":["..."],"testTasks":["additional test task"],"optimizationSummary":"what was learned","evidenceNotes":["..."]}'
    ].join('\n')

    const user = JSON.stringify(
      {
        roughGoal: roughPrompt,
        requestedName: input.name?.trim() || null,
        editingExistingAgent: input.existingAgent
          ? {
              id: input.existingAgent.id,
              name: input.existingAgent.name,
              goal: input.existingAgent.goal ?? null,
              roughPrompt: input.existingAgent.roughPrompt ?? null,
              testTask: input.existingAgent.testTask ?? null,
              taskFamily: input.existingAgent.taskFamily ?? null,
              preferredTools: input.existingAgent.preferredTools ?? null,
              disallowedTools: input.existingAgent.disallowedTools ?? null,
              knownPaths: input.existingAgent.knownPaths ?? null,
              knownCommands: input.existingAgent.knownCommands ?? null,
              workflowSteps: input.existingAgent.workflowSteps ?? null,
              verificationSteps: input.existingAgent.verificationSteps ?? null,
              stopConditions: input.existingAgent.stopConditions ?? null,
              fallbackRules: input.existingAgent.fallbackRules ?? null,
              assumptions: input.existingAgent.assumptions ?? null,
              testTasks: input.existingAgent.testTasks ?? null,
              optimizerModelId: input.existingAgent.optimizerModelId ?? null,
              runtimeModelId: input.existingAgent.runtimeModelId ?? null,
              optimizationSummary: input.existingAgent.optimizationSummary ?? null,
              evidenceNotes: input.existingAgent.evidenceNotes ?? null,
              validationNotes: input.existingAgent.validationNotes ?? null
            }
          : null,
        selectedModel: {
          id: model.id,
          label: model.label,
          provider: model.provider
        },
        optimizationMode,
        workspaceEvidence: contextSummary
      },
      null,
      2
    )

    const raw = await this.complete(model.id, system, user, {
      stage: 'agent_optimizer',
      maxOutputTokens: AGENT_OPTIMIZER_MAX_OUTPUT_TOKENS
    })
    const parsed = parseAgentOptimizerJson(raw)
    if (!parsed.prompt.trim()) throw new Error('Agent optimizer returned an empty prompt.')
    return {
      name: parsed.name?.trim() || input.name?.trim() || undefined,
      modelId: model.id,
      prompt: parsed.prompt.trim(),
      testTask: parsed.testTask?.trim() || `Use this agent to complete: ${roughPrompt}`,
      goal: parsed.goal?.trim() || roughPrompt,
      optimizerModelId: parsed.optimizerModelId?.trim() || model.id,
      runtimeModelId: parsed.runtimeModelId?.trim() || model.id,
      taskFamily: parsed.taskFamily?.trim(),
      workspaceBound: parsed.workspaceBound,
      preferredTools: parsed.preferredTools?.filter(Boolean),
      disallowedTools: parsed.disallowedTools?.filter(Boolean),
      knownPaths: parsed.knownPaths?.filter(Boolean),
      knownCommands: parsed.knownCommands?.filter(Boolean),
      workflowSteps: parsed.workflowSteps?.filter(Boolean),
      verificationSteps: parsed.verificationSteps?.filter(Boolean),
      stopConditions: parsed.stopConditions?.filter(Boolean),
      fallbackRules: parsed.fallbackRules?.filter(Boolean),
      assumptions: parsed.assumptions?.filter(Boolean),
      testTasks: parsed.testTasks?.filter(Boolean),
      optimizationSummary: parsed.optimizationSummary?.trim(),
      evidenceNotes: parsed.evidenceNotes?.filter(Boolean),
      validationNotes: parsed.validationNotes?.filter(Boolean),
      contextSummary: parsed.contextSummary?.trim() || contextSummary.split('\n')[0],
      notes: parsed.notes?.filter((note) => note.trim()).map((note) => note.trim()).slice(0, 4),
      source: 'llm'
    }
  }

  private async resolveOptimizerModel(
    preferredModelId: string,
    optimizationMode: 'quick' | 'deep'
  ): Promise<ModelOption> {
    const keyStatus = this.keys.status()
    const codexAvailable = await this.codexOptimizerAvailable()

    const ranking = optimizationMode === 'quick' ? QUICK_OPTIMIZER_MODEL_ORDER : DEEP_OPTIMIZER_MODEL_ORDER
    const candidateModelIds = [
      preferredModelId,
      ...ranking.filter((id) => id !== preferredModelId)
    ]

    for (const modelId of candidateModelIds) {
      const candidate = this.model(modelId)
      if (!candidate) continue
      if (candidate.provider === 'codex') {
        if (codexAvailable) return candidate
      } else if (keyStatus[candidate.provider]) {
        return candidate
      }
    }

    throw new Error(
      `No usable optimizer model available for ${optimizationMode} mode. Configure an API key for Anthropic, Google, OpenAI, or xAI, or install and authenticate Codex.`
    )
  }

  private async codexOptimizerAvailable(): Promise<boolean> {
    try {
      const status = await this.codex().status()
      return !!status.installed && !!status.authenticated
    } catch {
      return false
    }
  }

  private async agentOptimizerWorkspaceSummary(
    workspaceRoot: string,
    roughPrompt: string,
    optimizationMode: 'quick' | 'deep'
  ): Promise<string> {
    if (optimizationMode === 'quick') {
      return this.agentOptimizerWorkspaceSummaryQuick(workspaceRoot, roughPrompt)
    }
    try {
      return await this.agentOptimizerWorkspaceSummaryDeep(workspaceRoot, roughPrompt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [
        await this.agentOptimizerWorkspaceSummaryQuick(workspaceRoot, roughPrompt),
        'Deep optimize failed; using quick summary as fallback.',
        `Reason: ${message}`
      ].join('\n')
    }
  }

  private async agentOptimizerWorkspaceSummaryQuick(workspaceRoot: string, roughPrompt: string): Promise<string> {
    try {
      const overview = await this.repoIntelligence.repoOverview({
        workspaceRoot,
        focus: roughPrompt
      })
      return [
        `Mode: quick`,
        '--- Workspace summary ---',
        overview.summary
      ].join('\n')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [
        'Mode: quick',
        `Workspace overview unavailable: ${message}`,
        `Focus: ${roughPrompt}`
      ].join('\n')
    }
  }

  private async agentOptimizerWorkspaceSummaryDeep(workspaceRoot: string, roughPrompt: string): Promise<string> {
    const chunks: string[] = ['Mode: deep', '--- Discovery evidence ---']
    const overview = await this.repoIntelligence.repoOverview({
      workspaceRoot,
      focus: roughPrompt
    })
    chunks.push(`Workspace: ${overview.structuredPayload.workspaceRoot}`)
    if (overview.structuredPayload.packageName) {
      chunks.push(`Package: ${overview.structuredPayload.packageName}`)
    }
    if (overview.structuredPayload.packageManager) {
      chunks.push(`Package manager: ${overview.structuredPayload.packageManager}`)
    }
    if (overview.structuredPayload.scripts.length) {
      chunks.push(`Scripts: ${overview.structuredPayload.scripts.slice(0, 12).join(', ')}`)
    }
    chunks.push('--- Repo overview ---')
    chunks.push(overview.summary)

    const searchQueries = [
      roughPrompt,
      `${roughPrompt} tests`,
      `${roughPrompt} package.json scripts`
    ]
    const searchSummaries: string[] = []
    const readSpansInputs: Array<{ path: string; startLine: number; endLine: number }> = []
    for (const query of searchQueries) {
      try {
        const result = await this.repoIntelligence.searchRepo({
          workspaceRoot,
          query,
          maxResults: 6
        })
        searchSummaries.push(`Query: ${query}\n${result.summary}`)
        for (const suggestion of result.structuredPayload.suggestedSpans.slice(0, 2)) {
          readSpansInputs.push({
            path: suggestion.path,
            startLine: suggestion.startLine,
            endLine: suggestion.endLine
          })
        }
      } catch (err) {
        searchSummaries.push(`Query: ${query} (failed: ${err instanceof Error ? err.message : String(err)})`)
      }
    }
    chunks.push('--- Search evidence ---')
    chunks.push(searchSummaries.join('\n\n'))

    try {
      const capped = readSpansInputs.slice(0, 4)
      if (capped.length > 0) {
        const spans = await this.repoIntelligence.readSpans({
          workspaceRoot,
          items: capped
        })
        chunks.push('--- Read spans ---')
        chunks.push(spans.summary)
      }
    } catch (err) {
      chunks.push(`Read spans unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      const dossier = await this.researchDossier.researchDossier({
        workspaceRoot,
        query: roughPrompt,
        maxResults: 12
      })
      chunks.push('--- Research dossier ---')
      chunks.push(dossier.summary)
    } catch (err) {
      chunks.push(`Research dossier unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }

    return chunks.join('\n')
  }
}

function asStringArray(value: unknown, maxLength = 16): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  // Drop non-string entries rather than coercing them: an optimizer that returns
  // e.g. a number in a tool array is junk we don't want saved as "123", not a value
  // to stringify. (The extraction had regressed this to String(v), letting junk through.)
  const parsed = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => !!v)
    .slice(0, maxLength)
  return parsed.length > 0 ? parsed : undefined
}

function parseAgentOptimizerJson(raw: string): ParsedAgentOptimizerResult {
  const trimmed = raw.trim()
  const jsonText = extractJsonObject(trimmed)
  const parsedJson = JSON.parse(jsonText) as unknown
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('Agent optimizer returned non-object JSON.')
  }
  const parsed: Partial<ParsedAgentOptimizerResult> = parsedJson
  const validationNotes: string[] = []
  if (!Array.isArray(parsed.notes)) {
    validationNotes.push('notes omitted')
  }
  if (typeof parsed.prompt !== 'string') {
    throw new Error('Agent optimizer returned JSON without a prompt.')
  }
  if (!parsed.prompt.trim()) {
    validationNotes.push('prompt was empty')
  }
  const testTask = typeof parsed.testTask === 'string' ? parsed.testTask.trim() : ''
  if (!testTask) {
    validationNotes.push('testTask was missing')
  }
  const normalizedPrompt = parsed.prompt.trim()
  const optimizationSummary = typeof parsed.optimizationSummary === 'string' ? parsed.optimizationSummary.trim() : ''
  if (!optimizationSummary) {
    validationNotes.push('optimizationSummary was missing')
  }
  if (typeof parsed.workspaceBound !== 'undefined' && typeof parsed.workspaceBound !== 'boolean') {
    validationNotes.push('workspaceBound was not boolean and was ignored')
  }

  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    prompt: normalizedPrompt,
    ...(typeof parsed.goal === 'string' ? { goal: parsed.goal } : {}),
    ...(typeof parsed.optimizerModelId === 'string' ? { optimizerModelId: parsed.optimizerModelId } : {}),
    ...(typeof parsed.runtimeModelId === 'string' ? { runtimeModelId: parsed.runtimeModelId } : {}),
    ...(typeof parsed.taskFamily === 'string' ? { taskFamily: parsed.taskFamily } : {}),
    ...(typeof parsed.workspaceBound === 'boolean' ? { workspaceBound: parsed.workspaceBound } : {}),
    ...(asStringArray(parsed.preferredTools) ? { preferredTools: asStringArray(parsed.preferredTools) } : {}),
    ...(asStringArray(parsed.disallowedTools) ? { disallowedTools: asStringArray(parsed.disallowedTools) } : {}),
    ...(asStringArray(parsed.knownPaths, 20) ? { knownPaths: asStringArray(parsed.knownPaths, 20) } : {}),
    ...(asStringArray(parsed.knownCommands, 16) ? { knownCommands: asStringArray(parsed.knownCommands, 16) } : {}),
    ...(asStringArray(parsed.workflowSteps, 12) ? { workflowSteps: asStringArray(parsed.workflowSteps, 12) } : {}),
    ...(asStringArray(parsed.verificationSteps, 12)
      ? { verificationSteps: asStringArray(parsed.verificationSteps, 12) }
      : {}),
    ...(asStringArray(parsed.stopConditions, 12) ? { stopConditions: asStringArray(parsed.stopConditions, 12) } : {}),
    ...(asStringArray(parsed.fallbackRules, 12) ? { fallbackRules: asStringArray(parsed.fallbackRules, 12) } : {}),
    ...(asStringArray(parsed.assumptions, 16) ? { assumptions: asStringArray(parsed.assumptions, 16) } : {}),
    ...(asStringArray(parsed.testTasks, 12) ? { testTasks: asStringArray(parsed.testTasks, 12) } : {}),
    ...(optimizationSummary ? { optimizationSummary } : {}),
    ...(asStringArray(parsed.evidenceNotes, 24) ? { evidenceNotes: asStringArray(parsed.evidenceNotes, 24) } : {}),
    ...(testTask ? { testTask } : {}),
    ...(typeof parsed.contextSummary === 'string'
      ? { contextSummary: parsed.contextSummary.trim() }
      : {}),
    ...(asStringArray(parsed.notes, 8) ? { notes: asStringArray(parsed.notes, 8) } : {}),
    ...(validationNotes.length ? { validationNotes } : {})
  }
}

function extractJsonObject(text: string): string {
  if (text.startsWith('{') && text.endsWith('}')) return text
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return extractJsonObject(fenced[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text
}
