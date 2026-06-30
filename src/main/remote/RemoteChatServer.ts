import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type {
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationMeta,
  ModelOption,
  PhoneBridgeDevice,
  PhoneSessionSnapshot,
  PhoneSocketCommand,
  PhoneSocketEvent,
  StoredMessage
} from '../../../shared/types'
import { MODELS } from '../../../shared/types'
import { deviceSessionKey, tokenSessionKey } from './PhoneSessionStateStore'

export interface RemotePhoneSessionStore {
  get(sessionKey: string): PhoneSessionSnapshot
  setConversation(sessionKey: string, conversationId: string | null): void
  upsertPending(sessionKey: string, pending: {
    clientMessageId: string
    text: string
    conversationId: string | null
    requestId: string | null
    assistantMessageId: string | null
    createdAt: number
    updatedAt: number
  }): void
  clearPendingByRequestId(sessionKey: string, requestId: string): void
}

export interface RemoteChatServerOptions {
  host?: string
  port?: number
  token?: string
  corsOrigin?: string
  authenticateDevice?: (token: string) => PhoneBridgeDevice | null
  sessionStore?: RemotePhoneSessionStore
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
  sessionKey?: string
  clientMessageId?: string
  text?: string
}

interface SocketAckResult {
  clientMessageId: string
  requestId: string
  conversationId: string
  assistantMessageId: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const JSON_LIMIT_BYTES = 64 * 1024
const SOCKET_RESULT_TTL_MS = 5 * 60 * 1000
const MAX_SOCKET_RESULTS = 500

export class RemoteChatServer {
  private server = createServer((req, res) => void this.handle(req, res))
  private clients = new Set<ServerResponse>()
  private wsServer = new WebSocketServer({ noServer: true })
  private wsClients = new Set<WebSocket>()
  private wsClientKeys = new WeakMap<WebSocket, string>()
  private wsSessionKeys = new WeakMap<WebSocket, string>()
  private pendingSocketResults = new Map<string, Promise<SocketAckResult>>()
  private recentSocketResults = new Map<string, SocketAckResult & { seenAt: number }>()
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
    this.server.on('upgrade', (req, socket, head) => {
      const auth = this.authorize(req)
      if (requestPath(req) !== '/ws' || !auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wsServer.handleUpgrade(req, socket, head, (ws: WebSocket) => this.openWebSocket(ws, auth))
    })
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
    for (const client of this.wsClients) client.close()
    this.wsClients.clear()
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

  private async send(
    body: unknown,
    context: { clientMessageId?: string; sessionKey?: string } = {}
  ): Promise<{ requestId: string; conversationId: string; assistantMessageId: string }> {
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

    this.activeTurns.set(requestId, {
      conversationId,
      assistantMessageId,
      sessionKey: context.sessionKey,
      clientMessageId: context.clientMessageId,
      text
    })
    if (context.sessionKey) {
      const now = Date.now()
      this.options.sessionStore?.setConversation(context.sessionKey, conversationId)
      if (context.clientMessageId) {
        this.options.sessionStore?.upsertPending(context.sessionKey, {
          clientMessageId: context.clientMessageId,
          text,
          conversationId,
          requestId,
          assistantMessageId,
          createdAt: now,
          updatedAt: now
        })
      }
    }
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
    if (turn.sessionKey && turn.clientMessageId && turn.text) {
      const existingPending = this.options.sessionStore?.get(turn.sessionKey).pending
        .find((candidate) => candidate.clientMessageId === turn.clientMessageId)
      this.options.sessionStore?.upsertPending(turn.sessionKey, {
        clientMessageId: turn.clientMessageId,
        text: turn.text,
        conversationId: turn.conversationId,
        requestId: event.requestId,
        assistantMessageId: turn.assistantMessageId,
        createdAt: existingPending?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      })
    }
    if (event.type === 'done' || event.type === 'error') {
      if (turn.sessionKey) this.options.sessionStore?.clearPendingByRequestId(turn.sessionKey, event.requestId)
      this.activeTurns.delete(event.requestId)
    }
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

  private openWebSocket(
    ws: WebSocket,
    auth: { clientKey: string; sessionKey: string }
  ): void {
    this.wsClients.add(ws)
    this.wsClientKeys.set(ws, auth.clientKey)
    this.wsSessionKeys.set(ws, auth.sessionKey)
    this.sendSocket(ws, { type: 'ready', session: this.currentSession(auth.sessionKey) })
    this.sendSocket(ws, { type: 'status', state: 'connected' })
    ws.on('message', (data) => void this.onSocketMessage(ws, data))
    ws.on('close', () => this.wsClients.delete(ws))
  }

  private async onSocketMessage(ws: WebSocket, data: RawData): Promise<void> {
    try {
      const raw = rawDataToText(data)
      const message = JSON.parse(raw) as PhoneSocketCommand
      if (message.type === 'send') {
        const clientKey = this.wsClientKeys.get(ws) ?? 'unknown'
        const sessionKey = this.wsSessionKeys.get(ws) ?? tokenSessionKey(clientKey)
        const clientMessageId = normalizeClientMessageId(message.clientMessageId)
        const dedupeKey = `${clientKey}:${clientMessageId}`
        const cached = this.recentSocketResults.get(dedupeKey)
        if (cached) {
          cached.seenAt = Date.now()
          this.sendSocket(ws, {
            type: 'ack',
            clientMessageId: cached.clientMessageId,
            requestId: cached.requestId,
            conversationId: cached.conversationId,
            assistantMessageId: cached.assistantMessageId
          })
          return
        }
        const pending = this.pendingSocketResults.get(dedupeKey)
        const ack = pending ?? this.createPendingSocketAck(dedupeKey, sessionKey, clientMessageId, message)
        const result = await ack
        pruneSocketResults(this.recentSocketResults)
        this.sendSocket(ws, { type: 'ack', ...result })
        return
      }
      if (message.type === 'abort') {
        const requestId = message.requestId?.trim()
        if (!requestId) throw new Error('requestId is required')
        const sessionKey = this.wsSessionKeys.get(ws)
        if (sessionKey) this.options.sessionStore?.clearPendingByRequestId(sessionKey, requestId)
        this.bridge.abort(requestId)
        return
      }
      throw new Error('Unsupported socket command')
    } catch (error) {
      this.sendSocket(ws, { type: 'error', message: errorMessage(error) })
    }
  }

  private broadcast(event: ChatStreamEvent): void {
    const payload = `event: chat\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) client.write(payload)
    const wsPayload: PhoneSocketEvent = { type: 'chat', event }
    for (const client of this.wsClients) this.sendSocket(client, wsPayload)
  }

  private sendSocket(ws: WebSocket, event: PhoneSocketEvent): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(event))
  }

  private authorized(req: IncomingMessage): boolean {
    return !!this.authorize(req)
  }

  private authorize(req: IncomingMessage): { clientKey: string; sessionKey: string } | null {
    const supplied = bearerToken(req) ?? queryToken(req)
    if (!supplied) return null
    const clientKey = tokenKey(supplied)
    const device = this.options.authenticateDevice?.(supplied)
    if (device) return { clientKey, sessionKey: deviceSessionKey(device.id) }
    if (safeEqual(supplied, this.token)) return { clientKey, sessionKey: tokenSessionKey(clientKey) }
    return null
  }

  private createPendingSocketAck(
    dedupeKey: string,
    sessionKey: string,
    clientMessageId: string,
    message: Extract<PhoneSocketCommand, { type: 'send' }>
  ): Promise<SocketAckResult> {
    const pending = this.send(message, { clientMessageId, sessionKey })
      .then((result) => {
        const ack: SocketAckResult = { clientMessageId, ...result }
        this.recentSocketResults.set(dedupeKey, { ...ack, seenAt: Date.now() })
        return ack
      })
      .finally(() => {
        this.pendingSocketResults.delete(dedupeKey)
      })
    this.pendingSocketResults.set(dedupeKey, pending)
    return pending
  }

  private currentSession(sessionKey: string): PhoneSessionSnapshot {
    return this.options.sessionStore?.get(sessionKey) ?? { conversationId: null, pending: [] }
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

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data as Uint8Array).toString('utf8')
}

function normalizeClientMessageId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : `phone-msg-${randomUUID()}`
}

function tokenKey(token: string): string {
  return createHash('sha1').update(token).digest('hex')
}

function pruneSocketResults(results: Map<string, SocketAckResult & { seenAt: number }>): void {
  const cutoff = Date.now() - SOCKET_RESULT_TTL_MS
  for (const [key, value] of results) {
    if (value.seenAt < cutoff) results.delete(key)
  }
  if (results.size <= MAX_SOCKET_RESULTS) return
  const oldest = [...results.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)
  for (const [key] of oldest.slice(0, results.size - MAX_SOCKET_RESULTS)) results.delete(key)
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
    icons: [
      { src: ICON_SVG, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  }
}

// Inline SVG icon as a data URI — avoids serving/committing a binary asset.
// `sizes: 'any'` lets the vector satisfy every install size; the safe-zone
// inset keeps the glyph inside the maskable crop circle.
const ICON_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
      `<rect width="512" height="512" rx="96" fill="#0b0d10"/>` +
      `<text x="256" y="316" font-family="Inter, system-ui, sans-serif" font-size="300" ` +
      `font-weight="700" text-anchor="middle" fill="#d7f7c2">G</text>` +
      `</svg>`
  )

function serviceWorker(): string {
  // Cache only the manifest; NOT /app. The /app HTML embeds the bridge token as
  // a fallback, and the auto-generated server token rotates every desktop
  // restart — a cached /app would hand the phone a dead token and the offline
  // fallback would keep serving it. So navigations are always network-first and
  // only fall back to a cached shell when the desktop is genuinely unreachable.
  return `
self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open('gladdis-remote-v2').then((cache) => cache.addAll(['/manifest.webmanifest'])))
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== 'gladdis-remote-v2').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  // Never serve a cached navigation/page response (would pin a stale token).
  if (event.request.mode === 'navigate') return
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
    const storageKey = 'gladdis-remote-v2:' + token
    const messages = document.querySelector('#messages')
    const status = document.querySelector('#status')
    let conversationId = null
    let socket = null
    let reconnectTimer = null
    const outbox = []
    const assistants = new Map()
    let persistedState = loadPersistedState()
    if (persistedState.conversationId) conversationId = persistedState.conversationId
    function add(role, text, messageId) {
      const el = document.createElement('div')
      el.className = 'msg ' + role
      el.textContent = text
      if (messageId) el.dataset.messageId = messageId
      messages.appendChild(el)
      messages.scrollTop = messages.scrollHeight
      return el
    }
    function clearMessages() {
      messages.textContent = ''
      assistants.clear()
    }
    function findMessage(messageId) {
      for (const node of messages.children) {
        if (node.dataset && node.dataset.messageId === messageId) return node
      }
      return null
    }
    function nextClientMessageId() {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
      return 'phone-msg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    }
    function normalizePersistedItem(value) {
      if (!value || typeof value !== 'object') return null
      if (typeof value.clientMessageId !== 'string' || typeof value.text !== 'string') return null
      return {
        clientMessageId: value.clientMessageId,
        text: value.text,
        conversationId: typeof value.conversationId === 'string' && value.conversationId.trim() ? value.conversationId.trim() : null,
        requestId: typeof value.requestId === 'string' && value.requestId.trim() ? value.requestId.trim() : null,
        assistantMessageId: typeof value.assistantMessageId === 'string' && value.assistantMessageId.trim() ? value.assistantMessageId.trim() : null
      }
    }
    function loadPersistedState() {
      try {
        const raw = localStorage.getItem(storageKey)
        if (!raw) return { conversationId: null, outbox: [] }
        const parsed = JSON.parse(raw)
        return {
          conversationId: typeof parsed.conversationId === 'string' && parsed.conversationId.trim()
            ? parsed.conversationId.trim()
            : null,
          outbox: Array.isArray(parsed.outbox)
            ? parsed.outbox.map(normalizePersistedItem).filter(Boolean)
            : []
        }
      } catch (_error) {
        return { conversationId: null, outbox: [] }
      }
    }
    function serializeOutbox() {
      return outbox.map((item) => ({
        clientMessageId: item.clientMessageId,
        text: item.text,
        conversationId: item.conversationId || null,
        requestId: item.requestId || null,
        assistantMessageId: item.assistantMessageId || null
      }))
    }
    function persistState() {
      persistedState = {
        conversationId,
        outbox: serializeOutbox()
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(persistedState))
      } catch (_error) {}
    }
    function setConversation(nextConversationId) {
      conversationId = typeof nextConversationId === 'string' && nextConversationId.trim()
        ? nextConversationId.trim()
        : null
      persistState()
    }
    function setStatus(base) {
      const queued = outbox.filter((item) => !item.acked).length
      status.textContent = queued ? base + ' - ' + queued + ' queued' : base
    }
    function flushOutbox() {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      for (const item of outbox) {
        if (item.acked || item.sent) continue
        item.sent = true
        item.conversationId = item.conversationId || conversationId
        socket.send(JSON.stringify({
          type: 'send',
          clientMessageId: item.clientMessageId,
          text: item.text,
          conversationId: item.conversationId
        }))
      }
      persistState()
      setStatus('Connected')
    }
    async function fetchConversation(nextConversationId) {
      const res = await fetch('/api/chats/' + encodeURIComponent(nextConversationId) + '?token=' + encodeURIComponent(token))
      if (!res.ok) return null
      const body = await res.json()
      return body && body.conversation ? body.conversation : null
    }
    function renderConversation(conversation) {
      clearMessages()
      for (const message of conversation.messages || []) add(message.role, message.text || '', message.id)
    }
    function mergeLocalPending() {
      const merged = new Map()
      for (const item of persistedState.outbox) merged.set(item.clientMessageId, item)
      for (const item of outbox.splice(0, outbox.length)) {
        merged.set(item.clientMessageId, {
          clientMessageId: item.clientMessageId,
          text: item.text,
          conversationId: item.conversationId || null,
          requestId: item.requestId || null,
          assistantMessageId: item.assistantMessageId || null
        })
      }
      return [...merged.values()]
    }
    async function restoreSession(session) {
      const localPending = mergeLocalPending()
      const serverPending = new Map((session.pending || []).map((item) => [item.clientMessageId, item]))
      const sessionConversationId = session.conversationId || conversationId
      if (sessionConversationId) {
        const conversation = await fetchConversation(sessionConversationId)
        if (conversation) {
          setConversation(conversation.id)
          renderConversation(conversation)
        } else {
          clearMessages()
          setConversation(sessionConversationId)
        }
      } else {
        clearMessages()
      }
      for (const item of localPending) {
        const remote = serverPending.get(item.clientMessageId)
        if (!remote) add('user', item.text)
        const bubble = remote && remote.assistantMessageId
          ? (findMessage(remote.assistantMessageId) || add('assistant', '', remote.assistantMessageId))
          : add('assistant', '')
        if (remote && remote.requestId) assistants.set(remote.requestId, bubble)
        outbox.push({
          clientMessageId: item.clientMessageId,
          text: item.text,
          conversationId: remote && remote.conversationId ? remote.conversationId : (item.conversationId || conversationId),
          requestId: remote && remote.requestId ? remote.requestId : (item.requestId || null),
          assistantMessageId: remote && remote.assistantMessageId ? remote.assistantMessageId : (item.assistantMessageId || null),
          assistant: bubble,
          acked: false,
          sent: false
        })
        serverPending.delete(item.clientMessageId)
      }
      for (const pending of serverPending.values()) {
        const bubble = pending.assistantMessageId
          ? (findMessage(pending.assistantMessageId) || add('assistant', '', pending.assistantMessageId))
          : add('assistant', '')
        if (pending.requestId) assistants.set(pending.requestId, bubble)
        outbox.push({
          clientMessageId: pending.clientMessageId,
          text: pending.text,
          conversationId: pending.conversationId || conversationId,
          requestId: pending.requestId || null,
          assistantMessageId: pending.assistantMessageId || null,
          assistant: bubble,
          acked: false,
          sent: false
        })
      }
      persistState()
      flushOutbox()
    }
    function connect() {
      setStatus('Connecting...')
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(protocol + '//' + location.host + '/ws?token=' + encodeURIComponent(token))
      socket.addEventListener('open', () => { setStatus('Connected') })
      socket.addEventListener('message', async (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'ready') {
          await restoreSession(data.session || { conversationId: conversationId || null, pending: [] })
          setStatus('Connected')
          return
        }
        if (data.type === 'status') {
          setStatus(data.state === 'connected' ? 'Connected' : data.state)
          return
        }
        if (data.type === 'ack') {
          setConversation(data.conversationId)
          const index = outbox.findIndex((candidate) => candidate.clientMessageId === data.clientMessageId)
          const item = index >= 0 ? outbox[index] : null
          if (!item) return
          item.acked = true
          item.requestId = data.requestId
          item.assistantMessageId = data.assistantMessageId
          outbox.splice(index, 1)
          assistants.set(data.requestId, item.assistant)
          item.assistant.dataset.requestId = data.requestId
          item.assistant.dataset.messageId = data.assistantMessageId
          persistState()
          setStatus('Connected')
          return
        }
        if (data.type === 'chat') {
          const stream = data.event
          const assistant = assistants.get(stream.requestId)
          if (!assistant) return
          if (stream.type === 'delta') {
            assistant.textContent += stream.text
          }
          if (stream.type === 'done') {
            assistants.delete(stream.requestId)
            persistState()
            return
          }
          if (stream.type === 'error') {
            assistant.textContent = assistant.textContent ? assistant.textContent + '\\n\\n' + stream.message : stream.message
            assistants.delete(stream.requestId)
            persistState()
          }
          return
        }
        if (data.type === 'error') {
          setStatus(data.message)
          const pending = outbox.find((item) => item.sent && !item.acked)
          if (pending) {
            pending.sent = false
            pending.assistant.textContent = pending.assistant.textContent || data.message
          }
          persistState()
        }
      })
      socket.addEventListener('close', () => {
        for (const item of outbox) {
          if (!item.acked) item.sent = false
        }
        persistState()
        setStatus('Reconnecting...')
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(connect, 800)
      })
    }
    connect()
    document.querySelector('#form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const input = document.querySelector('#input')
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      add('user', text)
      const assistant = add('assistant', '')
      outbox.push({
        clientMessageId: nextClientMessageId(),
        text,
        conversationId,
        requestId: null,
        assistantMessageId: null,
        assistant,
        acked: false,
        sent: false
      })
      persistState()
      flushOutbox()
      if (!socket || socket.readyState !== WebSocket.OPEN) setStatus('Queued offline')
    })
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  </script>
</body>
</html>`
}
