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
})
