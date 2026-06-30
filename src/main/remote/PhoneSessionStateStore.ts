import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { dirname, join } from 'node:path'
import type { PhoneSessionPendingTurn, PhoneSessionSnapshot } from '../../../shared/types'

interface StoredPhoneSession extends PhoneSessionSnapshot {
  updatedAt: number
}

interface PhoneSessionFile {
  version: 1
  sessions: Record<string, StoredPhoneSession>
}

export class PhoneSessionStateStore {
  private readonly file: string
  private sessions = new Map<string, StoredPhoneSession>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(file = join(app.getPath('userData'), 'gladdis-phone-sessions.json')) {
    this.file = file
    this.load()
  }

  get(sessionKey: string): PhoneSessionSnapshot {
    const session = this.sessions.get(sessionKey)
    if (!session) return emptySession()
    return {
      conversationId: session.conversationId,
      pending: [...session.pending].sort((a, b) => a.createdAt - b.createdAt)
    }
  }

  setConversation(sessionKey: string, conversationId: string | null): void {
    const session = this.ensure(sessionKey)
    session.conversationId = normalizeNullableString(conversationId)
    session.updatedAt = Date.now()
    this.commit(sessionKey, session)
  }

  upsertPending(sessionKey: string, pending: PhoneSessionPendingTurn): void {
    const session = this.ensure(sessionKey)
    const normalized = normalizePending(pending)
    const index = session.pending.findIndex((candidate) => candidate.clientMessageId === normalized.clientMessageId)
    if (index >= 0) session.pending[index] = normalized
    else session.pending.push(normalized)
    if (normalized.conversationId) session.conversationId = normalized.conversationId
    session.updatedAt = Date.now()
    this.commit(sessionKey, session)
  }

  clearPendingByClientMessageId(sessionKey: string, clientMessageId: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    session.pending = session.pending.filter((candidate) => candidate.clientMessageId !== clientMessageId)
    session.updatedAt = Date.now()
    this.commit(sessionKey, session)
  }

  clearPendingByRequestId(sessionKey: string, requestId: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    session.pending = session.pending.filter((candidate) => candidate.requestId !== requestId)
    session.updatedAt = Date.now()
    this.commit(sessionKey, session)
  }

  clear(sessionKey: string): void {
    if (!this.sessions.delete(sessionKey)) return
    this.schedulePersist()
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.persist()
  }

  private ensure(sessionKey: string): StoredPhoneSession {
    const existing = this.sessions.get(sessionKey)
    if (existing) return existing
    const created: StoredPhoneSession = {
      ...emptySession(),
      updatedAt: Date.now()
    }
    this.sessions.set(sessionKey, created)
    return created
  }

  private commit(sessionKey: string, session: StoredPhoneSession): void {
    if (!session.conversationId && session.pending.length === 0) this.sessions.delete(sessionKey)
    else this.sessions.set(sessionKey, session)
    this.schedulePersist()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as PhoneSessionFile
      if (!raw || raw.version !== 1 || !raw.sessions || typeof raw.sessions !== 'object') return
      for (const [key, value] of Object.entries(raw.sessions)) {
        if (!isStoredSession(value)) continue
        this.sessions.set(key, {
          conversationId: normalizeNullableString(value.conversationId),
          pending: value.pending.map(normalizePending),
          updatedAt: value.updatedAt
        })
      }
    } catch (error) {
      console.warn('[phone] failed to load session state:', error)
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 50)
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`
    const payload: PhoneSessionFile = {
      version: 1,
      sessions: Object.fromEntries(this.sessions.entries())
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(tmp, this.file)
  }
}

export function deviceSessionKey(deviceId: string): string {
  return `device:${deviceId}`
}

export function tokenSessionKey(tokenKey: string): string {
  return `token:${tokenKey}`
}

function emptySession(): PhoneSessionSnapshot {
  return { conversationId: null, pending: [] }
}

function normalizePending(value: PhoneSessionPendingTurn): PhoneSessionPendingTurn {
  return {
    clientMessageId: value.clientMessageId.trim(),
    text: value.text,
    conversationId: normalizeNullableString(value.conversationId),
    requestId: normalizeNullableString(value.requestId),
    assistantMessageId: normalizeNullableString(value.assistantMessageId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

function normalizeNullableString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isStoredSession(value: unknown): value is StoredPhoneSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Record<string, unknown>
  return (
    (typeof session.conversationId === 'string' || session.conversationId === null) &&
    typeof session.updatedAt === 'number' &&
    Array.isArray(session.pending) &&
    session.pending.every(isPendingTurn)
  )
}

function isPendingTurn(value: unknown): value is PhoneSessionPendingTurn {
  if (!value || typeof value !== 'object') return false
  const pending = value as Record<string, unknown>
  return (
    typeof pending.clientMessageId === 'string' &&
    typeof pending.text === 'string' &&
    (typeof pending.conversationId === 'string' || pending.conversationId === null) &&
    (typeof pending.requestId === 'string' || pending.requestId === null) &&
    (typeof pending.assistantMessageId === 'string' || pending.assistantMessageId === null) &&
    typeof pending.createdAt === 'number' &&
    typeof pending.updatedAt === 'number'
  )
}
