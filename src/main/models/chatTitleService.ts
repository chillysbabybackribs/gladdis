import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import type { ModelOption } from '../../../shared/types'
import type { ModelCallLedger } from './ModelCallLedger'
import { titleAnthropic } from './providers/anthropic'
import { titleGoogle } from './providers/google'
import { titleGrok } from './providers/grok'
import { titleOpenAi } from './providers/openai'

const MAX_TITLE_TURNS = 4
const MAX_TITLE_CHARS_PER_TURN = 500

export interface ChatTitleDeps {
  audit: ModelCallLedger
  anthropic: () => Anthropic
  google: () => GoogleGenAI
  openAiKey: () => string
  grokKey: () => string
  claudeCodeComplete: (
    modelId: string,
    system: string,
    user: string
  ) => Promise<string>
}

/**
 * Produce a short (≤6 word) conversation title from its first few messages
 * via one cheap, non-streaming call. Returns null on any failure (including
 * codex-only sessions, which have no shared title call) so the caller can
 * fall back to the first-message title.
 *
 * Tool chips are ignored — only the user/assistant text matters for a title.
 */
export async function generateChatTitle(args: {
  model: ModelOption
  messages: { role: string; text: string }[]
  deps: ChatTitleDeps
}): Promise<string | null> {
  const { model, messages, deps } = args
  // A couple of turns is plenty of signal and keeps the call tiny/cheap.
  const transcript = messages
    .slice(0, MAX_TITLE_TURNS)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.text.slice(0, MAX_TITLE_CHARS_PER_TURN)}`)
    .join('\n')
  const instruction =
    'Write a concise title (3-6 words, Title Case, no quotes, no trailing punctuation) ' +
    'for this conversation. Reply with the title only.\n\n' +
    transcript
  try {
    // Codex titles via a cheap provider call aren't available; fall back to
    // the first-message title (return null) for codex-only sessions.
    if (model.provider === 'codex') return null
    const raw = await dispatchTitle(model, instruction, deps)
    const title = raw.trim().replace(/^["'\s]+|["'\s.]+$/g, '').replace(/\s+/g, ' ')
    return title || null
  } catch (e) {
    console.warn('[chats] title generation failed:', e)
    return null
  }
}

async function dispatchTitle(model: ModelOption, prompt: string, deps: ChatTitleDeps): Promise<string> {
  const { audit } = deps
  const modelId = model.id
  switch (model.provider) {
    case 'anthropic':
      return titleAnthropic({ client: deps.anthropic(), audit, modelId, prompt })
    case 'google':
      return titleGoogle({ ai: deps.google(), audit, modelId, prompt })
    case 'openai':
      return titleOpenAi({ apiKey: deps.openAiKey(), audit, modelId, prompt })
    case 'grok':
      return titleGrok({ apiKey: deps.grokKey(), audit, modelId, prompt })
    case 'claudecode':
      return deps.claudeCodeComplete(
        modelId,
        'Write a concise title (3-6 words, Title Case, no quotes, no trailing punctuation). Reply with the title only.',
        prompt
      )
    default:
      throw new Error(`title generation not supported for provider ${model.provider}`)
  }
}
