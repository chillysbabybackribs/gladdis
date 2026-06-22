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

describe('ChatStore panel isolation', () => {
  function freshStore(): ChatStore {
    const store = new ChatStore()
    ;(store as any).convos = new Map()
    return store
  }

  function seed(store: ChatStore) {
    store.save({
      id: 'left-old',
      title: '',
      createdAt: 1,
      updatedAt: 10,
      panel: 'left',
      messages: [{ role: 'user', text: 'left side first chat' }]
    } as any)
    store.save({
      id: 'right-newest',
      title: '',
      createdAt: 2,
      updatedAt: 1000,
      panel: 'right',
      messages: [{ role: 'user', text: 'right side most recent' }]
    } as any)
    store.save({
      id: 'left-recent',
      title: '',
      createdAt: 3,
      updatedAt: 100,
      panel: 'left',
      messages: [{ role: 'user', text: 'left side recent chat' }]
    } as any)
  }

  it('lastActive(panel) restores per-side, never the globally newest chat', () => {
    const store = freshStore()
    seed(store)
    // The globally newest is right-newest at updatedAt=1000, but the left
    // panel must restore its own newest (left-recent) instead.
    expect(store.lastActive()).toBe('right-newest')
    expect(store.lastActive('left')).toBe('left-recent')
    expect(store.lastActive('right')).toBe('right-newest')
  })

  it('list(panel) only returns that panel\'s chats', () => {
    const store = freshStore()
    seed(store)
    const leftIds = store.list('left').map((c) => c.id)
    const rightIds = store.list('right').map((c) => c.id)
    expect(leftIds).toEqual(['left-recent', 'left-old'])
    expect(rightIds).toEqual(['right-newest'])
  })

  it('panel ownership is sticky — a subsequent save cannot flip the side', () => {
    const store = freshStore()
    store.save({
      id: 'conv-stuck',
      title: '',
      createdAt: 1,
      updatedAt: 10,
      panel: 'right',
      messages: [{ role: 'user', text: 'created on the right' }]
    } as any)
    // Even if a (buggy) caller resaves with panel='left', ownership must hold.
    const resaved = store.save({
      id: 'conv-stuck',
      title: '',
      createdAt: 1,
      updatedAt: 20,
      panel: 'left',
      messages: [
        { role: 'user', text: 'created on the right' },
        { role: 'assistant', text: 'still on the right' }
      ]
    } as any)
    expect(resaved.panel).toBe('right')
    expect(store.get('conv-stuck')?.panel).toBe('right')
  })

  it('search(query, limit, panel) filters hits to the panel', () => {
    const store = freshStore()
    seed(store)
    const leftHits = store.search('side', 10, 'left')
    const rightHits = store.search('side', 10, 'right')
    expect(leftHits.map((h) => h.conversationId).sort()).toEqual(['left-old', 'left-recent'])
    expect(rightHits.map((h) => h.conversationId)).toEqual(['right-newest'])
    expect(leftHits.every((h) => h.panel === 'left')).toBe(true)
    expect(rightHits.every((h) => h.panel === 'right')).toBe(true)
  })

  it('previousConversation never crosses panels even though signature is unchanged', () => {
    const store = freshStore()
    seed(store)
    // previousConversation(currentId) should restrict to the current chat's
    // panel so the recall_history fallback can't pull a right chat into a
    // left turn (or vice versa).
    expect(store.previousConversation('left-recent')?.id).toBe('left-old')
    expect(store.previousConversation('right-newest')).toBeNull()
  })

  it('defaults legacy convs (no panel field) to left so existing history stays visible', () => {
    const store = freshStore()
    // Mimic a legacy on-disk conv that was saved before the panel field
    // existed. `save()` should treat it as left-owned forever.
    const saved = store.save({
      id: 'legacy',
      title: '',
      createdAt: 1,
      updatedAt: 10,
      messages: [{ role: 'user', text: 'legacy chat' }]
    } as any)
    expect(saved.panel).toBe('left')
    expect(store.list('left').map((c) => c.id)).toContain('legacy')
    expect(store.list('right').map((c) => c.id)).not.toContain('legacy')
  })
})
