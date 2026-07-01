import { describe, expect, it } from 'vitest'
import { buildAgentSystem, buildClaudeCodeSystem, buildCodexSystem } from './prompts'
import { knownToolByName } from './agentTools'

describe('embedded prompt tool routing', () => {
  it('does not teach any search_tool discovery flow (the tool is retired)', async () => {
    // The full flat surface is offered every turn (Phase C), so there is no
    // routed-away subset and no tool-discovery hatch to teach.
    expect(knownToolByName('search_tool')).toBeUndefined()

    const prompt = await buildAgentSystem([
      knownToolByName('search_files')!,
      knownToolByName('read_file')!
    ])

    expect(prompt).not.toContain('search_tool')
    expect(prompt).not.toContain('get stuck on tool selection')
    expect(prompt).toContain('You receive the full tool surface every turn')
  })

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
    expect(prompt).toContain('Attached Gladdis MCP tools this turn: memory_read, search.')
    expect(prompt).toContain('Use `search` for live web lookup')
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

  it('teaches the browser task template for medium-to-complex browser workflows', () => {
    const prompt = buildCodexSystem({ gladdisToolNames: ['search', 'navigate', 'grep_page', 'memory_create_task', 'memory_write'] })

    expect(prompt).toContain('Browser-task template rule:')
    expect(prompt).toContain('`Task:` block containing `Goal:`, `Visible starting page:`, `Success object:`, and `Risky steps:`')
    expect(prompt).toContain('Browser working-log rule:')
    expect(prompt).toContain('`Current step:`, `Last verified checkpoint:`, and `Next action:`')
  })

  it('teaches tab grounding across all three assembly paths when a browser tool is attached', async () => {
    const agentPrompt = await buildAgentSystem([
      knownToolByName('navigate')!,
      knownToolByName('grep_page')!
    ])
    const codexPrompt = buildCodexSystem({ gladdisToolNames: ['navigate', 'grep_page'] })
    const claudePrompt = buildClaudeCodeSystem({ browserToolNames: ['navigate', 'grep_page'] })

    for (const prompt of [agentPrompt, codexPrompt, claudePrompt]) {
      expect(prompt).toContain('TAB GROUNDING')
      expect(prompt).toContain('[tab N/M]')
      expect(prompt).toContain('slowLoad')
      expect(prompt).toContain('LOADING LONGER THAN NORMAL')
    }
  })

  it('does not teach tab grounding when only non-browser tools are attached', async () => {
    const agentPrompt = await buildAgentSystem([
      knownToolByName('search_files')!,
      knownToolByName('read_file')!
    ])
    const claudePrompt = buildClaudeCodeSystem({ browserToolNames: ['memory_read'] })

    expect(agentPrompt).not.toContain('TAB GROUNDING')
    expect(claudePrompt).not.toContain('TAB GROUNDING')
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
