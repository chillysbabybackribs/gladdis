import { describe, expect, it } from 'vitest'
import { buildClaudeCodeSystem, buildCodexSystem } from './prompts'

describe('embedded prompt tool routing', () => {
  it('builds a Claude Code prompt that only names the routed MCP subset', () => {
    const prompt = buildClaudeCodeSystem({ browserToolNames: ['search', 'memory_read'] })

    expect(prompt).toContain('Attached Gladdis MCP tools this turn: memory_read, search.')
    expect(prompt).toContain('Use `search` for live web lookup')
    expect(prompt).toContain('memory_read')
    expect(prompt).not.toContain('`act` is the primary action verb')
    expect(prompt).not.toContain('memory_create_task')
  })

  it('builds a Codex prompt that only names the routed Gladdis subset', () => {
    const prompt = buildCodexSystem({ gladdisToolNames: ['search', 'grep_page'] })

    expect(prompt).toContain('Attached Gladdis tools this turn: grep_page, search.')
    expect(prompt).toContain('Use `search` for live web lookup')
    expect(prompt).toContain('`grep_page` is SURGICAL, not exploratory')
    expect(prompt).not.toContain('memory_create_task')
    expect(prompt).not.toContain('`act` is the primary action verb')
  })
})
