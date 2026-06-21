import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' }
}))

import { ChatStore } from './ChatStore'

describe('ChatStore search', () => {
  it('returns ranked saved-chat hits with excerpts', () => {
    const store = new ChatStore()
    ;(store as any).convos = new Map()

    store.save({
      id: 'conv-1',
      title: 'Browser ownership follow-up',
      createdAt: 1,
      updatedAt: 10,
      messages: [
        { role: 'user', text: 'We fixed browser ownership in the main process.' },
        { role: 'assistant', text: 'That removed the race.' }
      ]
    } as any)
    store.save({
      id: 'conv-2',
      title: 'Renderer polish',
      createdAt: 2,
      updatedAt: 20,
      messages: [
        { role: 'user', text: 'Adjust the spacing in the history modal.' }
      ]
    } as any)

    const hits = store.search('browser ownership', 5)

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      conversationId: 'conv-1',
      title: 'We fixed browser ownership in the main process.',
      role: 'user',
      summary: expect.stringContaining('User: We fixed browser ownership')
    })
    expect(hits[0].excerpt).toContain('browser ownership')
  })

  it('preserves provider thread ids for reopening the same saved chat', () => {
    const store = new ChatStore()
    ;(store as any).convos = new Map()

    const saved = store.save({
      id: 'conv-1',
      title: 'Codex thread binding',
      createdAt: 1,
      updatedAt: 10,
      codexThreadId: 'thread-codex-123',
      messages: [
        { role: 'user', text: 'Keep this as local Gladdis history.' }
      ]
    } as any)

    expect(saved.codexThreadId).toBe('thread-codex-123')
    expect(store.get('conv-1')?.codexThreadId).toBe('thread-codex-123')

    const updated = store.save({
      id: 'conv-1',
      title: 'Codex thread binding',
      createdAt: 1,
      updatedAt: 11,
      messages: [
        { role: 'user', text: 'Keep this as local Gladdis history.' },
        { role: 'assistant', text: 'Done.' }
      ]
    } as any)

    expect(updated.codexThreadId).toBe('thread-codex-123')
  })
})
