import type { ChatStreamEvent } from '../../shared/types'

type SendFn = (event: ChatStreamEvent) => void

// The renderer already coalesces stream paints to one commit per animation
// frame. Keep the main-process IPC window shorter than a frame so we still
// trim token-chatter without adding another full-frame of visible lag first.
const DEFAULT_FLUSH_MS = 8

function deltaKey(event: Extract<ChatStreamEvent, { type: 'delta' }>): string {
  return `${event.requestId}:${event.assistantMessageId ?? ''}`
}

/**
 * Coalesces adjacent text deltas before they cross Electron IPC. The renderer
 * already batches DOM work per frame; this trims the remaining per-token
 * main/preload/renderer listener overhead without changing ordering around
 * tool, error, or completion events.
 */
export class ChatStreamIpcBatcher {
  private readonly pending = new Map<string, Extract<ChatStreamEvent, { type: 'delta' }>>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: SendFn,
    private readonly flushMs = DEFAULT_FLUSH_MS
  ) {}

  push(event: ChatStreamEvent): void {
    if (event.type === 'delta') {
      const key = deltaKey(event)
      const prior = this.pending.get(key)
      if (prior) prior.text += event.text
      else this.pending.set(key, { ...event })
      this.ensureFlushTimer()
      return
    }

    this.flushRequest(event.requestId)
    this.send(event)
  }

  flushAll(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.size === 0) return
    for (const [key, event] of this.pending) {
      this.pending.delete(key)
      this.send(event)
    }
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushAll()
    }, this.flushMs)
  }

  private flushRequest(requestId: string): void {
    for (const [key, event] of this.pending) {
      if (event.requestId !== requestId) continue
      this.pending.delete(key)
      this.send(event)
    }
    if (this.pending.size === 0 && this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
