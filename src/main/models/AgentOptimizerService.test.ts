import { describe, expect, it, vi } from 'vitest'
import { AgentOptimizerService } from './AgentOptimizerService'

const BASE_KEYS_STATUS = {
  anthropic: false,
  google: false,
  codex: false,
  openai: false,
  grok: false
}

function makeOptimizerService(
  keyStatus: Partial<typeof BASE_KEYS_STATUS> = {},
  codexStatus: { installed: boolean; authenticated: boolean } = { installed: false, authenticated: false }
) {
  const keys = {
    status: () => ({ ...BASE_KEYS_STATUS, ...keyStatus }),
    get: (p: string) => (keyStatus as any)[p] ? 'key' : null
  } as any
  const codex = {
    status: vi.fn(async () => ({
      installed: codexStatus.installed,
      authenticated: codexStatus.authenticated
    }))
  } as any
  const repoIntelligence = {
    repoOverview: vi.fn(async () => ({ summary: 'repo summary', structuredPayload: { workspaceRoot: '/', scripts: [] } }))
  } as any
  const researchDossier = {
    researchDossier: vi.fn(async () => ({ summary: 'dossier summary' }))
  } as any
  const tools = {
    getWorkspaceRoot: () => '/'
  } as any
  const complete = vi.fn(async () => '{}')

  let modelLookup = (id: string): any => {
    if (id.startsWith('openai')) return { id, provider: 'openai' }
    if (id.startsWith('claude')) return { id, provider: 'anthropic' }
    if (id.startsWith('gemini')) return { id, provider: 'google' }
    if (id.startsWith('grok')) return { id, provider: 'grok' }
    if (id.includes('codex')) return { id, provider: 'codex' }
    return undefined
  }

  const service = new AgentOptimizerService(
    keys,
    () => codex,
    repoIntelligence,
    researchDossier,
    tools,
    (id) => modelLookup(id),
    complete
  )

  return { service, keys, codex, repoIntelligence, researchDossier, tools, complete, setModelLookup: (fn: any) => { modelLookup = fn } }
}

describe('AgentOptimizerService', () => {
  it('uses the preferred model when it is provider-usable for optimization', async () => {
    const { service } = makeOptimizerService({ openai: true })
    const model = await (service as any).resolveOptimizerModel('openai-gpt-4o-mini', 'deep')
    expect(model.id).toBe('openai-gpt-4o-mini')
  })

  it('normalizes optimizer JSON and emits validation notes for missing fields', async () => {
    const { service, complete } = makeOptimizerService({ openai: true })
    complete.mockResolvedValue(
      JSON.stringify({
        prompt: 'Use the task family and avoid touching unrelated code.',
        testTask: '',
        optimizationSummary: '',
        workspaceBound: 'yes',
        preferredTools: ['read_file', ' run_command ', 'unknown-tool'],
        disallowedTools: ['search_repo', 123],
        knownPaths: ['src/main', ''],
        knownCommands: ['pnpm test'],
        workflowSteps: ['Inspect workspace', 'Apply smallest change'],
        testTasks: ['Run lint', 'Run tests'],
        evidenceNotes: ['From repo overview']
      })
    )

    const result = await service.optimizeAgent({
      modelId: 'openai-gpt-4o-mini',
      roughPrompt: 'Fix build failures',
      optimizationMode: 'quick'
    })

    expect(result.prompt).toBe('Use the task family and avoid touching unrelated code.')
    expect(result.testTask).toBe('Use this agent to complete: Fix build failures')
    expect(result.preferredTools).toEqual(['read_file', 'run_command', 'unknown-tool'])
    expect(result.disallowedTools).toEqual(['search_repo'])
    expect(result.knownPaths).toEqual(['src/main'])
    expect(result.validationNotes).toContain('testTask was missing')
    expect(result.validationNotes).toContain('optimizationSummary was missing')
    expect(result.validationNotes).toContain('notes omitted')
  })

  it('falls through with a clear error when optimizer output is non-object JSON', async () => {
    const { service, complete } = makeOptimizerService({ openai: true })
    complete.mockResolvedValue('[1,2,3]')

    await expect(
      service.optimizeAgent({
        modelId: 'openai-gpt-4o-mini',
        roughPrompt: 'Fix build failures',
        optimizationMode: 'quick'
      })
    ).rejects.toThrow('non-object JSON.')
  })

  it('falls back to ranked optimizer models when preferred model is unavailable', async () => {
    const { service, setModelLookup } = makeOptimizerService({ openai: true })
    setModelLookup((id: string) => {
      if (id === 'openai-gpt-4o-mini') return { id, provider: 'openai' }
      return undefined
    })
    const model = await (service as any).resolveOptimizerModel('anthropic-claude-3-opus', 'quick')
    expect(model.id).toBe('openai-gpt-4o-mini')
  })

  it('throws when no optimizer model is usable', async () => {
    const { service, setModelLookup } = makeOptimizerService({})
    setModelLookup(() => undefined)
    await expect((service as any).resolveOptimizerModel('openai-gpt-4o-mini', 'quick')).rejects.toThrow('No usable optimizer model available')
  })
})
