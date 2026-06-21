import type { CodexAppServer } from './CodexAppServer'
import type { ThreadTokenUsage } from './protocol'

const DEFAULT_COMPACT_INPUT_TOKENS = 48_000
const DEFAULT_COMPACT_CONTEXT_RATIO = 0.55
const COMPACTION_TIMEOUT_MS = 90_000

interface CompactionWaiter {
  resolve: () => void
  timer: NodeJS.Timeout
}

export class ThreadCompactor {
  private usage = new Map<string, ThreadTokenUsage>()
  private compacting = new Map<string, Promise<void>>()
  private waiters = new Map<string, CompactionWaiter>()

  record(threadId: string, tokenUsage: ThreadTokenUsage): void {
    this.usage.set(threadId, tokenUsage)
  }

  schedule(server: CodexAppServer | null, threadId: string | null): void {
    if (!server || !server.running || !threadId || this.compacting.has(threadId)) return
    const reason = this.reason(threadId)
    if (!reason) return

    const promise = new Promise<void>((resolve) => {
      const done = (): void => {
        const waiter = this.waiters.get(threadId)
        if (waiter) clearTimeout(waiter.timer)
        this.waiters.delete(threadId)
        resolve()
      }
      const timer = setTimeout(done, COMPACTION_TIMEOUT_MS)
      this.waiters.set(threadId, { resolve: done, timer })
      server.request('thread/compact/start', { threadId }, 20_000).catch((err) => {
        console.warn('[codex] thread/compact/start failed:', err instanceof Error ? err.message : err)
        done()
      })
    }).finally(() => {
      this.compacting.delete(threadId)
    })
    this.compacting.set(threadId, promise)
    if (process.env.GLADDIS_CODEX_DEBUG) console.log(`[codex] compacting ${threadId}: ${reason}`)
  }

  async wait(threadId: string): Promise<void> {
    const pending = this.compacting.get(threadId)
    if (!pending) return
    await Promise.race([pending, sleep(8_000)])
  }

  finish(threadId: string | undefined): void {
    if (!threadId) return
    this.waiters.get(threadId)?.resolve()
  }

  dispose(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.waiters.clear()
    this.compacting.clear()
  }

  private reason(threadId: string): string | null {
    const usage = this.usage.get(threadId)
    if (!usage) return null
    const lastInput = usage.last?.inputTokens ?? 0
    const threshold = numberEnv('GLADDIS_CODEX_COMPACT_INPUT_TOKENS', DEFAULT_COMPACT_INPUT_TOKENS)
    if (lastInput >= threshold) return `last input ${lastInput} >= ${threshold}`
    const window = usage.modelContextWindow ?? 0
    const ratio = numberEnv('GLADDIS_CODEX_COMPACT_CONTEXT_RATIO', DEFAULT_COMPACT_CONTEXT_RATIO)
    if (window > 0 && lastInput / window >= ratio) {
      return `last input ${(lastInput / window).toFixed(2)} of context window`
    }
    return null
  }
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
