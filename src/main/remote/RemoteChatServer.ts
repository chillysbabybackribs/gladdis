import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type {
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationMeta,
  ModelOption,
  PhoneBridgeDevice,
  StoredMessage
} from '../../../shared/types'
import { MODELS } from '../../../shared/types'

export interface RemoteChatServerOptions {
  host?: string
  port?: number
  token?: string
  corsOrigin?: string
  authenticateDevice?: (token: string) => PhoneBridgeDevice | null
}

export interface RemoteChatBridge {
  send(req: ChatRequest): Promise<void>
  abort(requestId: string): void
  listConversations(): ConversationMeta[]
  getConversation(id: string): Conversation | null
  saveConversation(conversation: Conversation): Conversation
  subscribeChatStream(listener: (event: ChatStreamEvent) => void): () => void
  nudgeWorkspace(): void
  warmCursorBridge(): void
}

export interface RemoteChatServerInfo {
  host: string
  port: number
  token: string
  appUrl: string
}

interface ActiveRemoteTurn {
  conversationId: string
  assistantMessageId: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const JSON_LIMIT_BYTES = 64 * 1024

export class RemoteChatServer {
  private server = createServer((req, res) => void this.handle(req, res))
  private clients = new Set<ServerResponse>()
  private activeTurns = new Map<string, ActiveRemoteTurn>()
  private ready: Promise<RemoteChatServerInfo> | null = null
  private info: RemoteChatServerInfo | null = null
  private readonly token: string
  private readonly unsubscribeChatStream: () => void

  constructor(
    private readonly bridge: RemoteChatBridge,
    private readonly options: RemoteChatServerOptions = {}
  ) {
    this.token = options.token?.trim() || randomUUID()
    this.unsubscribeChatStream = this.bridge.subscribeChatStream((event) => this.onChatStream(event))
  }

