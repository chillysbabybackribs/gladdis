import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationService, type AgentToolSurface } from './AgentConfigurationService'

function makeConfigService(workspaceRoot: string | null = null) {
  const tools = {
    getWorkspaceRoot: () => workspaceRoot,
    tabs: { liveTabId: vi.fn((id?: string | null) => id ?? 'tab-1') }
  } as any
  const repoIntelligence = {} as any
  const emit = vi.fn()
  const service = new AgentConfigurationService(tools, repoIntelligence, emit)
  return { service, tools, repoIntelligence, emit }
}

describe('AgentConfigurationService', () => {
  it('routes mixed browser + code work onto a compact shared surface', async () => {
    const { service } = makeConfigService('/home/user/project')
    const req = {
      messages: [{ role: 'user', content: 'check the current docs site and then update the parser code' }]
    } as any

    const anthropic = await service.agentToolProfile(req)
    const openai = await service.agentToolProfile(req, 'openai')

    expect(anthropic.name).toContain('browser-core')
    expect(anthropic.name).toContain('filesystem-core')
    expect(openai.name).toBe(anthropic.name)

    const anthropicNames = anthropic.tools.map((tool: { name: string }) => tool.name)
    const openaiNames = openai.tools.map((tool: { name: string }) => tool.name)

    expect(openaiNames).toEqual(anthropicNames)
    expect(openaiNames).toEqual(expect.arrayContaining([
      'search',
      'navigate',
      'grep_page',
      'act',
      'search_files',
      'read_file',
      'edit_file'
    ]))
    expect(openaiNames).not.toContain('memory_write')
  })

  it('applies saved preferred/disallowed tool constraints to the routed surface', async () => {
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

    expect(constrained.name).toBe('filesystem-core')
    expect(names).toContain('grep_page')
    expect(names).toContain('run_command')
    expect(names).not.toContain('search_files')
  })

  it('keeps browser essentials on a bare continuation', async () => {
    const { service } = makeConfigService()
    const req = {
      messages: [
        { role: 'user', content: 'click the login button' },
        { role: 'assistant', content: 'I see it...' },
        { role: 'user', content: 'do it' }
      ]
    } as any
    const profile = await service.agentToolProfile(req)
    const names = profile.tools.map((tool: { name: string }) => tool.name)
    expect(profile.name).toContain('browser-core')
    expect(names).toEqual(expect.arrayContaining(['search', 'navigate', 'grep_page', 'act']))
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
})
