import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { join } from 'path'
import type { Conversation, ConversationMeta, ConversationSearchHit } from '../../../shared/types'

/** Minimal structural-sharing helper (no extra deps). */
function produce<T extends object>(base: T, recipe: (draft: T) => void): T {
  const copy = structuredClone(base)
  recipe(copy)
  return copy
}

/** Max chars kept for an auto-derived conversation title. */
const TITLE_MAX = 48
const SUMMARY_MAX = 720
const SEARCH_LIMIT = 8

function compactExcerpt(text: string, query: string, max = 180): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!clean) return ''
  const lower = clean.toLowerCase()
  const q = query.trim().toLowerCase()
  if (!q) return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
  const index = lower.indexOf(q)
  if (index < 0) return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
  const start = Math.max(0, index - Math.floor((max - q.length) / 2))
  const end = Math.min(clean.length, start + max)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < clean.length ? '…' : ''
  return `${prefix}${clean.slice(start, end)}${suffix}`
}

function scoreText(text: string, lowerQuery: string, tokens: string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  if (lower.includes(lowerQuery)) score += 24
  for (const token of tokens) {
    if (!lower.includes(token)) continue
    score += token.length >= 5 ? 6 : 3
  }
  return score
}

function compactTurnForSummary(text: string, max = 180): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * Persists chat history to a single JSON file under userData. Conversations
 * survive renderer reloads, HMR rebuilds, and full app restarts — gladdis
 * restores the last-active conversation on launch and keeps the rest browsable.
 *
 * The renderer is the source of truth for message content; it calls save()
 * after each change. This store just durably mirrors that to disk.
 */
export class ChatStore {
  private file = join(app.getPath('userData'), 'gladdis-chats.json')
  private convos = new Map<string, Conversation>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistInFlight = false
  private persistQueued = false

