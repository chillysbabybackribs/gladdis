import { describe, expect, it } from 'vitest'
import { buildCursorSystem, CURSOR_SYSTEM } from './prompts'
import { buildCursorBrowserInstructions, CURSOR_BROWSER_INSTRUCTIONS } from './claudeCode/browserTools'

describe('buildCursorSystem', () => {
  it('omits browser MCP instructions on code-only turns', () => {
    const prompt = buildCursorSystem({})
    expect(prompt).not.toContain(buildCursorBrowserInstructions(['search']))
    expect(prompt).toContain('Use Cursor native local repo, file, shell, and validation abilities')
    expect(prompt).toContain('run the narrowest relevant local verification command')
    expect(prompt).toContain('failed post-action verification result')
    expect(prompt).toContain('confirmed complete, stop and deliver the result')
  })

  it('includes browser MCP instructions when the bridge is enabled', () => {
    const prompt = buildCursorSystem({ browserToolNames: ['search', 'set_field', 'act'] })
    expect(prompt).toContain('Attached Gladdis MCP tools this turn: act, search, set_field.')
    expect(prompt).toContain('Prefer the semantic browser verbs when they fit')
    expect(prompt).toContain('`act` is a companion action tool')
    expect(prompt).not.toContain('memory_create_task')
  })

  it('keeps the full default cursor system prompt in sync with the exported constant', () => {
    const prompt = buildCursorSystem({
      browserToolNames: [
        'search',
        'navigate',
        'read_page',
        'wait_for_load',
        'read_a11y',
        'grep_page',
        'diagnose_target',
        'extract_structured',
        'discover_data_sources',
        'watch_network',
        'screenshot',
        'screenshot_app',
        'set_field',
        'submit',
        'open_result',
        'act',
        'grep_click',
        'grep_type',
        'execute_in_browser',
        'cdp_command',
        'recall_history',
        'memory_write',
        'memory_read',
        'memory_list',
        'memory_forget',
        'memory_create_task'
      ]
    })
    expect(prompt).toContain(CURSOR_BROWSER_INSTRUCTIONS)
    expect(prompt).toBe(CURSOR_SYSTEM)
  })
})

describe('CURSOR_BROWSER_INSTRUCTIONS', () => {
  it('allows shell as a background web helper but keeps the visible tab primary', () => {
    // Shell/native web fetching is now a first-class background path...
    expect(CURSOR_BROWSER_INSTRUCTIONS.toLowerCase()).toContain('background')
    // ...but it must never supersede live browser navigation the user is watching.
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('never')
    expect(CURSOR_BROWSER_INSTRUCTIONS.toLowerCase()).toContain('visible tab')
    // The reversed policy must be gone: no more "forbidden native tool" framing.
    expect(CURSOR_BROWSER_INSTRUCTIONS).not.toContain('outside the Gladdis contract')
    expect(CURSOR_BROWSER_INSTRUCTIONS).not.toContain('only web search that exists')
    // Live-tab web tools are still taught as the primary, watched surface.
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('search')
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('navigate_visible')
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
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('stop and deliver the result instead of continuing by default')
    expect(CURSOR_BROWSER_INSTRUCTIONS).toContain('read_a11y')
  })
})
