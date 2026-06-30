/**
 * Pick which model runs the dreaming pipeline. The order is intentional and
 * user-overridable:
 *
 *   • 'cheapest' (default): Codex first (no per-token API spend if the user is
 *     logged into their Codex plan), then cheap OpenAI/Gemini-Flash tiers,
 *     then Grok cheap, Anthropic Haiku, mid-tier, and only Opus as a last
 *     resort. This is exactly what the user steered toward in the brainstorm.
 *
 *   • 'best': inverted — top-end models first (Opus, GPT-5.5, Gemini Pro,
 *     Sonnet, Grok 4) and falls back through the cheaper tiers if nothing
 *     premium is keyed.
 *
 * The picker filters by which providers are currently usable (KeyStore.status
 * for API keys; the same shape reports Codex CLI install+auth as `codex`).
 * It returns null only when no provider at all is available, which the caller
 * surfaces as an actionable error rather than choosing silently.
 */

import { MODELS, type KeyStatus, type ModelOption, type Provider } from '../../../../shared/types'
import type { DreamPreferenceOrder } from '../../../../shared/dream'

const CHEAPEST_ORDER: readonly string[] = [
  // Codex — "free" relative to API calls (uses the user's existing Codex plan)
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.4',
  'gpt-5.5',
  // Cheap OpenAI API models
  'openai-gpt-5.4-nano',
  'openai-gpt-4o-mini',
  'openai-gpt-4-1-mini',
  'openai-gpt-5.4-mini',
  // Gemini Flash family
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  // Grok cheap
  'grok-build-0.1',
  // Anthropic cheap → mid
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  // High end as last resort
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'openai-gpt-5.4',
  'openai-gpt-5.5',
  'grok-4.3',
  'claude-opus-4-8'
] as const

const BEST_ORDER: readonly string[] = [
  'claude-opus-4-8',
  'openai-gpt-5.5',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'openai-gpt-5.4-pro',
  'claude-sonnet-4-6',
  'grok-4.3',
  // Mid tier
  'openai-gpt-5.4',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'claude-haiku-4-5',
  // Cheap as fallback
  'openai-gpt-5.4-mini',
  'openai-gpt-4-1-mini',
  'openai-gpt-4o-mini',
  'gemini-2.5-flash-lite',
  'grok-build-0.1',
  // Codex last when the user asked for "best"
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex'
] as const

export interface PickDreamModelOptions {
  preferenceOrder?: DreamPreferenceOrder
  /** Pin a specific model id; bypasses the preference order. */
  modelId?: string
  /** Live Codex catalog from the app-server, in addition to the static MODELS. */
  dynamicCodexModels?: ModelOption[]
}

/** Return the chosen model, or null when no configured provider can serve. */
export function pickDreamModel(
  keyStatus: KeyStatus,
  options: PickDreamModelOptions = {}
): ModelOption | null {
  if (options.modelId) {
    const explicit = findModel(options.modelId, options.dynamicCodexModels)
    if (!explicit) return null
    return providerAvailable(keyStatus, explicit.provider) ? explicit : null
  }

  const order = options.preferenceOrder === 'best' ? BEST_ORDER : CHEAPEST_ORDER
  for (const id of order) {
    const model = findModel(id, options.dynamicCodexModels)
    if (!model) continue
    if (!providerAvailable(keyStatus, model.provider)) continue
    return model
  }

  // Nothing in the curated list matched — fall through to any-available.
  const all: ModelOption[] = [...MODELS, ...(options.dynamicCodexModels ?? [])]
  for (const model of all) {
    if (providerAvailable(keyStatus, model.provider)) return model
  }
  return null
}

export function providerAvailable(keyStatus: KeyStatus, provider: Provider): boolean {
  switch (provider) {
    case 'codex':
      return keyStatus.codex
    case 'claudecode':
      return false
    case 'cursor':
      return false
    case 'anthropic':
      return keyStatus.anthropic
    case 'google':
      return keyStatus.google
    case 'openai':
      return keyStatus.openai
    case 'grok':
      return keyStatus.grok
    default: {
      const _exhaustive: never = provider
      return _exhaustive
    }
  }
}

function findModel(id: string, dynamicCodexModels?: ModelOption[]): ModelOption | undefined {
  return MODELS.find((m) => m.id === id) ?? dynamicCodexModels?.find((m) => m.id === id)
}
