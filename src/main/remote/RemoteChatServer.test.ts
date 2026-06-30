import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ChatRequest, ChatStreamEvent, Conversation, ConversationMeta } from '../../../shared/types'
import { RemoteChatServer, type RemoteChatBridge } from './RemoteChatServer'

function makeBridge(): {
  bridge: RemoteChatBridge
  conversations: Map<string, Conversation>
  send: Mock<(req: ChatRequest) => Promise<void>>
  emit: (event: ChatStreamEvent) => void
} {
  const conversations = new Map<string, Conversation>()
  const listeners = new Set<(event: ChatStreamEvent) => void>()
  const send = vi.fn(async (_req: ChatRequest) => {})
  const bridge: RemoteChatBridge = {
    send,
    abort: vi.fn(),
    listConversations: () => [...conversations.values()].map(toMeta),
    getConversation: (id) => conversations.get(id) ?? null,
    saveConversation: (conversation) => {
      conversations.set(conversation.id, conversation)
      return conversation
    },
    subscribeChatStream: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    nudgeWorkspace: vi.fn(),
    warmCursorBridge: vi.fn()
  }
  return {
    bridge,
    conversations,
    send,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    }
  }
}

function toMeta(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    title: conversation.title,
    summary: conversation.summary,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    continuesFromId: conversation.continuesFromId,
    panel: conversation.panel
  }
}

describe('RemoteChatServer', () => {
  let server: RemoteChatServer | null = null

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('rejects chat sends without the bearer token', async () => {
    const { bridge } = makeBridge()
    server = new RemoteChatServer(bridge, { token: 'test-token' })
    const info = await server.start()

    const res = await fetch(`http://${info.host}:${info.port}/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' })
    })

    expect(res.status).toBe(401)
  })

  it('persists a remote user turn and streams assistant deltas back into the conversation', async () => {
    const { bridge, conversations, send, emit } = makeBridge()
    server = new RemoteChatServer(bridge, { token: 'test-token' })
    const info = await server.start()

    const res = await fetch(`http://${info.host}:${info.port}/api/chat/send`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text: 'check the build' })
    })
    const body = await res.json() as { requestId: string; conversationId: string; assistantMessageId: string }

    expect(res.status).toBe(202)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      requestId: body.requestId,
      assistantMessageId: body.assistantMessageId,
      conversationId: body.conversationId,
      messages: [{ role: 'user', content: 'check the build' }],
      mode: 'agent',
      tabId: null
    }))
    expect(conversations.get(body.conversationId)?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant'
    ])

    emit({ requestId: body.requestId, assistantMessageId: body.assistantMessageId, type: 'delta', text: 'Looks good.' })
    emit({ requestId: body.requestId, assistantMessageId: body.assistantMessageId, type: 'done' })

    const assistant = conversations.get(body.conversationId)?.messages.find((message) => message.role === 'assistant')
    expect(assistant?.text).toBe('Looks good.')
    expect(assistant?.parts).toEqual([{ kind: 'text', text: 'Looks good.' }])
  })

  it('accepts durable device tokens through the auth hook', async () => {
    const { bridge, send } = makeBridge()
    server = new RemoteChatServer(bridge, {
      token: 'server-token',
      authenticateDevice: (token) => token === 'device-token'
        ? { id: 'phone-1', label: 'Phone', createdAt: Date.now(), lastSeenAt: Date.now() }
        : null
    })
    const info = await server.start()

    const res = await fetch(`http://${info.host}:${info.port}/api/chat/send`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer device-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text: 'from phone' })
    })

    expect(res.status).toBe(202)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: 'from phone' }]
    }))
  })

  it('acks and streams chat events over websocket', async () => {
    const { bridge, emit } = makeBridge()
    server = new RemoteChatServer(bridge, { token: 'test-token' })
    const info = await server.start()
    const ws = new WebSocket(`ws://${info.host}:${info.port}/ws?token=test-token`)
    const seen: Array<Record<string, unknown>> = []

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('error', () => reject(new Error('websocket connection failed')))
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        seen.push(message)
        if (message.type === 'ready') {
          ws.send(JSON.stringify({ type: 'send', text: 'hello from socket' }))
          return
        }
        if (message.type === 'ack') {
          emit({
            requestId: String(message.requestId),
            assistantMessageId: String(message.assistantMessageId),
            type: 'delta',
            text: 'Socket reply'
          })
          emit({
            requestId: String(message.requestId),
            assistantMessageId: String(message.assistantMessageId),
            type: 'done'
          })
          return
        }
        if (message.type === 'chat' && (message.event as { type?: string }).type === 'done') {
          resolve()
        }
      })
    })

    expect(seen.some((message) => message.type === 'ready')).toBe(true)
    expect(seen.some((message) => message.type === 'ack')).toBe(true)
    expect(
      seen.some((message) => message.type === 'chat' && (message.event as { text?: string }).text === 'Socket reply')
    ).toBe(true)
    ws.close()
  })
})
