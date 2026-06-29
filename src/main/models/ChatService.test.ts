import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

vi.mock('./hiddenSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hiddenSearch')>()
  return {
    ...actual,
    runHiddenSearch: vi.fn(async () => ({
      ok: true,
      url: 'https://html.duckduckgo.com/html/?q=test',
      title: 'Search',
      results: [
        { title: 'Warmed result', url: 'https://warm.test/result', snippet: 'warmed candidate' }
      ]
    }))
  }
})

import { ChatService, extractLocalPreviewUrl, hasActivePagePreamble, isUserFacingLocalPreviewRequest, stripActivePagePreamble, stubOldGoogleResults, stubOldResults } from './ChatService'
import { openCodexLocalPreviewIfRequested } from './localPreviewBridge'
import { shouldAttachActivePageContext, shouldContinueActivePageContext, shouldUseBrowserTools } from '../../../shared/types'
import { shouldUseWorkspaceContext } from '../../../shared/types'
import { AGENT_TOOLS, selectAgentToolProfile, resolveTurnTools } from './agentTools'
import { BrowserTools } from './browserTools'
import { CODEX_BROWSER_INSTRUCTIONS, CODEX_BROWSER_TOOL_NAMES } from './codex/dynamicBrowserTools'
import { createLoopStateEmitter } from './loopStateEmitter'
import { CODEX_SYSTEM, buildAgentSystem } from './prompts'
import { createTurnSupervisor } from './turnSupervisor'
import { resolveTurnContextPolicy } from './turnContextPolicy'

const BASE_KEYS_STATUS = {
  anthropic: false,
  google: false,
  codex: false,
  openai: false,
  grok: false
}

function makeService(workspaceRoot: string | null = null) {
  const emit = vi.fn()
  const tools = {
    getWorkspaceRoot: () => workspaceRoot,
    setCapabilityBroker: vi.fn(),
    run: vi.fn(),
    tabs: { activeTabId: 'tab-1', liveTabId: vi.fn((id?: string | null) => id ?? 'tab-1'), create: vi.fn(() => ({ id: 'tab-new' })), navigate: vi.fn(), capturePagePng: vi.fn(async () => Buffer.from('png').toString('base64')) }
  } as any
  const audit = { begin: vi.fn(() => ({ addOutput: vi.fn(), finish: vi.fn() })) } as any

  return {
    emit,
    tools,
    audit,
    service: new ChatService({} as any, emit, tools, audit, {} as any)
  }
}

function makeServiceForOptimizer(
  keyStatus: Partial<typeof BASE_KEYS_STATUS> = {},
  codexStatus: { installed: boolean; authenticated: boolean } = { installed: false, authenticated: false }
) {
  const emit = vi.fn()
  const tools = {
    getWorkspaceRoot: () => null,
    setCapabilityBroker: vi.fn()
  } as any
  const audit = { begin: vi.fn(() => ({ addOutput: vi.fn(), finish: vi.fn() })) } as any
  const service = new ChatService(
    {
      status: () => ({
        ...BASE_KEYS_STATUS,
        ...keyStatus
      })
    } as any,
    emit,
    tools,
    audit,
    {} as any
  )
  vi.spyOn(service, 'codexStatus').mockResolvedValue({
    installed: codexStatus.installed,
    authenticated: codexStatus.authenticated,
    authMethod: null,
    version: null,
    detail: null
  })
  return { emit, tools, audit, service }
}

function makeSupervisorHarness(req: {
  requestId: string
  conversationId?: string | null
}) {
  const emit = vi.fn()
  const supervisor = createTurnSupervisor(createLoopStateEmitter(req, emit))
  return { emit, supervisor }
}

