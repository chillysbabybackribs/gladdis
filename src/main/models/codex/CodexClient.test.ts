import { describe, expect, it, vi } from 'vitest'
import { CodexClient } from './CodexClient'
import { buildCodexBrowserTools, CODEX_BROWSER_TOOLS } from './dynamicBrowserTools'

function makeClient(savedThreadId: string | null = null) {
  const requests: Array<{ method: string; params: any }> = []
  const persisted = new Map<string, string | null>()
  if (savedThreadId) persisted.set('conv-1', savedThreadId)

  const server = {
    running: true,
    request: vi.fn(async (method: string, params: any) => {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-new' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      return {}
    })
  }

  const client = new CodexClient(
    vi.fn(),
    () => ({ folder: '/tmp/gladdis-workspace' }),
    {} as any,
    {
      get: (conversationId) => persisted.get(conversationId) ?? null,
      set: (conversationId, threadId) => persisted.set(conversationId, threadId)
    }
  )
  ;(client as any).server = server

  return { client, requests, persisted }
}

describe('CodexClient thread lifecycle', () => {
  it('starts and stores a provider thread for a new saved chat', async () => {
    const { client, requests, persisted } = makeClient()

    const result = await (client as any).threadStore.ensureThread({
      conversationId: 'conv-1',
      modelId: 'gpt-5.5'
    })

    expect(result.threadId).toBe('thread-new')
    expect(requests[0]).toMatchObject({ method: 'thread/start' })
    expect(persisted.get('conv-1')).toBe('thread-new')
  })

  it('resumes the provider thread for the same saved chat after restart', async () => {
    const { client, requests, persisted } = makeClient('thread-saved')

    const result = await (client as any).threadStore.ensureThread({
      conversationId: 'conv-1',
      modelId: 'gpt-5.5'
    })

    expect(result.threadId).toBe('thread-saved')
    expect(requests[0]).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-saved',
        dynamicTools: CODEX_BROWSER_TOOLS
      }
    })
    expect(persisted.get('conv-1')).toBe('thread-saved')
  })

  it('registers only the routed Codex dynamic tools for the turn', async () => {
    const { client, requests } = makeClient()
    const dynamicToolNames = new Set(['grep_page', 'act'])

    await (client as any).threadStore.ensureThread(
      {
        conversationId: 'conv-1',
        modelId: 'gpt-5.5'
      },
      undefined,
      true,
      dynamicToolNames
    )

    expect(requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        dynamicTools: buildCodexBrowserTools(dynamicToolNames)
      }
    })
  })
})
