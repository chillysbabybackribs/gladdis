import { describe, expect, it } from 'vitest'
import { buildCursorSystem, CURSOR_SYSTEM } from './prompts'
import { CURSOR_BROWSER_INSTRUCTIONS } from './claudeCode/browserTools'

describe('buildCursorSystem', () => {
  it('omits browser MCP instructions on code-only turns', () => {
    const prompt = buildCursorSystem({ enableBrowserTools: false })
    expect(prompt).not.toContain(CURSOR_BROWSER_INSTRUCTIONS)
    expect(prompt).toContain('Use Cursor native local repo, file, shell, and validation abilities')
    expect(prompt).toContain('run the narrowest relevant local verification command')
    expect(prompt).toContain('failed post-action verification result')
  })

  it('includes browser MCP instructions when the bridge is enabled', () => {
    const prompt = buildCursorSystem({ enableBrowserTools: true })
    expect(prompt).toContain(CURSOR_BROWSER_INSTRUCTIONS)
    expect(prompt).toBe(CURSOR_SYSTEM)
  })
})

describe('CURSOR_BROWSER_INSTRUCTIONS', () => {
  it('forbids native web search/fetch tools even if Cursor exposes them', () => {
    for (const nativeTool of [
      'WebSearch',
      'WebFetch',
      'web_search',
      'web_fetch',
      'browser_search',
      'browser_fetch'
    ]) {
      expect(CURSOR_BROWSER_INSTRUCTIONS).toContain(nativeTool)
    }
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('outside the Gladdis contract')
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('call search instead')
  })

  // Cursor's MCP bridge registers the memory_* tools, so the prompt must teach
  // them — otherwise those registered tools are unprompted dead weight the
  // model never learns to call.
  it('documents the memory_* notebook tools and workflow', () => {
    for (const tool of [
      'memory_write',
      'memory_read',
      'memory_list',
      'memory_forget',
      'memory_create_task'
    ]) {
      expect(CURSOR_BROWSER_INSTRUCTIONS).toContain(tool)
    }
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('lightweight notebook')
  })

  it('only advertises the reduced Cursor MCP surface and native validation expectations', () => {
    for (const unavailableTool of [
      'repo_overview',
      'repo_grep_task',
      'search_repo',
      'read_spans',
      'research_dossier',
      'verify_change'
    ]) {
      expect(CURSOR_BROWSER_INSTRUCTIONS).not.toContain(unavailableTool)
    }
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('validation abilities')
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('run the narrowest relevant local verification command')
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('failed post-action verification result')
  })
})