describe('ChatService provider hardening', () => {
  it('exposes a single unified search tool plus fetch_page', () => {
    const toolNames = AGENT_TOOLS.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(['repo_overview', 'search_repo', 'read_spans', 'research_dossier', 'verify_change', 'search', 'navigate', 'fetch_page']))
    expect(toolNames).not.toContain('background_web_search')
    expect(toolNames).not.toContain('search_task')
    expect(toolNames).not.toContain('search_web')
    expect(toolNames).not.toContain('check_page')
  })

  it('uses the preferred model when it is provider-usable for optimization', async () => {
    const { service } = makeServiceForOptimizer({
      openai: true
    })
    const model = await (service as any).resolveOptimizerModel('openai-gpt-4o-mini', 'deep')
    expect(model.id).toBe('openai-gpt-4o-mini')
  })

  it('normalizes optimizer JSON and emits validation notes for missing fields', async () => {
    const { service } = makeServiceForOptimizer({
      openai: true
    })
    vi.spyOn(service as any, 'complete').mockResolvedValue(
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

    const result = await (service as any).optimizeAgent({
      modelId: 'openai-gpt-4o-mini',
      roughPrompt: 'Fix build failures',
      optimizationMode: 'quick'
    })

    expect(result.prompt).toBe('Use the task family and avoid touching unrelated code.')
    expect(result.testTask).toBe('Use this agent to complete: Fix build failures')
    expect(result.testTask).toBeTruthy()
    expect(result.optimizationSummary).toBeUndefined()
    expect(result.workspaceBound).toBeUndefined()
    expect(result.preferredTools).toEqual(['read_file', 'run_command', 'unknown-tool'])
    expect(result.disallowedTools).toEqual(['search_repo'])
    expect(result.knownPaths).toEqual(['src/main'])
    expect(result.validationNotes).toEqual(
      expect.arrayContaining(['testTask was missing', 'optimizationSummary was missing', 'notes omitted'])
    )
    expect(result.validationNotes?.some((note: string) => note.includes('workspaceBound'))).toBe(true)
  })

  it('falls through with a clear error when optimizer output is non-object JSON', async () => {
    const { service } = makeServiceForOptimizer({
      openai: true
    })
    vi.spyOn(service as any, 'complete').mockResolvedValue('[1,2,3]')

    await expect(
      (service as any).optimizeAgent({
        modelId: 'openai-gpt-4o-mini',
        roughPrompt: 'Fix build failures',
        optimizationMode: 'quick'
      })
    ).rejects.toThrow('non-object JSON.')
  })

  it('applies saved preferred/disallowed tool constraints to the active profile', () => {
    const { service } = makeService()
    const baseProfile = selectAgentToolProfile('read src/main/models/ChatService.ts and suggest fixes')
    const constrained = (service as any).applyAgentToolPolicy(
      {
        agent: {
          preferredTools: ['read_page', 'run_command'],
          disallowedTools: ['run_validation']
        }
      },
      baseProfile
    )
    const names = constrained.tools.map((tool: { name: string }) => tool.name)

    expect(names).toContain('read_page')
    expect(names).not.toContain('run_validation')
  })

  it('falls back to ranked optimizer models when preferred model is unavailable', async () => {
    const { service } = makeServiceForOptimizer({
      openai: true
    })
    const model = await (service as any).resolveOptimizerModel('nonexistent-model-id', 'quick')
    expect(model.id).toBe('openai-gpt-4o-mini')
  })

  it('uses deep-mode ranking order when preferred model is unavailable', async () => {
    const { service } = makeServiceForOptimizer({
      anthropic: true
    })
    const model = await (service as any).resolveOptimizerModel('nonexistent-model-id', 'deep')
    expect(model.id).toBe('claude-opus-4-8')
  })

  it('respects codex auth before selecting codex optimizer models', async () => {
    const unauthenticated = makeServiceForOptimizer(
      {
        openai: true,
        google: true,
        codex: false
      },
      { installed: true, authenticated: false }
    )
    const unauthenticatedModel = await (unauthenticated.service as any).resolveOptimizerModel('gpt-5.3-codex', 'quick')
    expect(unauthenticatedModel.id).toBe('openai-gpt-4o-mini')

    const authenticated = makeServiceForOptimizer(
      {
        openai: false,
        google: false,
        anthropic: false,
        codex: false,
        grok: false
      },
      { installed: true, authenticated: true }
    )
    const model = await (authenticated.service as any).resolveOptimizerModel('gpt-5.3-codex', 'quick')
    expect(model.id).toBe('gpt-5.3-codex')
  })

  it('throws when no optimizer model is usable', async () => {
    const { service } = makeServiceForOptimizer({}, { installed: false, authenticated: false })
    await expect(
      (service as any).resolveOptimizerModel('nonexistent-model-id', 'quick')
    ).rejects.toThrow('No usable optimizer model available')
  })

  it('gives all three providers ONE browser surface (Codex sees the same tools)', () => {
    expect(CODEX_BROWSER_TOOL_NAMES.has('repo_overview')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('search_repo')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('read_spans')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('research_dossier')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('verify_change')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('search')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('navigate')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('fetch_page')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('grep_click')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('grep_type')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('click_xy')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('type_text')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('press_key')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('execute_in_browser')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('cdp_command')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('background_web_search')).toBe(false)
    expect(CODEX_BROWSER_TOOL_NAMES.has('search_task')).toBe(false)
    expect(CODEX_BROWSER_TOOL_NAMES.has('check_page')).toBe(false)
  })

  it('selects lean tool profiles for obvious filesystem and browser tasks', () => {
    const fsProfile = selectAgentToolProfile('read src/main/models/ChatService.ts and suggest fixes')
    expect(fsProfile.name).toBe('filesystem')
    expect(fsProfile.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read_file', 'search_files', 'run_validation', 'recall_history'])
    )
    expect(fsProfile.tools.map((tool) => tool.name)).not.toContain('read_page')

    const browserProfile = selectAgentToolProfile('click the login button on the active page')
    expect(browserProfile.name).toBe('browser')
    expect(browserProfile.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read_page', 'click_xy', 'browse_task'])
    )
    expect(browserProfile.tools.map((tool) => tool.name)).not.toContain('write_file')

    const mixedProfile = selectAgentToolProfile('edit the app UI and validate it with a browser screenshot')
    expect(mixedProfile.name).toBe('filesystem')
    expect(mixedProfile.tools.map((tool) => tool.name)).toContain('run_validation')

    const localPageProfile = selectAgentToolProfile('create a login form page in src/renderer')
    expect(localPageProfile.name).toBe('filesystem')
    expect(localPageProfile.tools.map((tool) => tool.name)).not.toContain('read_page')

    const localDocsProfile = selectAgentToolProfile('explain the docs architecture in this repo')
    expect(localDocsProfile.name).toBe('filesystem')
    expect(localDocsProfile.tools.map((tool) => tool.name)).not.toContain('search')

    const officialStyleProfile = selectAgentToolProfile('make the settings copy sound more official')
    expect(officialStyleProfile.name).toBe('conversation')

    const officialDocsProfile = selectAgentToolProfile('look up the official xAI docs for Grok 4.3')
    expect(officialDocsProfile.name).toBe('research')
    expect(officialDocsProfile.tools.map((tool) => tool.name)).toContain('search')

    const conversationProfile = selectAgentToolProfile('tell me a joke')
    expect(conversationProfile.name).toBe('conversation')
    // Lean profile carries recall_history, memory tools, plus the request_tools escape hatch, so
    // the model can always pull in tools instead of stalling when it needs to act.
    expect(conversationProfile.tools.map((tool) => tool.name)).toEqual([
      'recall_history',
      'memory_write',
      'memory_read',
      'memory_list',
      'memory_forget',
      'memory_create_task',
      'request_tools'
    ])
  })

  it('lets a lean turn escalate into filesystem tools via request_tools', async () => {
    // The exact dead-stop from the trace: a turn lands in the conversation profile
    // (1 real tool), the model needs to inspect/install in the project. It must be
    // able to pull in filesystem tools mid-turn instead of narrating and stopping.
    const lean = selectAgentToolProfile('what performance packages should we consider installing')
    expect(lean.tools.map((t) => t.name)).toContain('request_tools')
    expect(lean.tools.map((t) => t.name)).not.toContain('run_command')

    // Drive the REAL dispatcher: request the filesystem group.
    const bt = new BrowserTools({} as any, {} as any, {} as any)
    const granted = new Set<string>()
    const res = await bt.run('request_tools', { group: 'filesystem' }, { tabId: 'tab-1', grantedTools: granted } as any)
    expect(res.ok).toBe(true)
    expect(granted.has('run_command')).toBe(true)
    expect(granted.has('read_file')).toBe(true)
    expect(granted.has('repo_overview')).toBe(true)
    expect(granted.has('search_repo')).toBe(true)
    expect(granted.has('read_spans')).toBe(true)
    expect(granted.has('research_dossier')).toBe(true)
    expect(granted.has('verify_change')).toBe(true)

    // After the grant, resolveTurnTools surfaces the filesystem tools for the next step.
    const next = resolveTurnTools(lean.tools, granted).map((t) => t.name)
    expect(next).toContain('repo_overview')
    expect(next).toContain('search_repo')
    expect(next).toContain('read_spans')
    expect(next).toContain('research_dossier')
    expect(next).toContain('verify_change')
    expect(next).toContain('run_command')
    expect(next).toContain('edit_file')

    const toolOnlyGranted = new Set<string>()
    const exact = await bt.run('request_tools', { tools: ['read_file', 'edit_file'] }, { tabId: 'tab-1', grantedTools: toolOnlyGranted } as any)
    expect(exact.ok).toBe(true)
    expect(toolOnlyGranted.has('read_file')).toBe(true)
    expect(toolOnlyGranted.has('edit_file')).toBe(true)
    expect(toolOnlyGranted.has('run_command')).toBe(false)
    const nextExact = resolveTurnTools(lean.tools, toolOnlyGranted).map((t) => t.name)
    expect(nextExact).toContain('read_file')
    expect(nextExact).toContain('edit_file')
    expect(nextExact).not.toContain('run_command')

    const normalizedAlias = new Set<string>()
    const alias = await bt.run(
      'request_tools',
      { group: 'fs', tools: ['Read File', 'RUN-COMMAND'] },
      { tabId: 'tab-1', grantedTools: normalizedAlias } as any
    )
    expect(alias.ok).toBe(true)
    expect(normalizedAlias.has('read_file')).toBe(true)
    expect(normalizedAlias.has('run_command')).toBe(true)

    const normalizedStringArgs = new Set<string>()
    const aliasFromString = await bt.run(
      'request_tools',
      {
        group: 'file_system, web search',
        tools: 'read_file, RUN-COMMAND'
      },
      { tabId: 'tab-1', grantedTools: normalizedStringArgs } as any
    )
    expect(aliasFromString.ok).toBe(true)
    expect(normalizedStringArgs.has('run_command')).toBe(true)
    expect(normalizedStringArgs.has('read_file')).toBe(true)
    expect(normalizedStringArgs.has('search')).toBe(true)
    expect(normalizedStringArgs.has('fetch_page')).toBe(true)
    expect(normalizedStringArgs.has('deep_search')).toBe(true)

    // An unknown group is rejected, not silently granted.
    const bad = await bt.run('request_tools', { group: 'nonsense' }, { tabId: 'tab-1', grantedTools: new Set() } as any)
    expect(bad.ok).toBe(false)
    const badTools = await bt.run('request_tools', { tools: ['non_existent_tool'] }, { tabId: 'tab-1', grantedTools: new Set() } as any)
    expect(badTools.ok).toBe(false)
  })

  it('describes recall_history as context recovery, not automatic continuation', () => {
    const recall = AGENT_TOOLS.find((tool) => tool.name === 'recall_history')
    expect(recall?.description).toContain('bare resume request')
    expect(recall?.description).toContain('wait for the next concrete instruction')
    expect(recall?.description).toContain('state-changing actions')
  })

  it('does not let the selected folder turn unrelated prompts into workspace tasks', () => {
    expect(shouldUseWorkspaceContext('tell me a joke')).toBe(false)
    expect(shouldUseWorkspaceContext('search the web for xAI docs')).toBe(false)
    expect(shouldUseWorkspaceContext('look up the official React docs')).toBe(false)
    expect(shouldUseWorkspaceContext('what is a folder in programming?')).toBe(false)
    expect(selectAgentToolProfile('what is a folder in programming?').name).toBe('conversation')

    expect(shouldUseWorkspaceContext('edit the app UI and run typecheck')).toBe(true)
    expect(shouldUseWorkspaceContext('explain the docs architecture in this repo')).toBe(true)
    expect(shouldUseWorkspaceContext('read src/main/models/ChatService.ts')).toBe(true)
  })

  it('routes install/update requests to a filesystem profile so run_command is offered', () => {
    // Regression: install/update vocabulary was absent from the routing
    // predicates, so the model was handed the browser profile (no run_command)
    // and could only talk about installing — never actually run it.
    const installs = [
      'install the foobar package',
      'update typescript',
      'npm install left-pad',
      'update the dependencies',
      'install ripgrep',
      'please update electron to latest',
      'install pandas via pip',
      'sudo apt-get install jq',
      'upgrade the deps',
      'bump the react version',
      'set up the tooling',
      'git clone https://example.com/x/y'
    ]
    for (const text of installs) {
      expect(shouldUseWorkspaceContext(text), text).toBe(true)
      const tools = selectAgentToolProfile(text).tools.map((t) => t.name)
      expect(tools, text).toContain('run_command')
    }
  })

  it('keeps tools on a bare "yes"/"do it" that continues the previous turn', () => {
    const { service } = makeService('/tmp/proj')
    const profileFor = (messages: Array<{ role: string; content: string }>) =>
      (service as any).agentToolProfile({ messages } as any) as { name: string; tools: Array<{ name: string }> }

    // The exact failure from the trace: assistant offers to wire up a package,
    // user says "yes", and the turn must NOT collapse to conversation (1 tool).
    const continued = profileFor([
      { role: 'user', content: 'wire up electron-devtools-installer in the main process' },
      { role: 'assistant', content: 'Sure — want me to run the install or show the code first?' },
      { role: 'user', content: 'yes' }
    ])
    expect(continued.tools.map((t) => t.name)).toContain('run_command')
    expect(continued.name).not.toBe('conversation')

    for (const affirm of ['do it', 'go ahead', 'wire it up', 'proceed']) {
      const p = profileFor([
        { role: 'user', content: 'edit src/main/index.ts to register the devtools' },
        { role: 'assistant', content: 'Ready when you are.' },
        { role: 'user', content: affirm }
      ])
      expect(p.tools.map((t) => t.name), affirm).toContain('run_command')
    }

    // A bare "yes" after a NON-filesystem turn must not invent filesystem tools.
    const afterChat = profileFor([
      { role: 'user', content: 'tell me a joke' },
      { role: 'assistant', content: 'Why did the dev cross the road?' },
      { role: 'user', content: 'yes' }
    ])
    expect(afterChat.tools.map((t) => t.name)).not.toContain('run_command')
  })

  it('does not let install/update wording hijack web or conversational turns', () => {
    // The install short-circuit must stay narrow: plain-English "update"/"set up"
    // phrasings about news/web content must not be pulled into a filesystem turn.
    const notInstalls = [
      'update me on the news',
      'look up the latest React news',
      "what's the latest on the election",
      'search for the current weather',
      'get me up to speed',
      'review the recent updates online'
    ]
    for (const text of notInstalls) {
      expect(shouldUseWorkspaceContext(text), text).toBe(false)
      const tools = selectAgentToolProfile(text).tools.map((t) => t.name)
      expect(tools, text).not.toContain('run_command')
    }
  })

  it('gives filesystem turns the full path block and lean turns an escalation hint', () => {
    const { service } = makeService('/tmp/selected-project')
    const block = (text: string) =>
      (service as any).workspaceSystemBlock(selectAgentToolProfile(text)) as string | null

    // Filesystem-capable turn: full path-resolution block.
    const fs = block('edit src/main/index.ts')
    expect(fs).toContain('/tmp/selected-project')
    expect(fs).toContain('Workspace:')

    // Lean turn WITH a folder selected: a short hint that points at request_tools,
    // so "what should we install" can escalate instead of answering generically.
    const lean = block('tell me a joke')
    expect(lean).toContain('/tmp/selected-project')
    expect(lean).toContain('request_tools')
  })

  it('attaches no working-folder block when no folder is selected', () => {
    const { service } = makeService(null)
    const block = (text: string) =>
      (service as any).workspaceSystemBlock(selectAgentToolProfile(text)) as string | null
    expect(block('tell me a joke')).toBe(null)
    expect(block('edit src/main/index.ts')).toBe(null)
  })

  it('emits a routing trace for the selected agent profile', () => {
    const { service, emit } = makeService()
    const policy = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: 'edit src/main/models/ChatService.ts and run typecheck' }]
    } as any)

    ;(service as any).emitContractTrace({ requestId: 'req-contract' }, policy, 'anthropic')

    expect(emit).toHaveBeenCalledWith({
      requestId: 'req-contract',
      type: 'contract_trace',
      profile: 'filesystem',
      tools: policy.profile.tools.map((tool) => tool.name),
      activePage: { included: false, reason: 'no-active-page-reference' },
      workspace: { included: false, reason: 'no-selected-folder' },
      codexCwd: undefined,
      inputs: {
        selectedFolder: undefined,
        activePageContext: undefined,
        codexCwd: undefined
      }
    })
    expect(emit.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining(['read_file', 'edit_file', 'run_validation', 'recall_history'])
    )
  })

  it('stamps stream events with the assistant message id for the request', async () => {
    const { service, emit } = makeService()

    await service.send({
      requestId: 'req-targeted',
      assistantMessageId: 'assistant-target',
      modelId: 'missing-model',
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(emit).toHaveBeenCalledWith({
      requestId: 'req-targeted',
      assistantMessageId: 'assistant-target',
      type: 'error',
      message: 'Unknown model missing-model'
    })
  })

  it('forwards broker-driven loop phase changes through ChatService event emission', async () => {
    const { tools, emit } = makeService('/tmp/selected-project')
    const broker = tools.setCapabilityBroker.mock.calls[0][0]

    await broker.repoOverview(
      { requestId: 'req-loop', assistantMessageId: 'assistant-loop', taskId: 'task-loop', iteration: 4 },
      { workspaceRoot: '/tmp/selected-project', focus: 'chat service' }
    )

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-loop',
      assistantMessageId: 'assistant-loop',
      type: 'loop_state',
      taskId: 'task-loop',
      event: 'phase_changed',
      phase: 'inspect',
      iteration: 4,
      summary: 'Gathering repository overview.'
    }))
  })

  it('emits supervisor-owned iteration lifecycle events', () => {
    const req = {
      requestId: 'req-supervisor',
      assistantMessageId: 'assistant-supervisor',
      conversationId: 'conv-supervisor',
      modelId: 'dummy',
      messages: [{ role: 'user', content: 'edit src/main/index.ts' }]
    } as any

    const { emit, supervisor } = makeSupervisorHarness(req)
    supervisor.start('Starting shared supervisor.')
    supervisor.iterationStarted(2)
    supervisor.iterationCompleted(2, 'Executed 1 tool call.')
    supervisor.complete('Finished shared supervisor.')

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'task_started',
        phase: 'inspect',
        summary: 'Starting shared supervisor.'
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'phase_changed',
        phase: 'act',
        summary: 'Entering execution loop.'
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'iteration_started',
        phase: 'act',
        iteration: 2
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 2,
        summary: 'Executed 1 tool call.'
      }),
      expect.objectContaining({
        requestId: 'req-supervisor',
        type: 'loop_state',
        taskId: 'conv-supervisor',
        event: 'task_completed',
        phase: 'done',
        summary: 'Finished shared supervisor.'
      })
    ])
  })

  it('maps supervisor retry transitions into loop phase changes', () => {
    const req = {
      requestId: 'req-decision',
      assistantMessageId: 'assistant-decision',
      conversationId: 'conv-decision',
      modelId: 'dummy',
      messages: [{ role: 'user', content: 'edit src/main/index.ts' }]
    } as any

    const { emit, supervisor } = makeSupervisorHarness(req)
    supervisor.transition(1, {
      iterationSummary: 'Validation required another pass.',
      decision: {
        kind: 'validation_required',
        signal: 'retry',
        summary: 'Validation is required before the turn can finish.'
      }
    })
    supervisor.transition(2, {
      iterationSummary: 'Validation required another pass.',
      decision: {
        kind: 'validation_failed',
        signal: 'retry',
        summary: 'Automatic validation failed; another repair pass is required.'
      }
    })

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-decision',
        type: 'loop_state',
        taskId: 'conv-decision',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 1,
        summary: 'Validation required another pass.'
      }),
      expect.objectContaining({
        requestId: 'req-decision',
        type: 'loop_state',
        taskId: 'conv-decision',
        event: 'task_paused',
        phase: 'validate',
        summary: 'Validation is required before the turn can finish.'
      }),
      expect.objectContaining({
        requestId: 'req-decision',
        type: 'loop_state',
        taskId: 'conv-decision',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 2,
        summary: 'Validation required another pass.'
      }),
      expect.objectContaining({
        requestId: 'req-decision',
        type: 'loop_state',
        taskId: 'conv-decision',
        event: 'task_paused',
        phase: 'decide',
        summary: 'Automatic validation failed; another repair pass is required.'
      })
    ])
  })

  it('maps tool-result retry decisions back into the act phase', () => {
    const req = {
      requestId: 'req-tool-results',
      assistantMessageId: 'assistant-tool-results',
      conversationId: 'conv-tool-results',
      modelId: 'dummy',
      messages: [{ role: 'user', content: 'inspect and continue' }]
    } as any

    const { emit, supervisor } = makeSupervisorHarness(req)
    supervisor.transition(3, {
      iterationSummary: 'Executed 2 tool call(s).',
      decision: {
        kind: 'tool_results_ready',
        signal: 'retry',
        summary: 'Tool results are ready; continuing the agent loop.'
      }
    })

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-tool-results',
        type: 'loop_state',
        taskId: 'conv-tool-results',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 3,
        summary: 'Executed 2 tool call(s).'
      }),
      expect.objectContaining({
        requestId: 'req-tool-results',
        type: 'loop_state',
        taskId: 'conv-tool-results',
        event: 'phase_changed',
        phase: 'act',
        summary: 'Tool results are ready; continuing the agent loop.'
      })
    ])
  })

  it('maps supervisor finish signals into stable loop events', () => {
    const req = {
      requestId: 'req-finish',
      assistantMessageId: 'assistant-finish',
      conversationId: 'conv-finish',
      modelId: 'dummy',
      messages: [{ role: 'user', content: 'finish the task' }]
    } as any

    const { emit, supervisor } = makeSupervisorHarness(req)
    supervisor.transition(1, {
      iterationSummary: 'Model stopped without further tool calls.',
      decision: {
        kind: 'validation_passed',
        signal: 'finish',
        summary: 'Automatic validation passed.'
      }
    })
    supervisor.transition(2, {
      iterationSummary: 'Model stopped without further tool calls.',
      decision: {
        kind: 'stopped_without_validation',
        signal: 'finish_with_warning',
        summary: 'I edited files, but validation has not passed, so I cannot honestly mark this complete yet.'
      }
    })

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        requestId: 'req-finish',
        type: 'loop_state',
        taskId: 'conv-finish',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 1,
        summary: 'Model stopped without further tool calls.'
      }),
      expect.objectContaining({
        requestId: 'req-finish',
        type: 'loop_state',
        taskId: 'conv-finish',
        event: 'phase_changed',
        phase: 'decide',
        summary: 'Automatic validation passed.'
      }),
      expect.objectContaining({
        requestId: 'req-finish',
        type: 'loop_state',
        taskId: 'conv-finish',
        event: 'iteration_completed',
        phase: 'decide',
        iteration: 2,
        summary: 'Model stopped without further tool calls.'
      }),
      expect.objectContaining({
        requestId: 'req-finish',
        type: 'loop_state',
        taskId: 'conv-finish',
        event: 'task_blocked',
        phase: 'decide',
        summary: 'I edited files, but validation has not passed, so I cannot honestly mark this complete yet.'
      })
    ])
  })

  it('explains when a selected folder is ignored for unrelated turns', () => {
    const { service, emit } = makeService('/tmp/selected-project')
    const policy = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: 'tell me a joke' }]
    } as any)

    ;(service as any).emitContractTrace({ requestId: 'req-contract' }, policy, 'anthropic')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      workspace: { included: false, reason: 'no-local-intent' }
    }))
  })

  it('explains Codex cwd posture for workspace turns', () => {
    const { service, emit } = makeService('/tmp/selected-project')
    const policy = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: 'edit src/main/index.ts' }]
    } as any)

    ;(service as any).emitContractTrace({ requestId: 'req-contract' }, policy, 'codex')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'codex',
      workspace: { included: true, reason: 'local-path', detail: '/tmp/selected-project' },
      codexCwd: { included: true, reason: 'selected-folder', detail: '/tmp/selected-project' },
      inputs: {
        selectedFolder: '/tmp/selected-project',
        activePageContext: undefined,
        codexCwd: '/tmp/selected-project'
      }
    }))
  })

  it('keeps the selected folder as Codex cwd even for ordinary prompts', () => {
    const { service, emit } = makeService('/tmp/selected-project')
    const policy = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: 'tell me a joke' }]
    } as any)

    ;(service as any).emitContractTrace({ requestId: 'req-contract' }, policy, 'codex')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'codex',
      workspace: { included: false, reason: 'no-local-intent' },
      codexCwd: { included: true, reason: 'selected-folder', detail: '/tmp/selected-project' },
      inputs: expect.objectContaining({
        selectedFolder: '/tmp/selected-project',
        codexCwd: '/tmp/selected-project'
      })
    }))
  })

  it('traces active-page context as attached only when the page preamble is retained', () => {
    const { service, emit } = makeService()
    const attached = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: '[Active page: Docs — https://docs.example/]\n\nsummarize this page' }]
    } as any)
    const stale = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: '[Active page: Docs — https://docs.example/]\n\ntell me a joke' }]
    } as any)
    const unavailable = resolveTurnContextPolicy({
      messages: [{ role: 'user', content: 'summarize this page' }]
    } as any)

    ;(service as any).emitContractTrace({ requestId: 'req-attached' }, attached, 'anthropic')
    ;(service as any).emitContractTrace({ requestId: 'req-stale' }, stale, 'anthropic')
    ;(service as any).emitContractTrace({ requestId: 'req-unavailable' }, unavailable, 'anthropic')

    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      activePage: { included: true, reason: 'active-page-reference' },
      inputs: expect.objectContaining({
        activePageContext: 'Docs — https://docs.example/'
      })
    }))
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      activePage: { included: false, reason: 'no-active-page-reference' }
    }))
    expect(emit).toHaveBeenNthCalledWith(3, expect.objectContaining({
      activePage: { included: false, reason: 'no-active-page-available' }
    }))
  })

  it('traces active-page continuation separately from explicit page references', () => {
    const { service, emit } = makeService()
    const policy = resolveTurnContextPolicy({
      contextHints: { activePageFollowup: true },
      messages: [{ role: 'user', content: '[Active page: Docs — https://docs.example/]\n\nwhat about the links?' }]
    } as any)

    ;(service as any).emitContractTrace({ requestId: 'req-followup' }, policy, 'anthropic')

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      activePage: { included: true, reason: 'active-page-followup' },
      inputs: expect.objectContaining({
        activePageContext: 'Docs — https://docs.example/'
      })
    }))
  })

  it('only includes prompt guidance for the tools exposed to that turn', async () => {
    const conversationSystem = await buildAgentSystem(selectAgentToolProfile('tell me a joke').tools)
    expect(conversationSystem).toContain('- recall_history:')
    expect(conversationSystem).toContain('Resume process:')
    expect(conversationSystem).toContain('A bare resume request such as "pick up where we were"')
    expect(conversationSystem).toContain('not permission to edit files')
    expect(conversationSystem).not.toContain('[NEED_MORE_CONTEXT]')
    expect(conversationSystem).not.toContain('## Browser tools')
    expect(conversationSystem).not.toContain('## Filesystem')
    expect(conversationSystem).not.toContain('Always call read_page FIRST')
    expect(conversationSystem).not.toContain('search_files first')

    const filesystemSystem = await buildAgentSystem(
      selectAgentToolProfile('read src/main/models/ChatService.ts').tools
    )
    expect(filesystemSystem).toContain('## Filesystem')
    expect(filesystemSystem).toContain('## Validation')
    expect(filesystemSystem).toContain('run_validation')
    expect(filesystemSystem).toContain('- run_validation:')
    expect(filesystemSystem).not.toContain('## Browser tools')
    expect(filesystemSystem).not.toContain('- read_page:')
  })

  it('keeps Codex resume memory pull-only instead of injecting a previous-chat overview', async () => {
    const { service } = makeService()
    const codexSend = vi.fn(async (..._args: any[]) => 'done')
    ;(service as any).codexClient = {
      send: codexSend,
      complete: vi.fn(),
      status: vi.fn(),
      listModels: vi.fn()
    }

    await service.send({
      requestId: 'req-resume',
      modelId: 'gpt-5.5',
      conversationId: 'child',
      mode: 'agent',
      messages: [{ role: 'user', content: 'lets pick up where we were' }]
    })

    expect(codexSend).toHaveBeenCalledOnce()
    const sentReq = codexSend.mock.calls[0]?.[0]
    expect(sentReq).toBeDefined()
    expect(sentReq.messages).toEqual([
      { role: 'user', content: 'lets pick up where we were' }
    ])
    expect(codexSend.mock.calls[0]?.[3]).toBe(true)
    expect(JSON.stringify(sentReq.messages)).not.toContain('Previous chat')
    expect(JSON.stringify(sentReq.messages)).not.toContain('overview')
  })

  it('routes Codex lifecycle events through the shared supervisor surface', async () => {
    const { service, emit } = makeService('/tmp/selected-project')
    const codexSend = vi.fn(async (..._args: any[]) => 'done')
    ;(service as any).codexClient = {
      send: codexSend,
      complete: vi.fn(),
      status: vi.fn(),
      listModels: vi.fn()
    }
    // localPreviewBridge runs via the browser pipeline; tests don't exercise it here.
    vi.spyOn(service as any, 'workspaceSystemBlock').mockReturnValue('Workspace: /tmp/selected-project')
    vi.spyOn(service as any, 'codexRepoOverviewBlock').mockResolvedValue(null)

    await service.send({
      requestId: 'req-codex-supervisor',
      assistantMessageId: 'assistant-codex-supervisor',
      conversationId: 'conv-codex-supervisor',
      modelId: 'gpt-5.5',
      mode: 'agent',
      messages: [{ role: 'user', content: 'edit src/main/index.ts' }]
    } as any)

    expect(emit.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'req-codex-supervisor',
          assistantMessageId: 'assistant-codex-supervisor',
          type: 'loop_state',
          taskId: 'conv-codex-supervisor',
          event: 'task_started',
          phase: 'inspect',
          summary: 'Starting Codex task loop.'
        }),
        expect.objectContaining({
          requestId: 'req-codex-supervisor',
          assistantMessageId: 'assistant-codex-supervisor',
          type: 'loop_state',
          taskId: 'conv-codex-supervisor',
          event: 'phase_changed',
          phase: 'act',
          summary: 'Handing the task to Codex with harness support.'
        }),
        expect.objectContaining({
          requestId: 'req-codex-supervisor',
          assistantMessageId: 'assistant-codex-supervisor',
          type: 'loop_state',
          taskId: 'conv-codex-supervisor',
          event: 'task_completed',
          phase: 'done',
          summary: 'Codex task loop completed.'
        })
      ])
    )
  })

  it('injects the gladdis-browser instruction into the live Codex system prompt', () => {
    expect(CODEX_SYSTEM).not.toContain('[NEED_MORE_CONTEXT]')
    expect(CODEX_SYSTEM).toContain('Resume process:')
    expect(CODEX_SYSTEM).toContain('Do not edit files, run validations, navigate pages, or continue old work')
    // The browser instruction must be part of the prompt Codex actually receives,
    // not a dead constant — this is what steers it to the gladdis.* tools and
    // away from shelling out to a native browser.
    expect(CODEX_SYSTEM).toContain(CODEX_BROWSER_INSTRUCTIONS)
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('NEVER reach for a browser through your native shell')
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('Do not launch a second Gladdis/dev')
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('playwright (screenshot/open/codegen/test/show-report)')
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('localhost:9222 DevTools')
  })

  it('does not attach or read the active page for ordinary chat', async () => {
    const { service, tools } = makeService()
    const agent = vi.spyOn(service as any, 'agentAnthropic').mockResolvedValue(undefined)
    const stream = vi.spyOn(service as any, 'streamPlain').mockResolvedValue(undefined)

    await service.send({
      requestId: 'req-joke',
      modelId: 'claude-sonnet-4-6',
      tabId: 'tab-1',
      conversationId: 'conv-1',
      mode: 'agent',
      messages: [{ role: 'user', content: '[Active page: Hacker News — https://news.ycombinator.com/]\n\ntell me a joke' }]
    } as any)

    expect(agent).not.toHaveBeenCalled()
    expect(stream).toHaveBeenCalledOnce()
    const streamedReq = stream.mock.calls[0][1] as any
    expect(streamedReq.messages.at(-1)?.content).toBe('tell me a joke')
    expect(tools.run).not.toHaveBeenCalled()
  })

  it('keeps browser context only when the user explicitly refers to the page', async () => {
    const { service } = makeService()
    const agent = vi.spyOn(service as any, 'agentAnthropic').mockResolvedValue(undefined)
    const stream = vi.spyOn(service as any, 'streamPlain').mockResolvedValue(undefined)

    await service.send({
      requestId: 'req-page',
      modelId: 'claude-sonnet-4-6',
      tabId: 'tab-1',
      conversationId: 'conv-1',
      mode: 'agent',
      messages: [{ role: 'user', content: '[Active page: Docs — https://docs.example/]\n\nsummarize this page' }]
    } as any)

    expect(agent).toHaveBeenCalledOnce()
    expect(stream).not.toHaveBeenCalled()
    const agentReq = agent.mock.calls[0][0] as any
    expect(agentReq.messages.at(-1)?.content).toContain('[Active page:')
  })

  it('runs browse_task/search on the user\'s picked model — no silent gemini substitution', () => {
    const { service } = makeService()
    const completed: string[] = []
    vi.spyOn(service as any, 'complete').mockImplementation((async (modelId: string) => {
      completed.push(modelId)
      return 'ok'
    }) as any)

    // browserPipelineLlm must hand back the requested model, for every provider.
    for (const id of ['claude-opus-4-8', 'gemini-3.1-pro', 'gpt-5.5']) {
      const { model, llm } = (service as any).browserPipelineLlm({ id, label: id, provider: 'x' })
      expect(model.id).toBe(id)
      void llm('sys', 'user', {})
    }
    expect(completed).toEqual(['claude-opus-4-8', 'gemini-3.1-pro', 'gpt-5.5'])
  })

  it('passes the conversation id through browser pipeline completions by default', async () => {
    const { service } = makeService()
    const complete = vi.spyOn(service as any, 'complete').mockResolvedValue('ok')
    const { llm } = (service as any).browserPipelineLlm(
      { id: 'grok-4.3', label: 'grok-4.3', provider: 'grok' },
      'conv-cache-key'
    )

    await llm('sys', 'user', { stage: 'pipeline:planner' })
    await llm('sys', 'user', { stage: 'pipeline:final', conversationId: 'explicit-conv' })

    expect(complete).toHaveBeenNthCalledWith(
      1,
      'grok-4.3',
      'sys',
      'user',
      expect.objectContaining({ stage: 'pipeline:planner', conversationId: 'conv-cache-key' })
    )
    expect(complete).toHaveBeenNthCalledWith(
      2,
      'grok-4.3',
      'sys',
      'user',
      expect.objectContaining({ stage: 'pipeline:final', conversationId: 'explicit-conv' })
    )
  })

  it('strips renderer active-page context before browser task routing', () => {
    expect(
      hasActivePagePreamble(
        '[Active page: Hacker News — https://news.ycombinator.com/]\n\nopen the first title'
      )
    ).toBe(true)
    expect(
      stripActivePagePreamble(
        '[Active page: Hacker News — https://news.ycombinator.com/]\n\nopen the first title'
      )
    ).toBe('open the first title')
    expect(shouldAttachActivePageContext('tell me a joke')).toBe(false)
    expect(shouldAttachActivePageContext('summarize this page')).toBe(true)
    expect(shouldContinueActivePageContext('what about the links?')).toBe(true)
    expect(shouldContinueActivePageContext('edit src/main/index.ts')).toBe(false)
    expect(shouldUseBrowserTools('search the web for xAI docs')).toBe(true)
    expect(shouldUseBrowserTools('create a login form page')).toBe(false)
    expect(shouldUseBrowserTools('make this sound more official')).toBe(false)
    expect(shouldUseBrowserTools('explain docs architecture')).toBe(false)
    expect(shouldUseBrowserTools('look up the official docs')).toBe(true)
  })

  it('detects mixed Codex tasks that should hand a local preview back to the browser', () => {
    expect(
      isUserFacingLocalPreviewRequest(
        '[Active page: Example — https://example.com/]\n\n' +
          'create a test app, launch it in a dev server so we can look at it in the browser'
      )
    ).toBe(true)
    expect(isUserFacingLocalPreviewRequest('build the app and run npm test')).toBe(false)
    expect(isUserFacingLocalPreviewRequest('explain localhost routing in the source')).toBe(false)
  })

  it('extracts the first local preview URL from Codex output', () => {
    expect(extractLocalPreviewUrl('Ready at http://127.0.0.1:5174/.')).toBe('http://127.0.0.1:5174/')
    expect(extractLocalPreviewUrl('Open http://localhost:3000/dashboard to view it')).toBe(
      'http://localhost:3000/dashboard'
    )
    expect(extractLocalPreviewUrl('Open `http://127.0.0.1:5174/` in the browser.')).toBe(
      'http://127.0.0.1:5174/'
    )
    expect(extractLocalPreviewUrl('Published at https://example.com/')).toBeNull()
  })

  it('opens Codex-created local previews in the active browser tab and captures a confirmation screenshot', async () => {
    vi.useFakeTimers()
    const { emit, tools } = makeService()

    const run = openCodexLocalPreviewIfRequested({
      req: {
        requestId: 'req-preview',
        modelId: 'gpt-5.5',
        tabId: 'tab-1',
        messages: []
      } as any,
      userText:
        'create a test app and launch it in a dev server so we can look at it in the browser',
      output: 'Done. Open http://127.0.0.1:5174/ in the browser.',
      tools: tools as any,
      emit
    })
    await vi.advanceTimersByTimeAsync(800)
    await run
    vi.useRealTimers()

    expect(tools.tabs.navigate).toHaveBeenCalledWith('tab-1', 'http://127.0.0.1:5174/')
    expect(tools.tabs.capturePagePng).toHaveBeenCalledWith('tab-1', false)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-preview',
        type: 'tool_call',
        tool: 'navigate'
      })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-preview',
        type: 'tool_result',
        ok: true,
        preview: 'Opened http://127.0.0.1:5174/ in the browser.'
      })
    )
    expect(emit).toHaveBeenCalledWith({
      requestId: 'req-preview',
      type: 'delta',
      text: '\nOpened the local preview in the browser: http://127.0.0.1:5174/\n'
    })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-preview',
        type: 'tool_call',
        tool: 'screenshot_confirmation'
      })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-preview',
        type: 'tool_result',
        ok: true,
        preview: expect.stringContaining('Captured visible screenshot confirmation')
      })
    )
    expect(emit).toHaveBeenCalledWith({
      requestId: 'req-preview',
      type: 'delta',
      text: 'Screenshot confirmation captured for the local preview.\n'
    })
  })

  it('assigns unique Google tool call ids and carries them into function responses', async () => {
    const { service, emit, tools } = makeService()
    tools.run
      .mockResolvedValueOnce({ ok: true, text: 'first result' })
      .mockResolvedValueOnce({ ok: true, text: 'second result' })

    let secondTurnContents: any[] | undefined
    let callCount = 0
    ;(service as any).google = () => ({
      models: {
        generateContent: vi.fn(async ({ contents }: any) => {
          callCount += 1
          if (callCount === 1) {
            return {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { name: 'read_page', args: { focus: 'first' } } },
                      { functionCall: { name: 'read_page', args: { focus: 'second' } } }
                    ]
                  }
                }
              ],
              usageMetadata: {}
            }
          }
          secondTurnContents = JSON.parse(JSON.stringify(contents))
          return {
            candidates: [{ content: { parts: [{ text: 'done' }] } }],
            usageMetadata: {}
          }
        })
      }
    })

    await (service as any).agentGoogle(
      {
        requestId: 'req-1',
        modelId: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'inspect the page' }],
        tabId: 'tab-1'
      },
      'gemini-2.5-pro',
      new AbortController().signal
    )

    const toolCallEvents = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'tool_call')
    expect(toolCallEvents.map((event: any) => event.callId)).toEqual([
      'read_page-0-0',
      'read_page-0-1'
    ])

    const functionResponseTurn = secondTurnContents?.findLast((entry: any) =>
      entry.parts?.some((part: any) => part.functionResponse)
    )
    const functionResponses = functionResponseTurn?.parts
      .map((part: any) => part.functionResponse)
      .filter(Boolean)
    expect(functionResponses).toHaveLength(2)
    expect(functionResponses.map((response: any) => response.response.tool_call_id)).toEqual([
      'read_page-0-0',
      'read_page-0-1'
    ])
  })

  it('trims older Google tool results with a recallable tool_call_id', async () => {
    const records = [
      {
        name: 'read_page',
        callId: 'read_page-0-0',
        response: { result: 'older', tool_call_id: 'read_page-0-0' }
      },
      {
        name: 'check_page',
        callId: 'check_page-0-1',
        response: { result: 'newest', tool_call_id: 'check_page-0-1' }
      }
    ]

    await stubOldGoogleResults(records, 1)

    expect(records[0].response.result).toContain('[trimmed] (id read_page-0-0)')
    expect(records[0].response.result).toContain('tool_call_id "read_page-0-0"')
    expect(records[1].response.result).toBe('newest')
  })

  it('keeps Anthropic trim stubs recallable too', () => {
    const blocks = [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'older', is_error: false },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'newest', is_error: false }
    ] as any

    stubOldResults(blocks, 1)

    expect(blocks[0].content).toContain('[trimmed] (id toolu_1)')
    expect(blocks[0].content).toContain('tool_call_id "toolu_1"')
    expect(blocks[1].content).toBe('newest')
  })

  it('caps Google plain-stream output explicitly', async () => {
    const { service, emit } = makeService()
    let capturedConfig: any
    ;(service as any).google = () => ({
      models: {
        generateContentStream: vi.fn(async ({ config }: any) => {
          capturedConfig = config
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                text: 'hello',
                usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 }
              }
            }
          }
        })
      }
    })

    await (service as any).streamPlain(
      'google',
      {
        requestId: 'req-2',
        modelId: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'say hello' }]
      },
      'gemini-2.5-pro',
      new AbortController().signal
    )

    expect(capturedConfig.maxOutputTokens).toBe(32_000)
    const deltaEvents = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'delta')
    expect(deltaEvents).toHaveLength(1)
    expect(deltaEvents[0].text).toBe('hello')
  })
})
