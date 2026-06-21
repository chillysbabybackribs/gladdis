import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_BROWSER_TOOLS,
  respondToCodexBrowserToolCall
} from './dynamicBrowserTools'

describe('Codex Gladdis dynamic tools', () => {
  it('exposes recall_history to Codex', () => {
    expect(CODEX_BROWSER_TOOLS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: 'gladdis',
          name: 'recall_history',
          description: expect.stringContaining('bare resume request')
        })
      ])
    )
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
})
