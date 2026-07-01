import { describe, expect, it, vi } from 'vitest'
import {
  buildCodexBrowserTools,
  CODEX_BROWSER_INSTRUCTIONS,
  CODEX_BROWSER_TOOLS,
  selectCodexDynamicToolNames,
  respondToCodexBrowserToolCall
} from './dynamicBrowserTools'

describe('Codex Gladdis dynamic tools', () => {
  it('exposes recall_history and the browser action tools to Codex', () => {
    expect(CODEX_BROWSER_TOOLS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: 'gladdis',
          name: 'recall_history',
          description: expect.stringContaining('bare resume request')
        }),
        expect.objectContaining({
          namespace: 'gladdis',
          name: 'watch_network',
          description: expect.stringContaining('Read the structured data a page is built from')
        }),
        expect.objectContaining({ namespace: 'gladdis', name: 'search' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'navigate' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'read_a11y' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'grep_page' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'set_field' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'submit' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'open_result' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'grep_click' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'grep_type' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'execute_in_browser' }),
        expect.objectContaining({ namespace: 'gladdis', name: 'cdp_command' })
      ])
    )
  })

  it('does not expose the tools removed from the Codex surface', () => {
    const exposedNames = new Set(
      (CODEX_BROWSER_TOOLS as Array<{ name: string }>).map((tool) => tool.name)
    )
    const removed = [
      'repo_overview',
      'search_repo',
      'repo_grep_task',
      'read_spans',
      'research_dossier',
      'verify_change',
      'search_open',
      'deep_search',
      'fetch_page',
      'click_xy',
      'type_text',
      'press_key'
    ]
    for (const name of removed) {
      expect(exposedNames.has(name)).toBe(false)
    }
  })

  it('does not tell Codex to call removed Gladdis repo tools', () => {
    for (const removed of [
      'repo_overview',
      'search_repo',
      'repo_grep_task',
      'read_spans',
      'research_dossier',
      'verify_change'
    ]) {
      expect(CODEX_BROWSER_INSTRUCTIONS).not.toContain(removed)
    }
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('native shell and file tools')
    expect(CODEX_BROWSER_INSTRUCTIONS).toContain('memory_* notebook tools')
  })

  it('builds a per-turn Codex dynamic surface from the routed tool names', () => {
    const allowed = selectCodexDynamicToolNames(['grep_page', 'set_field', 'act', 'memory_read', 'run_command'])
    expect([...allowed].sort()).toEqual(['act', 'grep_page', 'memory_read', 'set_field'])

    const tools = buildCodexBrowserTools(allowed) as Array<{ name: string }>
    expect(tools.map((tool) => tool.name).sort()).toEqual(['act', 'grep_page', 'memory_read', 'set_field'])
  })

  it('runs recall_history with the current Gladdis conversation id', async () => {
    const run = vi.fn(async () => ({ ok: true, text: 'history found' }))
    const respond = vi.fn()

    await respondToCodexBrowserToolCall({
      msg: {
        method: 'item/tool/call',
        id: 'rpc-1',
        params: {
          namespace: 'gladdis',
          tool: 'recall_history',
          itemId: 'tool-1',
          arguments: {}
        }
      } as any,
      respond,
      tools: {
        tabs: { activeTabId: 'tab-1', create: () => ({ id: 'tab-created' }) },
        run
      } as any,
      conversationId: 'conv-child',
      emit: vi.fn()
    })

    expect(run).toHaveBeenCalledWith(
      'recall_history',
      {},
      expect.objectContaining({
        tabId: 'tab-1',
        conversationId: 'conv-child'
      })
    )
    expect(respond).toHaveBeenCalledWith(
      'rpc-1',
      expect.objectContaining({ success: true })
    )
  })

  it('rejects Gladdis dynamic tools that were not attached for this turn', async () => {
    const respond = vi.fn()

    await respondToCodexBrowserToolCall({
      msg: {
        method: 'item/tool/call',
        id: 'rpc-2',
        params: {
          namespace: 'gladdis',
          tool: 'read_a11y',
          itemId: 'tool-2',
          arguments: {}
        }
      } as any,
      respond,
      tools: {
        tabs: { activeTabId: 'tab-1', create: () => ({ id: 'tab-created' }) },
        run: vi.fn()
      } as any,
      allowedToolNames: new Set(['grep_page']),
      emit: vi.fn()
    })

    expect(respond).toHaveBeenCalledWith(
      'rpc-2',
      expect.objectContaining({ success: false })
    )
  })
})
