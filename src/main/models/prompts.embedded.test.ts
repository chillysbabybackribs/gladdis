import { describe, expect, it } from 'vitest'
import { buildAgentSystem, buildClaudeCodeSystem, buildCodexSystem } from './prompts'
import { knownToolByName } from './agentTools'

describe('embedded prompt tool routing', () => {
  it('does not advertise act on direct-provider turns when act is not attached', async () => {
    const prompt = await buildAgentSystem([
      knownToolByName('search')!,
      knownToolByName('navigate')!,
      knownToolByName('grep_page')!,
      knownToolByName('read_a11y')!,
      knownToolByName('set_field')!
    ])

    expect(prompt).toContain('Attached browser capabilities by category: web discovery (find live web sources or open known URLs): search, navigate | page orientation (understand the visible page before acting): read_a11y | precise targeting (pinpoint the exact control or text to use): grep_page | semantic actions (fill, submit, and open results at the intent level): set_field.')
    expect(prompt).toContain('These attached tools are a routed subset from a broader categorized browser-tool registry; choose tools by capability/domain fit, not just by name similarity.')
    expect(prompt).toContain('`set_field`')
    expect(prompt).not.toContain('`act`')
    expect(prompt).not.toContain('before dropping to `act`')
    expect(prompt).not.toContain('`act` is a companion action tool')
    expect(prompt).not.toContain('READ the act result before the next move')
  })

  it('builds a Claude Code prompt that only names the routed MCP subset', () => {
    const prompt = buildClaudeCodeSystem({ browserToolNames: ['search', 'memory_read'] })

    expect(prompt).toContain('Attached Gladdis MCP tools this turn: memory_read, search.')
    expect(prompt).toContain('Attached browser capabilities by category: memory notebook (recover context and keep task state): memory_read | web discovery (find live web sources or open known URLs): search.')
    expect(prompt).toContain('These attached tools are a routed subset from a broader categorized browser-tool registry; choose tools by capability/domain fit, not just by name similarity.')
    expect(prompt).toContain('Use `search` for live web lookup')
    expect(prompt).toContain('memory_read')
    expect(prompt).not.toContain('`act` is the primary action verb')
    expect(prompt).not.toContain('memory_create_task')
  })

  it('builds a Codex prompt that only names the routed Gladdis subset', () => {
    const prompt = buildCodexSystem({ gladdisToolNames: ['search', 'grep_page'] })

    expect(prompt).toContain('Attached Gladdis tools this turn: grep_page, search.')
    expect(prompt).toContain('Attached browser capabilities by category: web discovery (find live web sources or open known URLs): search | precise targeting (pinpoint the exact control or text to use): grep_page.')
    expect(prompt).toContain('These attached tools are a routed subset from a broader categorized browser-tool registry; choose tools by capability/domain fit, not just by name similarity.')
    expect(prompt).toContain('Use `search` for live web lookup')
    expect(prompt).toContain('`grep_page` is SURGICAL, not exploratory')
    expect(prompt).toContain('stop and deliver the result')
    expect(prompt).not.toContain('memory_create_task')
    expect(prompt).not.toContain('`act` is the primary action verb')
  })

  it('teaches extract_structured when that tool is attached', () => {
    const prompt = buildCodexSystem({ gladdisToolNames: ['extract_structured'] })

    expect(prompt).toContain('Attached Gladdis tools this turn: extract_structured.')
    expect(prompt).toContain('`extract_structured` is for repeated DOM records')
  })

  it('teaches discover_data_sources when that tool is attached', () => {
    const prompt = buildCodexSystem({ gladdisToolNames: ['discover_data_sources'] })

    expect(prompt).toContain('Attached Gladdis tools this turn: discover_data_sources.')
    expect(prompt).toContain('`discover_data_sources` is the early network-intelligence pass')
  })
})
