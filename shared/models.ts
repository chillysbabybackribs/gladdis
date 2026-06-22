// 'openai' is a key slot for the text-to-speech feature (audible replies)
// and now also a fully supported chat model provider for modern OpenAI models.
// 'grok' (xAI) is a real chat provider, reached over xAI's OpenAI-compatible API.
export type Provider = 'anthropic' | 'google' | 'codex' | 'openai' | 'grok'

/**
 * Whether the model has been seen working against its provider as of the last
 * audit, or is a forward-looking placeholder the user added in anticipation.
 * Speculative entries still work the moment the provider ships them — the flag
 * is purely informational so the picker can surface a "may not exist yet"
 * tooltip instead of letting the user pick blind.
 */
export type ModelAvailability = 'verified' | 'speculative'

export interface ModelOption {
  id: string // provider model id, e.g. claude-opus-4-8 / gemini-3.5-flash
  label: string
  provider: Provider
  availability?: ModelAvailability
}

/**
 * Fallback selectable models. Codex entries are replaced at runtime by the live
 * CLI catalog when available, so they don't need an availability annotation.
 *
 * `availability: 'speculative'` marks IDs whose existence with the provider
 * has not been independently confirmed; the picker shows a "preview" pill so
 * the user knows a 404 is on the table. Flip them to `'verified'` (or drop
 * the field) once the provider has shipped the model.
 */
export const MODELS: ModelOption[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', availability: 'speculative' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', availability: 'speculative' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', availability: 'speculative' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google', availability: 'speculative' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', availability: 'verified' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', availability: 'verified' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', provider: 'google', availability: 'verified' },
  { id: 'grok-4.3', label: 'Grok 4.3', provider: 'grok', availability: 'speculative' },
  { id: 'grok-build-0.1', label: 'Grok Build 0.1', provider: 'grok', availability: 'speculative' },
  { id: 'openai-gpt-5.5', label: 'GPT 5.5', provider: 'openai', availability: 'verified' },
  { id: 'openai-gpt-5.4', label: 'GPT 5.4', provider: 'openai', availability: 'verified' },
  { id: 'openai-gpt-5.4-pro', label: 'GPT 5.4 Pro', provider: 'openai', availability: 'verified' },
  { id: 'openai-gpt-5.4-mini', label: 'GPT 5.4 Mini', provider: 'openai', availability: 'verified' },
  { id: 'openai-gpt-5.4-nano', label: 'GPT 5.4 Nano', provider: 'openai', availability: 'verified' },
  { id: 'openai-gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai', availability: 'verified' },
  { id: 'openai-gpt-4-1-mini', label: 'GPT-4.1 Mini', provider: 'openai', availability: 'verified' },
  { id: 'gpt-5.5', label: 'Codex · GPT-5.5', provider: 'codex' },
  { id: 'gpt-5.4', label: 'Codex · GPT-5.4', provider: 'codex' },
  { id: 'gpt-5.4-mini', label: 'Codex · GPT-5.4 Mini', provider: 'codex' },
  { id: 'gpt-5.3-codex', label: 'Codex · GPT-5.3-Codex', provider: 'codex' },
  { id: 'gpt-5.3-codex-spark', label: 'Codex · GPT-5.3-Codex Spark', provider: 'codex' },
  { id: 'gpt-5.2', label: 'Codex · GPT-5.2', provider: 'codex' }
]
