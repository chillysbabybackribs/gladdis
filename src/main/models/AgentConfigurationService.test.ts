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
})
