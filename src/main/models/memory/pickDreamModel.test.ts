import { describe, expect, it } from 'vitest'
import { pickDreamModel, providerAvailable } from './pickDreamModel'
import type { KeyStatus } from '../../../../shared/types'

const NO_KEYS: KeyStatus = {
  anthropic: false,
  google: false,
  codex: false,
  cursor: false,
  openai: false,
  grok: false
}

describe('pickDreamModel', () => {
  it('returns null when no provider is configured', () => {
    expect(pickDreamModel(NO_KEYS)).toBeNull()
  })

  it('prefers Codex when available under the cheapest policy', () => {
    const picked = pickDreamModel({ ...NO_KEYS, codex: true, openai: true })
    expect(picked).not.toBeNull()
    expect(picked!.provider).toBe('codex')
  })

  it('falls through to a configured provider when Codex is not available', () => {
    const picked = pickDreamModel({ ...NO_KEYS, google: true, openai: false })
    expect(picked).not.toBeNull()
    // Should land on the cheapest Gemini Flash family entry first.
    expect(picked!.provider).toBe('google')
    expect(picked!.id.startsWith('gemini-')).toBe(true)
  })

  it("'best' policy picks Opus when Anthropic is keyed", () => {
    const picked = pickDreamModel(
      { ...NO_KEYS, anthropic: true, codex: true, google: true },
      { preferenceOrder: 'best' }
    )
    expect(picked).not.toBeNull()
    expect(picked!.provider).toBe('anthropic')
    expect(picked!.id).toBe('claude-opus-4-8')
  })

  it("'best' policy falls through to lower tiers when premium providers are not keyed", () => {
    const picked = pickDreamModel(
      { ...NO_KEYS, codex: true },
      { preferenceOrder: 'best' }
    )
    expect(picked).not.toBeNull()
    expect(picked!.provider).toBe('codex')
  })

  it('honors a pinned modelId when its provider is keyed', () => {
    const picked = pickDreamModel(
      { ...NO_KEYS, anthropic: true },
      { modelId: 'claude-sonnet-4-6' }
    )
    expect(picked).not.toBeNull()
    expect(picked!.id).toBe('claude-sonnet-4-6')
  })

  it('refuses to pin a modelId whose provider is not keyed', () => {
    const picked = pickDreamModel(NO_KEYS, { modelId: 'claude-sonnet-4-6' })
    expect(picked).toBeNull()
  })

  it('returns null for an unknown modelId', () => {
    const picked = pickDreamModel(
      { ...NO_KEYS, anthropic: true },
      { modelId: 'does-not-exist' }
    )
    expect(picked).toBeNull()
  })

  it('accepts dynamic Codex models from the live catalog', () => {
    const picked = pickDreamModel(
      { ...NO_KEYS, codex: true },
      {
        modelId: 'live-codex-model',
        dynamicCodexModels: [
          { id: 'live-codex-model', label: 'Live Codex', provider: 'codex' }
        ]
      }
    )
    expect(picked).not.toBeNull()
    expect(picked!.id).toBe('live-codex-model')
  })
})

describe('providerAvailable', () => {
  it('reflects each key flag', () => {
    expect(providerAvailable({ ...NO_KEYS, codex: true }, 'codex')).toBe(true)
    expect(providerAvailable({ ...NO_KEYS, anthropic: true }, 'anthropic')).toBe(true)
    expect(providerAvailable({ ...NO_KEYS, google: true }, 'google')).toBe(true)
    expect(providerAvailable({ ...NO_KEYS, openai: true }, 'openai')).toBe(true)
    expect(providerAvailable({ ...NO_KEYS, grok: true }, 'grok')).toBe(true)
    expect(providerAvailable(NO_KEYS, 'codex')).toBe(false)
  })
})
