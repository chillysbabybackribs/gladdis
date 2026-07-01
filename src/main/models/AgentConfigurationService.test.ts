import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationService, type AgentToolSurface } from './AgentConfigurationService'

function makeConfigService(workspaceRoot: string | null = null) {
  const tools = {
    getWorkspaceRoot: () => workspaceRoot,
    tabs: { liveTabId: vi.fn((id?: string | null) => id ?? 'tab-1') },
    calibrationBlock: vi.fn(() => '## Tool calibration\nCalibrate the current tool before switching to another one.\nIf read_a11y is noisy or incomplete, retry read_a11y first.\nIf grep_page misses, keep grep_page and try 2-3 sharper subject-based phrase variations, not the whole prompt and not a one-word probe.')
  } as any
  const repoIntelligence = {} as any
  const emit = vi.fn()
  const service = new AgentConfigurationService(tools, repoIntelligence, emit)
  return { service, tools, repoIntelligence, emit }
}

describe('AgentConfigurationService', () => {
  it('hands every turn the full flat surface, identical across providers', async () => {
    const { service } = makeConfigService('/home/user/project')
    const req = {
      messages: [{ role: 'user', content: 'check the current docs site and then update the parser code' }]
    } as any

    const anthropic = await service.agentToolProfile(req)
    const openai = await service.agentToolProfile(req, 'openai')

    expect(anthropic.name).toBe('full')
    expect(openai.name).toBe('full')

    const anthropicNames = anthropic.tools.map((tool: { name: string }) => tool.name)
    const openaiNames = openai.tools.map((tool: { name: string }) => tool.name)

    // Same list, every domain present in one flat surface (Phase C).
    expect(openaiNames).toEqual(anthropicNames)
    expect(openaiNames).toEqual(expect.arrayContaining([
      'search',
      'navigate',
      'grep_page',
      'act',
      'search_files',
      'read_file',
      'edit_file',
      'run_command',
      'memory_write'
    ]))
    // The tool-discovery hatch is retired: no subset, so nothing to discover.
    expect(openaiNames).not.toContain('search_tool')
  })

  it('returns the SAME stable array reference across turns so tool caches hit', async () => {
    const { service } = makeConfigService('/home/user/project')
    const first = await service.agentToolProfile(
      { messages: [{ role: 'user', content: 'edit the parser and run typecheck' }] } as any
    )
    const second = await service.agentToolProfile(
      { messages: [{ role: 'user', content: 'now open the docs site' }] } as any,
      'openai'
    )
    // No per-agent policy → both turns get the identical AGENT_TOOLS reference,
    // which is what the WeakMap-keyed serializers + Anthropic ephemeral
    // cache_control rely on to avoid re-sending the tool block each turn.
    expect(second.tools).toBe(first.tools)
  })

  it('applies saved preferred/disallowed tool constraints without mutating the shared surface', async () => {
    const { service } = makeConfigService()
    const baseSurface = await service.agentToolProfile({
      messages: [{ role: 'user', content: 'read src/main/models/ChatService.ts and suggest fixes' }]
    } as any)
    const constrained = (service as any).applyAgentToolPolicy(
      {
        agent: {
          preferredTools: ['grep_page', 'run_command'],
          disallowedTools: ['search_files']
        }
      },
      baseSurface
    ) as AgentToolSurface
    const names = constrained.tools.map((tool: { name: string }) => tool.name)

    expect(names).toContain('grep_page')
    expect(names).toContain('run_command')
    expect(names).not.toContain('search_files')
    // The shared surface is untouched — removal happened on a copy.
    expect(baseSurface.tools.map((t) => t.name)).toContain('search_files')
  })

  it('drops lone act when saved preferences strip away every companion verb', async () => {
    const { service } = makeConfigService()
    const baseSurface = await service.agentToolProfile({
      messages: [{ role: 'user', content: 'click the login button' }]
    } as any)

    // The full surface ships act WITH its companions; removing all companions
    // must also drop act (it is never advertised alone).
    const constrained = (service as any).applyAgentToolPolicy(
      {
        agent: {
          disallowedTools: ['set_field', 'submit', 'open_result']
        }
      },
      baseSurface
    ) as AgentToolSurface

    const names = constrained.tools.map((tool: { name: string }) => tool.name)
    expect(names).not.toContain('act')
  })

  it('keeps act alongside its companion browser verbs on the full surface', async () => {
    const { service } = makeConfigService()
    const baseSurface = await service.agentToolProfile({
      messages: [{ role: 'user', content: 'click the login button' }]
    } as any)

    const names = baseSurface.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain('act')
    expect(names).toContain('submit')
  })

  it('attaches the workspace block when a folder is selected', () => {
    const { service } = makeConfigService('/home/user/project')
    expect(service.workspaceSystemBlock()).toBe('Workspace: /home/user/project')
  })

  it('attaches no working-folder block when no folder is selected', () => {
    const { service } = makeConfigService(null)
    expect(service.workspaceSystemBlock()).toBeNull()
  })

  it('adds direct-API local-work guidance to the turn system prompt for OpenAI', async () => {
    const { service } = makeConfigService('/home/user/project')
    const req = { messages: [{ role: 'user', content: 'inspect the repo and fix the UI' }] } as any
    const system = await service.buildTurnAgentSystem(
      req,
      (await service.agentToolProfile(req, 'openai')).tools,
      'openai'
    )

    expect(system).toContain('## Direct API local-work contract')
    expect(system).toContain('use search_files to locate the exact area before any raw reads')
    expect(system).toContain('read_file with explicit start_line/end_line windows')
    expect(system).toContain('Avoid full:true unless the file is small')
    expect(system).toContain('Keep Gladdis browser tools first-class for web search')
  })

  it('adds the same direct-API local-work guidance to the turn system prompt for Grok', async () => {
    const { service } = makeConfigService('/home/user/project')
    const req = { messages: [{ role: 'user', content: 'inspect the repo and fix the UI' }] } as any
    const system = await service.buildTurnAgentSystem(
      req,
      (await service.agentToolProfile(req, 'grok')).tools,
      'grok'
    )

    expect(system).toContain('## Direct API local-work contract')
    expect(system).toContain('use search_files to locate the exact area before any raw reads')
    expect(system).toContain('read_file with explicit start_line/end_line windows')
    expect(system).toContain('Avoid full:true unless the file is small')
    expect(system).toContain('Keep Gladdis browser tools first-class for web search')
  })

  it('adds same-tool calibration guidance to the turn system prompt', async () => {
    const { service } = makeConfigService('/home/user/project')
    const req = { messages: [{ role: 'user', content: 'inspect the page controls and then patch the code' }] } as any
    const system = await service.buildTurnAgentSystem(
      req,
      (await service.agentToolProfile(req, 'openai')).tools,
      'openai'
    )

    expect(system).toContain('## Tool calibration')
    expect(system).toContain('Calibrate the current tool before switching to another one')
    expect(system).toContain('If read_a11y is noisy or incomplete, retry read_a11y first')
    expect(system).toContain('If grep_page misses, keep grep_page and try 2-3 sharper subject-based phrase variations')
  })

  it('keeps OpenAI browser-capable tool routing aligned with the shared mixed browser + code surface', async () => {
    const { service } = makeConfigService('/home/user/project')
    const req = {
      messages: [{ role: 'user', content: 'check the current docs site and then update the parser code' }]
    } as any

    const anthropicNames = (await service.agentToolProfile(req)).tools.map((tool) => tool.name)
    const openaiNames = (await service.agentToolProfile(req, 'openai')).tools.map((tool) => tool.name)

    expect(openaiNames).toEqual(anthropicNames)
    expect(openaiNames).toEqual(expect.arrayContaining([
      'navigate',
      'grep_page',
      'search_files',
      'read_file',
      'edit_file'
    ]))
  })

  it('exposes the full suite on an ordinary turn (no explicit request needed)', async () => {
    const { service } = makeConfigService('/repo')
    const req = {
      messages: [{ role: 'user', content: 'poke at something' }]
    } as any

    const toolNames = (await service.agentToolProfile(req)).tools.map((tool) => tool.name)

    expect(toolNames).not.toContain('search_tool')
    expect(toolNames).toContain('search')
    expect(toolNames).toContain('navigate')
    expect(toolNames).toContain('run_command')
    expect(toolNames.length).toBeGreaterThan(10)
  })
})