  async start(): Promise<RemoteChatServerInfo> {
    if (this.ready) return this.ready
    const host = this.options.host?.trim() || DEFAULT_HOST
    const port = this.options.port ?? DEFAULT_PORT
    this.ready = new Promise<RemoteChatServerInfo>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Remote chat server failed to bind a TCP port'))
          return
        }
        const appHost = advertisedHost(host)
        this.info = {
          host,
          port: address.port,
          token: this.token,
          appUrl: `http://${appHost}:${address.port}/app?token=${encodeURIComponent(this.token)}`
        }
        resolve(this.info)
      })
    })
    return this.ready
  }

  getInfo(): RemoteChatServerInfo | null {
    return this.info
  }

  appUrlForToken(token: string): string | null {
    if (!this.info) return null
    const appHost = advertisedHost(this.info.host)
    return `http://${appHost}:${this.info.port}/app?token=${encodeURIComponent(token)}`
  }

  async close(): Promise<void> {
    this.unsubscribeChatStream()
    for (const client of this.clients) client.end()
    this.clients.clear()
    this.activeTurns.clear()
    if (!this.info) return
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.info = null
    this.ready = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.applyCors(req, res)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const path = requestPath(req)
      if (req.method === 'GET' && path === '/health') {
        this.json(res, 200, { ok: true, appUrl: this.info?.appUrl ?? null })
        return
      }
      if (req.method === 'GET' && path === '/app') {
        this.html(res, remoteAppHtml(this.token))
        return
      }
      if (req.method === 'GET' && path === '/manifest.webmanifest') {
        this.json(res, 200, manifest(), 'application/manifest+json')
        return
      }
      if (req.method === 'GET' && path === '/sw.js') {
        this.text(res, 200, serviceWorker(), 'application/javascript; charset=utf-8')
        return
      }

      if (!this.authorized(req)) {
        this.json(res, 401, { error: 'Unauthorized' })
        return
      }

      if (req.method === 'GET' && path === '/api/models') {
        this.json(res, 200, { models: MODELS })
        return
      }
      if (req.method === 'GET' && path === '/api/chats') {
        this.json(res, 200, { conversations: this.bridge.listConversations() })
        return
      }
      if (req.method === 'GET' && path.startsWith('/api/chats/')) {
        const id = decodeURIComponent(path.slice('/api/chats/'.length))
        const conversation = this.bridge.getConversation(id)
        this.json(res, conversation ? 200 : 404, conversation ? { conversation } : { error: 'Not found' })
        return
      }
      if (req.method === 'GET' && path === '/events') {
        this.openEventStream(res)
        return
      }
      if (req.method === 'POST' && path === '/api/chat/send') {
        const body = await readJson(req)
        const result = await this.send(body)
        this.json(res, 202, result)
        return
      }
      if (req.method === 'POST' && path === '/api/chat/abort') {
        const body = await readJson(req)
        const requestId = abortRequestId(body)
        if (!requestId) {
          this.json(res, 400, { error: 'requestId is required' })
          return
        }
        this.bridge.abort(requestId)
        this.json(res, 200, { ok: true })
        return
      }

      this.json(res, 404, { error: 'Not found' })
    } catch (error) {
      this.json(res, 500, { error: errorMessage(error) })
    }
  }

  private async send(body: unknown): Promise<{ requestId: string; conversationId: string; assistantMessageId: string }> {
    if (!body || typeof body !== 'object') throw new Error('JSON body is required')
    const input = body as Record<string, unknown>
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) throw new Error('text is required')

    const modelId = resolveModelId(input.modelId)
    const conversationId = typeof input.conversationId === 'string' && input.conversationId.trim()
      ? input.conversationId.trim()
      : `remote-conv-${randomUUID()}`
    const requestId = `remote-req-${randomUUID()}`
    const assistantMessageId = `remote-asst-${randomUUID()}`
    const now = Date.now()
    const existing = this.bridge.getConversation(conversationId)
    const messages: StoredMessage[] = existing?.messages ? [...existing.messages] : []
    messages.push({ id: `remote-user-${randomUUID()}`, role: 'user', text })
    messages.push({ id: assistantMessageId, role: 'assistant', text: '', parts: [] })
    this.bridge.saveConversation({
      id: conversationId,
      title: existing?.title ?? '',
      titleLocked: existing?.titleLocked,
      codexThreadId: existing?.codexThreadId,
      claudeCodeSessionId: existing?.claudeCodeSessionId,
      cursorSessionId: existing?.cursorSessionId,
      continuesFromId: existing?.continuesFromId ?? null,
      panel: existing?.panel ?? 'left',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages
    })

    this.activeTurns.set(requestId, { conversationId, assistantMessageId })
    this.bridge.nudgeWorkspace()
    const model = MODELS.find((candidate) => candidate.id === modelId)
    if (model?.provider === 'cursor') this.bridge.warmCursorBridge()
    void this.bridge.send({
      requestId,
      assistantMessageId,
      modelId,
      messages: messages
        .filter((message) => message.role === 'user' || message.text.trim())
        .map((message) => ({ role: message.role, content: message.text })),
      mode: 'agent',
      conversationId,
      tabId: null
    })
    return { requestId, conversationId, assistantMessageId }
  }

  private onChatStream(event: ChatStreamEvent): void {
    this.broadcast(event)
    const turn = this.activeTurns.get(event.requestId)
    if (!turn) return
    const conversation = this.bridge.getConversation(turn.conversationId)
    if (!conversation) return
    const nextMessages = conversation.messages.map((message) => {
      if (message.id !== turn.assistantMessageId) return message
      if (event.type === 'delta') {
        const text = message.text + event.text
        return { ...message, text, parts: appendTextPart(message.parts, event.text) }
      }
      if (event.type === 'error') {
        const text = message.text || event.message
        return { ...message, text, parts: appendTextPart(message.parts, message.text ? `\n\n${event.message}` : event.message) }
      }
      return message
    })
    this.bridge.saveConversation({ ...conversation, updatedAt: Date.now(), messages: nextMessages })
    if (event.type === 'done' || event.type === 'error') this.activeTurns.delete(event.requestId)
  }

  private openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  private broadcast(event: ChatStreamEvent): void {
    const payload = `event: chat\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) client.write(payload)
  }

  private authorized(req: IncomingMessage): boolean {
    const supplied = bearerToken(req) ?? queryToken(req)
    if (!supplied) return false
    if (this.options.authenticateDevice?.(supplied)) return true
    return safeEqual(supplied, this.token)
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const allowed = this.options.corsOrigin?.trim()
    if (!allowed) return
    const origin = req.headers.origin
    if (allowed !== '*' && origin !== allowed) return
    res.setHeader('Access-Control-Allow-Origin', allowed === '*' ? '*' : origin ?? allowed)
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  private json(res: ServerResponse, status: number, value: unknown, type = 'application/json; charset=utf-8'): void {
    this.text(res, status, JSON.stringify(value), type)
  }

  private html(res: ServerResponse, body: string): void {
    this.text(res, 200, body, 'text/html; charset=utf-8')
  }

  private text(res: ServerResponse, status: number, body: string, type: string): void {
    res.writeHead(status, { 'Content-Type': type })
    res.end(body)
  }
}

function resolveModelId(value: unknown): string {
  if (typeof value === 'string' && MODELS.some((model) => model.id === value)) return value
  return firstVerifiedModel(MODELS).id
}

function abortRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const requestId = (value as { requestId?: unknown }).requestId
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim() : null
}

function firstVerifiedModel(models: ModelOption[]): ModelOption {
  return models.find((model) => model.availability === 'verified') ?? models[0]
}

function appendTextPart(parts: StoredMessage['parts'], text: string): StoredMessage['parts'] {
  if (!text) return parts
  const next = [...(parts ?? [])]
  const last = next[next.length - 1]
  if (last?.kind === 'text') next[next.length - 1] = { kind: 'text', text: last.text + text }
  else next.push({ kind: 'text', text })
  return next
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
}

function queryToken(req: IncomingMessage): string | null {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim()
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function advertisedHost(bindHost: string): string {
  if (bindHost !== '0.0.0.0' && bindHost !== '::') return bindHost
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return 'localhost'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += next.length
    if (size > JSON_LIMIT_BYTES) throw new Error('JSON body is too large')
    chunks.push(next)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function manifest(): object {
  return {
    name: 'Gladdis Remote Chat',
    short_name: 'Gladdis',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0d10',
    theme_color: '#0b0d10',
    icons: []
  }
}

function serviceWorker(): string {
  return `
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('gladdis-remote-v1').then((cache) => cache.addAll(['/app', '/manifest.webmanifest'])))
})
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)))
})
`.trim()
}

function remoteAppHtml(token: string): string {
  const tokenJson = JSON.stringify(token)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0d10">
  <link rel="manifest" href="/manifest.webmanifest">
  <title>Gladdis Remote Chat</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d10; color: #f4f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    header { padding: 16px; border-bottom: 1px solid #222832; }
    h1 { margin: 0; font-size: 17px; letter-spacing: 0; }
    #status { margin-top: 6px; color: #9aa7b7; font-size: 13px; }
    main { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 86%; padding: 10px 12px; border: 1px solid #293241; border-radius: 8px; white-space: pre-wrap; line-height: 1.4; }
    .user { align-self: flex-end; background: #1f3b31; }
    .assistant { align-self: flex-start; background: #141922; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 12px; border-top: 1px solid #222832; background: #0f1217; }
    textarea { min-height: 48px; max-height: 140px; resize: vertical; border-radius: 8px; border: 1px solid #303846; background: #11161d; color: inherit; padding: 10px; font: inherit; }
    button { border: 0; border-radius: 8px; background: #d7f7c2; color: #071006; padding: 0 16px; font: inherit; font-weight: 700; }
  </style>
</head>
<body>
  <header>
    <h1>Gladdis Remote Chat</h1>
    <div id="status">Connecting...</div>
  </header>
  <main id="messages"></main>
  <form id="form">
    <textarea id="input" placeholder="Message Gladdis" autocomplete="off"></textarea>
    <button type="submit">Send</button>
  </form>
  <script>
    const token = new URLSearchParams(location.search).get('token') || ${tokenJson}
    const messages = document.querySelector('#messages')
    const status = document.querySelector('#status')
    let current = null
    let conversationId = null
    function add(role, text) {
      const el = document.createElement('div')
      el.className = 'msg ' + role
      el.textContent = text
      messages.appendChild(el)
      messages.scrollTop = messages.scrollHeight
      return el
    }
    const events = new EventSource('/events?token=' + encodeURIComponent(token))
    events.addEventListener('ready', () => { status.textContent = 'Connected' })
    events.addEventListener('chat', (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'delta') {
        if (!current) current = add('assistant', '')
        current.textContent += data.text
      }
      if (data.type === 'done') current = null
      if (data.type === 'error') {
        add('assistant', data.message)
        current = null
      }
    })
    events.onerror = () => { status.textContent = 'Reconnecting...' }
    document.querySelector('#form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const input = document.querySelector('#input')
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      add('user', text)
      current = add('assistant', '')
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ text, conversationId })
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Send failed')
      conversationId = body.conversationId
    })
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  </script>
</body>
</html>`
}
