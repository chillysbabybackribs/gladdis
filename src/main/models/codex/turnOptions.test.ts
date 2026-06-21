import { afterEach, describe, expect, it } from 'vitest'
import { turnReasoningOverrides } from './turnOptions'
import type { CodexModelEntry } from './protocol'

const ENV_KEYS = ['GLADDIS_CODEX_REASONING_EFFORT', 'GLADDIS_CODEX_REASONING_SUMMARY']

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

const entry = (over: Partial<CodexModelEntry> = {}): CodexModelEntry => ({
  defaultReasoningEffort: 'high',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low' },
    { reasoningEffort: 'medium' },
    { reasoningEffort: 'high' },
    { reasoningEffort: 'xhigh' }
  ],
  ...over
})

describe('turnReasoningOverrides', () => {
  it("honors the model's advertised default reasoning effort", () => {
    // The model recommends high; we must not pin it down to a hardcoded medium.
    expect(turnReasoningOverrides(entry({ defaultReasoningEffort: 'high' })).effort).toBe('high')
    expect(turnReasoningOverrides(entry({ defaultReasoningEffort: 'low' })).effort).toBe('low')
  })

  it('falls back to medium only when the model advertises no default', () => {
    expect(turnReasoningOverrides(entry({ defaultReasoningEffort: undefined })).effort).toBe('medium')
  })

  it('lets an explicit env override win over the model default', () => {
    process.env.GLADDIS_CODEX_REASONING_EFFORT = 'xhigh'
    expect(turnReasoningOverrides(entry({ defaultReasoningEffort: 'low' })).effort).toBe('xhigh')
  })

  it('clamps the advertised default to a supported tier', () => {
    // Model claims a high default but only advertises up to medium: pick the
    // nearest supported tier, never an unsupported one.
    const clamped = turnReasoningOverrides(
      entry({
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }]
      })
    )
    expect(clamped.effort).toBe('medium')
  })
})
