import { app } from 'electron'
import { appendFile, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type {
  ModelCallEvent,
  ModelCallRecord,
  ModelCallStatus,
  Provider
} from '../../../shared/types'

const MAX_MEMORY_RECORDS = 500

interface BeginModelCall {
  requestId?: string
  conversationId?: string | null
  provider: Provider
  modelId: string
  stage: string
  input: unknown
}

interface FinishModelCall {
  output?: unknown
  status?: Exclude<ModelCallStatus, 'running'>
  error?: unknown
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningOutputTokens?: number
  }
}

interface ActiveModelCall {
  id: string
  addOutput: (chunk: unknown) => void
  finish: (result?: FinishModelCall) => void
}

/**
 * Append-only model call audit ledger. It observes model traffic and never
 * participates in execution decisions.
 */
export class ModelCallLedger {
  private readonly records = new Map<string, ModelCallRecord>()
  private readonly order: string[] = []
  private readonly file = join(app.getPath('userData'), 'gladdis-model-calls.jsonl')

  constructor(private readonly emit: (event: ModelCallEvent) => void) {}

  list(): ModelCallRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  begin(call: BeginModelCall): ActiveModelCall {
    const inputText = stringifyForAudit(call.input)
    const now = Date.now()
    const id = `mc-${now}-${Math.random().toString(36).slice(2)}`
    const record: ModelCallRecord = {
      id,
      requestId: call.requestId,
      conversationId: call.conversationId,
      provider: call.provider,
      modelId: call.modelId,
      stage: call.stage,
      status: 'running',
      startedAt: now,
      inputChars: inputText.length,
      outputChars: 0,
      inputTokensEstimate: estimateTokens(inputText.length),
      outputTokensEstimate: 0
    }
    this.store(record)
    this.emit({ type: 'started', record })

    let outputChars = 0
    let finished = false
    return {
      id,
      addOutput: (chunk: unknown) => {
        if (finished) return
        outputChars += stringifyForAudit(chunk).length
        const next = this.patch(id, {
          outputChars,
          outputTokensEstimate: estimateTokens(outputChars)
        })
        if (next) this.emit({ type: 'updated', record: next })
      },
      finish: (result: FinishModelCall = {}) => {
        if (finished) return
        finished = true
        const finalOutputChars =
          result.output == null ? outputChars : stringifyForAudit(result.output).length
        const endedAt = Date.now()
        const next = this.patch(id, {
          status: result.status ?? (result.error ? 'error' : 'ok'),
          endedAt,
          latencyMs: endedAt - now,
          outputChars: finalOutputChars,
          outputTokensEstimate: estimateTokens(finalOutputChars),
          inputTokensActual: result.usage?.inputTokens,
          outputTokensActual: result.usage?.outputTokens,
          cachedInputTokensActual: result.usage?.cachedInputTokens,
          reasoningOutputTokensActual: result.usage?.reasoningOutputTokens,
          error: result.error ? errorMessage(result.error) : undefined
        })
        if (!next) return
        this.emit({ type: 'updated', record: next })
        this.persist(next)
      }
    }
  }

  private store(record: ModelCallRecord): void {
    this.records.set(record.id, record)
    this.order.push(record.id)
    while (this.order.length > MAX_MEMORY_RECORDS) {
      const dropped = this.order.shift()
      if (dropped) this.records.delete(dropped)
    }
  }

  private patch(id: string, patch: Partial<ModelCallRecord>): ModelCallRecord | null {
    const prior = this.records.get(id)
    if (!prior) return null
    const next = { ...prior, ...patch }
    this.records.set(id, next)
    return next
  }

  private persist(record: ModelCallRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFile(this.file, JSON.stringify(record) + '\n', { mode: 0o600 }, (err) => {
        if (err) console.warn('[audit] failed to persist model call:', err)
      })
    } catch (err) {
      console.warn('[audit] failed to persist model call:', err)
    }
  }
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function stringifyForAudit(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
