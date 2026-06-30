import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationService } from './AgentConfigurationService'
import { selectAgentToolProfile } from './agentTools'

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
  it('applies saved preferred/disallowed tool constraints to the active profile', () => {
    const { service } = makeConfigService()
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

  it('keeps tools on a bare "yes"/"do it" that continues the previous turn', () => {
    const { service } = makeConfigService()
    const req = {
      messages: [
        { role: 'user', content: 'click the login button' },
        { role: 'assistant', content: 'I see it...' },
        { role: 'user', content: 'do it' }
      ]
    } as any
    const profile = service.agentToolProfile(req)
    expect(profile.name).toBe('browser')
  })

  it('upgrades OpenAI browser turns with a workspace into a full workshop surface', () => {
    const { service } = makeConfigService('/home/user/project')
    const req = {
      messages: [{ role: 'user', content: 'check the current docs site and then update the parser code' }]
    } as any

    const profile = service.agentToolProfile(req, 'openai')
    const names = profile.tools.map((tool: { name: string }) => tool.name)

    expect(profile.name).toBe('full')
    expect(names).toEqual(expect.arrayContaining([
      'search',
      'read_page',
      'search_repo',
      'read_spans',
      'read_file',
      'edit_file',
      'run_command',
      'verify_change'
    ]))
  })

  it('gives filesystem turns the full path block and lean turns an escalation hint', () => {
    const { service } = makeConfigService('/home/user/project')
    const fsProfile = { name: 'filesystem' } as any
    const leanProfile = { name: 'conversation' } as any

    expect(service.workspaceSystemBlock(fsProfile)).toBe('Workspace: /home/user/project')
    expect(service.workspaceSystemBlock(leanProfile)).toContain('Use request_tools("filesystem")')
  })

  it('attaches no working-folder block when no folder is selected', () => {
    const { service } = makeConfigService(null)
    expect(service.workspaceSystemBlock()).toBeNull()
  })

  it('explains when a selected folder is ignored for unrelated turns', () => {
    const { service } = makeConfigService('/home/user/project')
    const profile = { name: 'conversation' } as any
    const block = service.workspaceSystemBlock(profile)
    expect(block).toContain('Use request_tools("filesystem")')
  })

  it('adds OpenAI-specific surgical local-work guidance to the turn system prompt', async () => {
    const { service } = makeConfigService('/home/user/project')
    const system = await service.buildTurnAgentSystem(
      { messages: [{ role: 'user', content: 'inspect the repo and fix the UI' }] } as any,
      selectAgentToolProfile('inspect the repo and fix the UI', { hasWorkspaceFolder: true }).tools,
      'openai'
    )

    expect(system).toContain('## Direct API local-work contract')
    expect(system).toContain('prefer repo_overview for orientation, then search_repo or repo_grep_task')
    expect(system).toContain('Use read_spans only as the follow-up bounded read once search has identified the relevant windows')
    expect(system).toContain('Batch related file windows into one read_spans({items:[...]}) call')
    expect(system).toContain('avoid full:true unless the file is small')
    expect(system).toContain('Keep Gladdis browser tools first-class for web search')
  })
})
