import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneSessionStateStore, deviceSessionKey } from './PhoneSessionStateStore'

const userData = join(tmpdir(), 'gladdis-phone-session-store-vitest')

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

describe('PhoneSessionStateStore', () => {
  beforeEach(async () => {
    await rm(userData, { recursive: true, force: true })
    await mkdir(userData, { recursive: true })
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  it('persists conversation and pending turns across reloads', async () => {
    const sessionKey = deviceSessionKey('phone-1')
    const first = new PhoneSessionStateStore()
    first.setConversation(sessionKey, 'remote-conv-1')
    first.upsertPending(sessionKey, {
      clientMessageId: 'msg-1',
      text: 'hello',
      conversationId: 'remote-conv-1',
      requestId: 'req-1',
      assistantMessageId: 'asst-1',
      createdAt: 1,
      updatedAt: 2
    })
    await first.flush()

    const second = new PhoneSessionStateStore()
    expect(second.get(sessionKey)).toEqual({
      conversationId: 'remote-conv-1',
      pending: [{
        clientMessageId: 'msg-1',
        text: 'hello',
        conversationId: 'remote-conv-1',
        requestId: 'req-1',
        assistantMessageId: 'asst-1',
        createdAt: 1,
        updatedAt: 2
      }]
    })
  })

  it('drops pending turns while preserving the active conversation', async () => {
    const sessionKey = deviceSessionKey('phone-2')
    const store = new PhoneSessionStateStore()
    store.setConversation(sessionKey, 'remote-conv-2')
    store.upsertPending(sessionKey, {
      clientMessageId: 'msg-2',
      text: 'ship it',
      conversationId: 'remote-conv-2',
      requestId: 'req-2',
      assistantMessageId: 'asst-2',
      createdAt: 10,
      updatedAt: 10
    })
    store.clearPendingByRequestId(sessionKey, 'req-2')
    await store.flush()

    expect(store.get(sessionKey)).toEqual({
      conversationId: 'remote-conv-2',
      pending: []
    })

    const raw = await readFile(join(userData, 'gladdis-phone-sessions.json'), 'utf8')
    expect(raw).toContain('remote-conv-2')
    expect(raw).not.toContain('msg-2')
  })
})
