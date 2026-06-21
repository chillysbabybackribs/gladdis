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
import { shouldAttachActivePageContext, shouldContinueActivePageContext, shouldUseBrowserTools } from '../../../shared/types'
import { shouldUseWorkspaceContext } from '../../../shared/types'
import { AGENT_TOOLS, selectAgentToolProfile } from './agentTools'
import { CODEX_BROWSER_INSTRUCTIONS, CODEX_BROWSER_TOOL_NAMES } from './codex/dynamicBrowserTools'
import { CODEX_SYSTEM, buildAgentSystem } from './prompts'
import { resolveTurnContextPolicy } from './turnContextPolicy'

function makeService(workspaceRoot: string | null = null) {
  const emit = vi.fn()
  const tools = {
    getWorkspaceRoot: () => workspaceRoot,
    run: vi.fn(),
    tabs: { activeTabId: 'tab-1', create: vi.fn(() => ({ id: 'tab-new' })), navigate: vi.fn(), capturePagePng: vi.fn(async () => Buffer.from('png').toString('base64')) }
  } as any
  const audit = { begin: vi.fn(() => ({ addOutput: vi.fn(), finish: vi.fn() })) } as any

  return {
    emit,
    tools,
    audit,
    service: new ChatService({} as any, emit, tools, audit, {} as any)
  }
}

describe('ChatService provider hardening', () => {
  it('exposes the model-driven browser surface (search/fetch_page/background_web_search), not the old engine', () => {
    const toolNames = AGENT_TOOLS.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(['search', 'navigate', 'background_web_search']))
    // The over-engineered app-owned search tool is gone.
    expect(toolNames).not.toContain('search_task')
    expect(toolNames).not.toContain('search_web')
    expect(toolNames).not.toContain('check_page')
  })

  it('gives all three providers ONE browser surface (Codex sees the same tools)', () => {
    // Codex's browser tools are derived from AGENT_TOOLS — same surface, namespaced.
    expect(CODEX_BROWSER_TOOL_NAMES.has('search')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('navigate')).toBe(true)
    expect(CODEX_BROWSER_TOOL_NAMES.has('background_web_search')).toBe(true)
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
    expect(mixedProfile.name).toBe('full')

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
    expect(conversationProfile.tools.map((tool) => tool.name)).toEqual(['recall_history'])
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

  it('only attaches the working-folder block to filesystem-capable turns', () => {
    const { service } = makeService('/tmp/selected-project')

    expect(
      (service as any).workspaceSystemBlock(selectAgentToolProfile('search the web for xAI docs'))
    ).toBe(null)
    expect(
      (service as any).workspaceSystemBlock(selectAgentToolProfile('tell me a joke'))
    ).toBe(null)
    expect(
      (service as any).workspaceSystemBlock(selectAgentToolProfile('edit src/main/index.ts'))
    ).toContain('/tmp/selected-project')
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

  it('tells Codex to use the current Gladdis app/browser instead of launching a second viewer', () => {
    expect(CODEX_SYSTEM).not.toContain('[NEED_MORE_CONTEXT]')
    expect(CODEX_SYSTEM).toContain('Resume process:')
    expect(CODEX_SYSTEM).toContain('Do not edit files, run validations, navigate pages, or continue old work')
    expect(CODEX_SYSTEM).toContain('you are already running inside the app')
    expect(CODEX_SYSTEM).toContain('Do not launch a second Gladdis/dev app')
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('use the current visible app/browser first')
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('do not launch a second Gladdis/dev app')
  })

  it('does not attach or read the active page for ordinary chat', async () => {
    const { service, tools } = makeService()
    const agent = vi.spyOn(service as any, 'agentAnthropic').mockResolvedValue(undefined)
    const stream = vi.spyOn(service as any, 'streamAnthropic').mockResolvedValue(undefined)

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
    const streamedReq = stream.mock.calls[0][0] as any
    expect(streamedReq.messages.at(-1)?.content).toBe('tell me a joke')
    expect(tools.run).not.toHaveBeenCalled()
  })

  it('keeps browser context only when the user explicitly refers to the page', async () => {
    const { service } = makeService()
    const agent = vi.spyOn(service as any, 'agentAnthropic').mockResolvedValue(undefined)
    const stream = vi.spyOn(service as any, 'streamAnthropic').mockResolvedValue(undefined)

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
    const { service, emit, tools } = makeService()

    const run = (service as any).openCodexLocalPreviewIfRequested(
      {
        requestId: 'req-preview',
        modelId: 'gpt-5.5',
        tabId: 'tab-1',
        messages: []
      },
      'create a test app and launch it in a dev server so we can look at it in the browser',
      'Done. Open http://127.0.0.1:5174/ in the browser.'
    )
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

  it('trims older Google tool results with a recallable tool_call_id', () => {
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

    stubOldGoogleResults(records, 1)

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

    await (service as any).streamGoogle(
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
