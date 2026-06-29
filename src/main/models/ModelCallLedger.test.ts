import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const USER_DATA = '/tmp/gladdis-vitest-ledger'
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA }
}))

import { ModelCallLedger } from './ModelCallLedger'

const LEDGER_FILE = join(USER_DATA, 'gladdis-model-calls.jsonl')

/** Minimal persisted record — only the fields the meter and reload touch. */
function record(id: string, convId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    conversationId: convId,
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
    stage: 'chat',
    status: 'ok',
    startedAt: Number(id.replace(/\D/g, '')) || 1,
    inputChars: 0,
    outputChars: 0,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    ...extra
  })
}

beforeEach(() => {
  mkdirSync(USER_DATA, { recursive: true })
})
afterEach(() => {
  rmSync(USER_DATA, { recursive: true, force: true })
})

describe('ModelCallLedger reload', () => {
  it('starts empty when no ledger file exists', () => {
    const ledger = new ModelCallLedger(() => {})
    expect(ledger.list()).toHaveLength(0)
  })

  it('restores persisted records from disk on construction', () => {
    writeFileSync(
      LEDGER_FILE,
      [
        record('mc-1', 'conv-a', { inputTokensActual: 10, outputTokensActual: 5 }),
        record('mc-2', 'conv-a', { inputTokensActual: 20, outputTokensActual: 7 })
      ].join('\n') + '\n'
    )
    const ledger = new ModelCallLedger(() => {})
    const restored = ledger.list()
    expect(restored).toHaveLength(2)
    expect(restored.find((r) => r.id === 'mc-2')?.inputTokensActual).toBe(20)
  })

  it('keeps only the last 500 lines so startup stays bounded', () => {
    const lines: string[] = []
    for (let i = 0; i < 600; i++) lines.push(record(`mc-${i + 1}`, 'conv-a'))
    writeFileSync(LEDGER_FILE, lines.join('\n') + '\n')
    const ledger = new ModelCallLedger(() => {})
    const restored = ledger.list()
    expect(restored).toHaveLength(500)
    // The oldest 100 were dropped; the newest survive.
    expect(restored.some((r) => r.id === 'mc-1')).toBe(false)
    expect(restored.some((r) => r.id === 'mc-600')).toBe(true)
  })

  it('skips a torn trailing line without losing the rest', () => {
    writeFileSync(LEDGER_FILE, record('mc-1', 'conv-a') + '\n' + '{"id":"mc-2","conv') // truncated
    const ledger = new ModelCallLedger(() => {})
    const restored = ledger.list()
    expect(restored).toHaveLength(1)
    expect(restored[0].id).toBe('mc-1')
  })
})
