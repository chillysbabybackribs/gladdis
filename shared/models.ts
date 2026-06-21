// 'openai' is used ONLY as a KeyStore slot for the text-to-speech feature
// (audible replies). It is never a chat model provider — no ModelOption carries
// it — so the provider branches in ChatService/ModelPicker never see it.
// 'grok' (xAI) is a real chat provider, reached over xAI's OpenAI-compatible API.
export type Provider = 'anthropic' | 'google' | 'codex' | 'openai' | 'grok'

export interface ModelOption {
  id: string // provider model id, e.g. claude-opus-4-8 / gemini-3.5-flash
  label: string
  provider: Provider
}

/**
 * Fallback selectable models. Codex entries are replaced at runtime by the live
 * CLI catalog when available.
 */
export const MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google' },
  { id: 'grok-4.3', label: 'Grok 4.3', provider: 'grok' },
  { id: 'grok-build-0.1', label: 'Grok Build 0.1', provider: 'grok' },
  { id: 'gpt-5.5', label: 'Codex · GPT-5.5', provider: 'codex' },
  { id: 'gpt-5.4', label: 'Codex · GPT-5.4', provider: 'codex' },
  { id: 'gpt-5.4-mini', label: 'Codex · GPT-5.4 Mini', provider: 'codex' },
  { id: 'gpt-5.3-codex', label: 'Codex · GPT-5.3-Codex', provider: 'codex' },
  { id: 'gpt-5.3-codex-spark', label: 'Codex · GPT-5.3-Codex Spark', provider: 'codex' },
  { id: 'gpt-5.2', label: 'Codex · GPT-5.2', provider: 'codex' }
]