  constructor() {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Conversation[]
      for (const c of raw) {
        if (c && typeof c.id === 'string') {
          this.convos.set(c.id, c)
        }
      }
    } catch (e) {
      console.warn('[chats] failed to load:', e)
    }
  }

  private persist(): void {
    this.persistQueued = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.flushPersist()
    }, 250)
  }

  private async flushPersist(): Promise<void> {
    if (this.persistInFlight) return
    this.persistInFlight = true
    while (this.persistQueued) {
      this.persistQueued = false
      await this.writeNow()
    }
    this.persistInFlight = false
  }

  private async writeNow(): Promise<void> {
    // Newest-updated first, so the on-disk order matches the history list.
    const all = [...this.convos.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    const tmp = this.file + '.tmp'
    try {
      // Write-then-rename so a crash mid-write can't corrupt the history file.
      await writeFile(tmp, JSON.stringify(all), { mode: 0o600 })
      await rename(tmp, this.file)
    } catch (e) {
      console.warn('[chats] failed to persist:', e)
    }
  }

  /** Derive a title from the first user message; fall back to "New chat". */
  private deriveTitle(conv: Conversation): string {
    const first = conv.messages.find((m) => m.role === 'user' && m.text.trim())
    if (!first) return 'New chat'
    const t = first.text.trim().replace(/\s+/g, ' ')
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t
  }

  private deriveSummary(conv: Conversation): string {
    const turns = conv.messages
      .filter((m) => m.text.trim())
      .slice(0, 6)
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${compactTurnForSummary(m.text)}`)
    const summary = turns.join('\n')
    return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary
  }

  /**
   * Set a (model-generated) title and mark it final so save() won't overwrite
   * it with the first-message fallback. No-op if the conversation is gone.
   */
  setTitle(id: string, title: string): void {
    const conv = this.convos.get(id)
    if (!conv) return
    const t = title.trim().replace(/\s+/g, ' ')
    if (!t) return
    conv.title = t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t
    conv.titleLocked = true
    this.persist()
  }

  list(): ConversationMeta[] {
    return [...this.convos.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, summary, createdAt, updatedAt, continuesFromId }) => ({
        id,
        title,
        summary,
        createdAt,
        updatedAt,
        continuesFromId: continuesFromId ?? null
      }))
  }

  get(id: string): Conversation | null {
    return this.convos.get(id) ?? null
  }

  /** Bind a saved Gladdis conversation to the Codex provider thread that backs it. */
  setCodexThreadId(id: string, threadId: string | null): void {
    const conv = this.convos.get(id)
    if (!conv) return
    conv.codexThreadId = threadId
    this.persist()
  }

  /**
   * Upsert a conversation. Empty conversations (no messages) are never stored —
   * this keeps blank "New chat" slots out of the history list. Returns the
   * persisted conversation (with its refreshed title).
   */
  save(conv: Conversation): Conversation {
    if (!conv.messages.length) {
      this.convos.delete(conv.id)
      this.persist()
      return conv
    }
    const prev = this.convos.get(conv.id)
    const stored = produce(conv, (d) => {
      d.titleLocked = conv.titleLocked || prev?.titleLocked || false
      d.title = d.titleLocked ? (prev?.title || conv.title) : this.deriveTitle(conv)
      d.summary = this.deriveSummary(conv)
      d.codexThreadId = conv.codexThreadId === undefined
        ? (prev?.codexThreadId ?? null)
        : (conv.codexThreadId ?? null)
      d.continuesFromId = conv.continuesFromId === undefined
        ? (prev?.continuesFromId ?? null)
        : conv.continuesFromId
    })
    this.convos.set(stored.id, stored)
    this.persist()
    return stored
  }

  /** Current conversation followed by its continuation ancestors. */
  lineage(id: string, maxDepth = 8): Conversation[] {
    const out: Conversation[] = []
    const seen = new Set<string>()
    let cur: string | null | undefined = id
    while (cur && out.length < maxDepth && !seen.has(cur)) {
      seen.add(cur)
      const conv = this.convos.get(cur)
      if (!conv) break
      out.push(conv)
      cur = conv.continuesFromId ?? null
    }
    return out
  }

  /** Most recently updated non-empty conversation other than the current one. */
  previousConversation(currentId: string): Conversation | null {
    let best: Conversation | null = null
    for (const c of this.convos.values()) {
      if (c.id === currentId || c.messages.length === 0) continue
      if (!best || c.updatedAt > best.updatedAt) best = c
    }
    return best
  }

  delete(id: string): void {
    if (this.convos.delete(id)) this.persist()
  }

  /** Id of the most recently updated conversation, for launch restore. */
  lastActive(): string | null {
    let best: Conversation | null = null
    for (const c of this.convos.values()) {
      if (!best || c.updatedAt > best.updatedAt) best = c
    }
    return best?.id ?? null
  }

  /** Explicit search across saved chats; never injected automatically. */
  search(query: string, limit = SEARCH_LIMIT): ConversationSearchHit[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    const lowerQuery = trimmed.toLowerCase()
    const tokens = lowerQuery.split(/\s+/).filter(Boolean)
    const hits: ConversationSearchHit[] = []

    for (const conv of this.convos.values()) {
      let best: ConversationSearchHit | null = null
      const titleScore = scoreText(conv.title, lowerQuery, tokens)
      conv.messages.forEach((message, index) => {
        const bodyScore = scoreText(message.text, lowerQuery, tokens)
        const score = titleScore + bodyScore
        if (score <= 0) return
        const excerptSource = message.text.trim() || conv.title
        const hit: ConversationSearchHit = {
          conversationId: conv.id,
          title: conv.title,
          summary: conv.summary,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          continuesFromId: conv.continuesFromId ?? null,
          role: message.role,
          messageIndex: index,
          excerpt: compactExcerpt(excerptSource, trimmed),
          score
        }
        if (!best || hit.score > best.score) best = hit
      })

      if (!best && titleScore > 0) {
        best = {
          conversationId: conv.id,
          title: conv.title,
          summary: conv.summary,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          continuesFromId: conv.continuesFromId ?? null,
          role: 'user',
          messageIndex: 0,
          excerpt: compactExcerpt(conv.title, trimmed),
          score: titleScore
        }
      }
      if (best) hits.push(best)
    }

    return hits
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(50, Math.trunc(limit) || SEARCH_LIMIT)))
  }
}
