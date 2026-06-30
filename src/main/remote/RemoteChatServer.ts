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
        this.json(res, 200, { models: phoneModels() })
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

// Curated "limited" model set for the phone client. Kept small and stable on
// purpose; the full MODELS list (~40 entries across providers) is too much for a
// phone picker. Order here is the order shown in the dropdown; the first that
// actually exists in MODELS becomes the default.
const PHONE_MODEL_IDS = [
  'claude-haiku-4-5', // Haiku 4.5 (anthropic)
  'gemini-3.1-flash-lite', // Gemini 3.1 Flash (google)
  'openai-gpt-5.4', // GPT 5.4 (openai)
  'gpt-5.4' // Codex · GPT-5.4 (codex)
]

function phoneModels(): ModelOption[] {
  const byId = new Map(MODELS.map((model) => [model.id, model]))
  return PHONE_MODEL_IDS.map((id) => byId.get(id)).filter((model): model is ModelOption => !!model)
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
  <!-- viewport-fit=cover lets the page extend under the notch / home indicator
       so we can pad it back with env(safe-area-inset-*). -->
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <!-- Matches --bg-app so the browser chrome / status bar blends with the shell. -->
  <meta name="theme-color" content="#181818">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.webmanifest">
  <title>Gladdis Remote Chat</title>
  <style>
    /* Design tokens ported verbatim from the desktop app
       (src/renderer/styles/theme.css) so the PWA reads as the same product. */
    :root {
      color-scheme: dark;
      --bg-app: #181818;
      --bg-panel: #1c1c1c;
      --bg-surface: #212121;
      --bg-elevated: #262626;
      --bg-active: #2d2d2d;
      --border-subtle: #2b2b2b;
      --border-strong: #3a3a3a;
      --border-faint: rgba(255, 255, 255, 0.05);
      --text-primary: #e6e6e6;
      --text-secondary: #a8a8ac;
      --text-muted: #757575;
      --accent: #4493f8;
      --accent-dim: #2d5f9e;
      --accent-glow: rgba(68, 147, 248, 0.14);
      --success: #3fb950;
      --danger: #e46a61;
      --radius: 8px;
      --radius-lg: 12px;
      --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
      /* Safe-area insets, with a sane min so content never hugs the edge even
         on devices that report 0 (and on browsers with a bottom URL bar). */
      --safe-top: max(env(safe-area-inset-top), 0px);
      --safe-bottom: max(env(safe-area-inset-bottom), 0px);
      --safe-left: env(safe-area-inset-left);
      --safe-right: env(safe-area-inset-right);
    }
    * { box-sizing: border-box; }
    html { height: 100%; }
    /* Pin the app to the *dynamic* viewport. 100dvh tracks the mobile URL bar
       as it shows/hides (Chrome top OR bottom, Safari bottom), so the composer
       is never hidden behind browser chrome. position: fixed + the height lock
       stops iOS rubber-band scroll from detaching the layout. 100vh is the
       fallback for engines without dvh. */
    body {
      margin: 0;
      position: fixed;
      inset: 0;
      height: 100vh;
      height: 100dvh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      font-family: var(--font-ui);
      font-size: 14px;
      color: var(--text-primary);
      background: var(--bg-app);
      /* The desktop's only "texture": a faint blue glow from the top
         (notepad.css) plus the glass translucency. */
      background-image: radial-gradient(120% 80% at 50% -10%, rgba(68, 147, 248, 0.05), transparent 55%);
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
    }
    header {
      padding: calc(10px + var(--safe-top)) calc(12px + var(--safe-right)) 10px calc(12px + var(--safe-left));
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-panel);
    }
    /* Title cluster: wordmark + a small connection dot, baseline-aligned. */
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-primary); }
    /* Connection status as a compact dot (green ok / amber connecting / red off),
       not a tall second line. Hover/long title shows the text via aria-label. */
    #status {
      flex: 0 0 auto;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--text-muted);
      transition: background 0.2s ease;
    }
    #status.ok { background: var(--success); }
    #status.warn { background: var(--warning); }
    #status.off { background: var(--danger); }
    main {
      padding: 16px calc(16px + var(--safe-right)) 16px calc(16px + var(--safe-left));
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      overflow-anchor: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .msg {
      max-width: 92%;
      line-height: 1.55;
      font-size: 15px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* Assistant: inline, no card — matches desktop .chat-msg.assistant. */
    .assistant { align-self: stretch; max-width: 100%; color: var(--text-primary); }
    /* User: elevated card — matches desktop .chat-msg.user. */
    .user {
      align-self: flex-end;
      max-width: 86%;
      padding: 10px 13px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      background: var(--bg-elevated);
      color: var(--text-primary);
    }
    /* Composer: full-width box, send button inset on the right edge. */
    form {
      padding: 12px calc(12px + var(--safe-right)) calc(12px + var(--safe-bottom)) calc(12px + var(--safe-left));
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-panel);
    }
    .composer-box {
      position: relative;
      width: 100%;
      display: flex;
      align-items: flex-end;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      transition: border-color 0.14s ease, box-shadow 0.14s ease;
    }
    .composer-box:focus-within { border-color: var(--accent-dim); box-shadow: 0 0 0 2px var(--accent-glow); }
    textarea {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 46px;
      max-height: 140px;
      resize: none;
      border: 0;
      background: transparent;
      color: var(--text-primary);
      /* Leave room for the inset send button. */
      padding: 12px 50px 12px 14px;
      /* 16px keeps iOS from zooming the viewport on focus. */
      font-family: inherit;
      font-size: 16px;
      line-height: 1.5;
      outline: none;
    }
    textarea::placeholder { color: var(--text-muted); }
    /* Inset send button: small round arrow, bottom-right inside the composer. */
    #send {
      position: absolute;
      right: 7px;
      bottom: 7px;
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: #fff;
      color: #111;
      transition: background 0.12s ease, opacity 0.12s ease, transform 0.08s ease;
    }
    #send:active { background: #d8d8d8; transform: translateY(1px); }
    #send:disabled { background: var(--bg-elevated); color: var(--text-muted); }
    #send svg { width: 18px; height: 18px; }
    /* Header icon buttons (history / new chat). */
    .icon-btn {
      flex: 0 0 auto;
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      background: transparent;
      color: var(--text-secondary);
      transition: color 0.12s ease, background 0.12s ease, transform 0.08s ease;
    }
    .icon-btn:hover { color: var(--text-primary); background: var(--bg-elevated); }
    .icon-btn:active { transform: translateY(1px); }
    .icon-btn svg { width: 19px; height: 19px; display: block; }
    /* Controls row under the composer: History · New · Model. */
    .composer-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 9px;
    }
    .tool-btn {
      flex: 0 0 auto;
      height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 11px 0 9px;
      border: 1px solid var(--border-subtle);
      border-radius: 999px;
      background: transparent;
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 13px;
      transition: color 0.12s ease, background 0.12s ease, transform 0.08s ease;
    }
    .tool-btn svg { width: 16px; height: 16px; display: block; }
    .tool-btn:hover { color: var(--text-primary); background: var(--bg-elevated); }
    .tool-btn:active { transform: translateY(1px); }
    .composer-tools #model { margin-left: auto; }
    /* History slide-over panel. */
    .history-scrim {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease;
      z-index: 9;
    }
    .history-scrim.open { opacity: 1; pointer-events: auto; }
    .history-panel {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      width: min(86%, 360px);
      background: var(--bg-panel);
      border-right: 1px solid var(--border-subtle);
      transform: translateX(-100%);
      transition: transform 0.22s ease;
      z-index: 10;
      display: flex;
      flex-direction: column;
      padding-top: var(--safe-top);
      padding-left: var(--safe-left);
    }
    .history-panel.open { transform: translateX(0); }
    .history-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 14px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .history-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .history-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 6px; }
    .history-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 11px 12px;
      border: 0;
      border-radius: var(--radius);
      background: transparent;
      color: var(--text-primary);
      transition: background 0.12s ease;
    }
    .history-item:hover, .history-item.active { background: var(--bg-elevated); }
    .history-item-title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .history-item-snippet { margin-top: 3px; font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .history-empty { padding: 24px 16px; color: var(--text-muted); font-size: 13px; text-align: center; }
    /* Header: just the wordmark + a connection dot. */
    .head-row { display: flex; align-items: center; gap: 10px; }
    #model {
      flex: 0 1 auto;
      min-width: 0;
      max-width: 180px;
      height: 34px;
      font-family: inherit;
      font-size: 13px;
      color: var(--text-secondary);
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 999px;
      padding: 0 10px;
      outline: none;
    }
    #model:focus { border-color: var(--accent-dim); }
    /* Markdown rendering inside assistant messages. */
    .assistant p { margin: 0 0 10px; }
    .assistant p:last-child { margin-bottom: 0; }
    .assistant h1, .assistant h2, .assistant h3 { margin: 14px 0 8px; line-height: 1.3; }
    .assistant h1 { font-size: 20px; } .assistant h2 { font-size: 17px; } .assistant h3 { font-size: 15.5px; }
    .assistant ul, .assistant ol { margin: 0 0 10px; padding-left: 22px; }
    .assistant li { margin: 2px 0; }
    .assistant a { color: var(--accent); }
    .assistant code {
      font-family: "SF Mono", "JetBrains Mono", ui-monospace, monospace;
      font-size: 13px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-faint);
      border-radius: 5px;
      padding: 1px 5px;
    }
    .assistant pre {
      margin: 0 0 10px;
      padding: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .assistant pre code { background: none; border: 0; padding: 0; font-size: 12.5px; line-height: 1.5; }
    .assistant strong { font-weight: 600; color: #fff; }
    /* Blinking caret on the streaming reply. */
    .assistant.streaming::after {
      content: "";
      display: inline-block;
      width: 7px; height: 1.05em;
      margin-left: 1px;
      vertical-align: text-bottom;
      background: var(--text-secondary);
      animation: blink 1s step-start infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
  </style>
</head>
<body>
  <header>
    <div class="head-row">
      <div class="brand">
        <h1>Gladdis</h1>
        <span id="status" role="status" aria-label="Connecting"></span>
      </div>
    </div>
  </header>
  <main id="messages"></main>
  <form id="form">
    <div class="composer-box">
      <textarea id="input" placeholder="Message Gladdis" autocomplete="off"></textarea>
      <button id="send" type="submit" aria-label="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
      </button>
    </div>
    <div class="composer-tools">
      <button id="history-btn" class="tool-btn" type="button" aria-label="Chat history">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
        <span>History</span>
      </button>
      <button id="new-btn" class="tool-btn" type="button" aria-label="New chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        <span>New</span>
      </button>
      <select id="model" aria-label="Model"></select>
    </div>
  </form>
  <div id="history-scrim" class="history-scrim"></div>
  <aside id="history-panel" class="history-panel" aria-hidden="true">
    <div class="history-head">
      <h2>Chat history</h2>
      <button id="history-close" class="icon-btn" type="button" aria-label="Close history">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div id="history-list" class="history-list"></div>
  </aside>
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
      if (messageId) el.dataset.messageId = messageId
      if (role === 'assistant') setAssistantText(el, text || '')
      else el.textContent = text
      messages.appendChild(el)
      scrollToBottomIfPinned()
      return el
    }
    // ---- Hardened auto-scroll (stick-to-bottom) ----
    // A single source of truth: \`stick\` is true while the user is reading the
    // latest output and false once they scroll up to read back. Streaming deltas,
    // new messages, restores, and keyboard/viewport resizes all funnel through
    // scrollToBottom(), which only moves the view when stick is true. This avoids
    // the classic bugs: yanking the user down while they read scrollback, and
    // losing the pin because the DOM grew before we measured.
    let stick = true
    let programmaticScroll = false
    const STICK_THRESHOLD = 64
    function distanceFromBottom() {
      return messages.scrollHeight - messages.scrollTop - messages.clientHeight
    }
    // The user's own scrolling sets intent; our programmatic scrolls do not.
    messages.addEventListener('scroll', () => {
      if (programmaticScroll) return
      stick = distanceFromBottom() <= STICK_THRESHOLD
    }, { passive: true })
    function scrollToBottom(force) {
      if (force) stick = true
      if (!stick) return
      // Defer to after layout so markdown re-renders / image reflow are included.
      requestAnimationFrame(() => {
        if (!stick) return
        programmaticScroll = true
        messages.scrollTop = messages.scrollHeight
        // Release the guard on the next frame, after the scroll event fires.
        requestAnimationFrame(() => { programmaticScroll = false })
      })
    }
    // Backward-compatible name used by existing call sites.
    function scrollToBottomIfPinned() { scrollToBottom(false) }
    // Mobile keyboard open/close shrinks the viewport; keep the latest in view.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => scrollToBottom(false))
    }
    window.addEventListener('resize', () => scrollToBottom(false))
    // Assistant text is markdown. We keep the raw source on the node and
    // re-render on each streamed delta so formatting appears live, token by token.
    function setAssistantText(el, raw) {
      el.dataset.raw = raw
      el.innerHTML = renderMarkdown(raw)
    }
    function appendAssistantText(el, delta) {
      setAssistantText(el, (el.dataset.raw || '') + delta)
    }
    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    }
    // Tiny, dependency-free, XSS-safe markdown -> HTML. Everything is escaped
    // first; only a known set of inline/block constructs are then re-introduced.
    // Covers the formatting models actually emit in chat: fenced + inline code,
    // bold/italic, headings, lists, links. Not full CommonMark by design.
    function renderMarkdown(src) {
      const lines = src.replace(/\\r\\n/g, '\\n').split('\\n')
      let html = ''
      let i = 0
      let listType = null
      const closeList = () => { if (listType) { html += '</' + listType + '>'; listType = null } }
      while (i < lines.length) {
        const line = lines[i]
        // Fenced code block
        const fence = line.match(/^\\s*\`\`\`(.*)$/)
        if (fence) {
          closeList()
          const body = []
          i++
          while (i < lines.length && !/^\\s*\`\`\`/.test(lines[i])) { body.push(lines[i]); i++ }
          i++ // skip closing fence
          html += '<pre><code>' + escapeHtml(body.join('\\n')) + '</code></pre>'
          continue
        }
        const heading = line.match(/^(#{1,3})\\s+(.*)$/)
        if (heading) {
          closeList()
          const level = heading[1].length
          html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>'
          i++; continue
        }
        const ul = line.match(/^\\s*[-*]\\s+(.*)$/)
        const ol = line.match(/^\\s*\\d+\\.\\s+(.*)$/)
        if (ul || ol) {
          const want = ul ? 'ul' : 'ol'
          if (listType !== want) { closeList(); listType = want; html += '<' + want + '>' }
          html += '<li>' + inline((ul || ol)[1]) + '</li>'
          i++; continue
        }
        if (line.trim() === '') { closeList(); i++; continue }
        closeList()
        html += '<p>' + inline(line) + '</p>'
        i++
      }
      closeList()
      return html
    }
    // Inline spans: escape, then re-introduce code / bold / italic / links.
    function inline(text) {
      // Pull out inline code first so its contents aren't formatted.
      const codes = []
      let s = text.replace(/\`([^\`]+)\`/g, (_m, c) => { codes.push(c); return '\\u0000' + (codes.length - 1) + '\\u0000' })
      s = escapeHtml(s)
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>')
      s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, (_m, label, url) => '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>')
      s = s.replace(/\\u0000(\\d+)\\u0000/g, (_m, n) => '<code>' + escapeHtml(codes[Number(n)]) + '</code>')
      return s
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
    // Connection state is shown as a colored dot, not a text line. Green =
    // connected, amber = connecting/reconnecting, red = error/offline. The full
    // text (plus any queued count) lives on aria-label for screen readers.
    function setStatus(base) {
      const queued = outbox.filter((item) => !item.acked).length
      const label = queued ? base + ' - ' + queued + ' queued' : base
      status.setAttribute('aria-label', label)
      let state = 'warn'
      if (base === 'Connected') state = queued ? 'warn' : 'ok'
      else if (base === 'Queued offline' || base === 'connected') state = queued ? 'warn' : 'ok'
      else if (/error|low|fail|offline/i.test(base)) state = 'off'
      status.classList.remove('ok', 'warn', 'off')
      status.classList.add(state)
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
          conversationId: item.conversationId,
          modelId: item.modelId || selectedModel()
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
      // Opening a conversation should land at the latest message.
      scrollToBottom(true)
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
            assistant.classList.add('streaming')
            appendAssistantText(assistant, stream.text)
            scrollToBottomIfPinned()
          }
          if (stream.type === 'done') {
            assistant.classList.remove('streaming')
            assistants.delete(stream.requestId)
            persistState()
            return
          }
          if (stream.type === 'error') {
            assistant.classList.remove('streaming')
            const prior = assistant.dataset.raw || ''
            setAssistantText(assistant, prior ? prior + '\\n\\n' + stream.message : stream.message)
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
            pending.assistant.classList.remove('streaming')
            if (!(pending.assistant.dataset.raw || '')) setAssistantText(pending.assistant, data.message)
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
    // ---- Model picker (limited set from /api/models) ----
    const modelSelect = document.querySelector('#model')
    const modelStorageKey = 'gladdis-remote-model:' + token
    function selectedModel() { return modelSelect.value || undefined }
    async function loadModels() {
      try {
        const res = await fetch('/api/models?token=' + encodeURIComponent(token))
        if (!res.ok) return
        const body = await res.json()
        const models = Array.isArray(body.models) ? body.models : []
        if (!models.length) { modelSelect.style.display = 'none'; return }
        const saved = localStorage.getItem(modelStorageKey)
        modelSelect.innerHTML = ''
        for (const model of models) {
          const opt = document.createElement('option')
          opt.value = model.id
          opt.textContent = model.label || model.id
          modelSelect.appendChild(opt)
        }
        if (saved && models.some((m) => m.id === saved)) modelSelect.value = saved
      } catch (_error) {
        modelSelect.style.display = 'none'
      }
    }
    modelSelect.addEventListener('change', () => {
      try { localStorage.setItem(modelStorageKey, modelSelect.value) } catch (_error) {}
    })
    loadModels()

    // ---- New chat ----
    function startNewChat() {
      // Drop the current conversation id and clear the transcript. The next send
      // creates a fresh remote conversation server-side.
      setConversation(null)
      clearMessages()
      document.querySelector('#input').focus()
    }
    document.querySelector('#new-btn').addEventListener('click', startNewChat)

    // ---- Chat history (shares the desktop conversation store via /api/chats) ----
    const historyPanel = document.querySelector('#history-panel')
    const historyScrim = document.querySelector('#history-scrim')
    const historyList = document.querySelector('#history-list')
    function openHistory() {
      historyPanel.classList.add('open')
      historyScrim.classList.add('open')
      historyPanel.setAttribute('aria-hidden', 'false')
      loadHistory()
    }
    function closeHistory() {
      historyPanel.classList.remove('open')
      historyScrim.classList.remove('open')
      historyPanel.setAttribute('aria-hidden', 'true')
    }
    async function loadHistory() {
      historyList.innerHTML = '<div class="history-empty">Loading…</div>'
      try {
        const res = await fetch('/api/chats?token=' + encodeURIComponent(token))
        if (!res.ok) { historyList.innerHTML = '<div class="history-empty">Could not load history.</div>'; return }
        const body = await res.json()
        const items = Array.isArray(body.conversations) ? body.conversations : []
        if (!items.length) { historyList.innerHTML = '<div class="history-empty">No conversations yet.</div>'; return }
        historyList.innerHTML = ''
        for (const meta of items) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'history-item' + (meta.id === conversationId ? ' active' : '')
          const title = document.createElement('div')
          title.className = 'history-item-title'
          title.textContent = meta.title || 'Untitled chat'
          btn.appendChild(title)
          if (meta.summary) {
            const snip = document.createElement('div')
            snip.className = 'history-item-snippet'
            snip.textContent = meta.summary
            btn.appendChild(snip)
          }
          btn.addEventListener('click', () => openConversation(meta.id))
          historyList.appendChild(btn)
        }
      } catch (_error) {
        historyList.innerHTML = '<div class="history-empty">Could not load history.</div>'
      }
    }
    async function openConversation(id) {
      const conversation = await fetchConversation(id)
      if (conversation) {
        setConversation(conversation.id)
        renderConversation(conversation)
      }
      closeHistory()
    }
    document.querySelector('#history-btn').addEventListener('click', openHistory)
    document.querySelector('#history-close').addEventListener('click', closeHistory)
    historyScrim.addEventListener('click', closeHistory)

    connect()
    document.querySelector('#form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const input = document.querySelector('#input')
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      add('user', text)
      const assistant = add('assistant', '')
      // Sending is an explicit intent to follow the reply: re-pin to bottom.
      scrollToBottom(true)
      outbox.push({
        clientMessageId: nextClientMessageId(),
        text,
        conversationId,
        modelId: selectedModel(),
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
