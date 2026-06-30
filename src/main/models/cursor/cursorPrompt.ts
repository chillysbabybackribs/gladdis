import type { ChatMessage } from '../../../../shared/chat'

const HISTORY_TURNS = 12
const CONTENT_CHAR_LIMIT = 600

function summarizeMessage(message: ChatMessage): string {
  let content = message.content.trim()
  const hasImages = Array.isArray(message.images) && message.images.length > 0
  if (!content && hasImages) return '[image]'
  if (hasImages) content += ' [image]'
  if (content.length > CONTENT_CHAR_LIMIT) return content.slice(0, CONTENT_CHAR_LIMIT) + '…'
  return content
}

/** Create a compact fingerprint of a message for cache comparison. */
function messageFingerprint(m: ChatMessage): string {
  const contentHash = JSON.stringify(summarizeMessage(m))
  const imageHash = Array.isArray(m.images) ? `i${m.images.length}` : ''
  return `${m.role}:${contentHash}:${imageHash}`
}

/** Build a cache key from the last N messages. */
function buildCacheKey(messages: ChatMessage[], turns: number): string {
  const recent = messages.slice(-turns)
  return recent.map(messageFingerprint).join('|')
}

interface CachedPrompt {
  key: string
  priorLines: string[]
  result: string
}

let promptCache: CachedPrompt | null = null

/**
 * Format recent Gladdis chat history for the Cursor Agent CLI prompt body.
 *
 * Optimized with incremental caching: when the message tail matches the previous
 * call, returns the cached result. This avoids re-summarizing the same history
 * on consecutive turns in a conversation.
 */
export function formatCursorConversationPrompt(
  messages: ChatMessage[],
  latestUserText: string,
  options: { includeHistory?: boolean } = {}
): string {
  const includeHistory = options.includeHistory !== false
  const recent = messages.slice(-HISTORY_TURNS)
  const last = recent[recent.length - 1]
  const currentText = last?.role === 'user' ? summarizeMessage(last) : latestUserText.trim()
  const prior = last?.role === 'user' ? recent.slice(0, -1) : recent

  // Fast path: no history needed
  if (!includeHistory || prior.length === 0) {
    return currentText || latestUserText.trim()
  }

  // Check cache: if the prior messages match, reuse the formatted lines
  const cacheKey = buildCacheKey(messages, HISTORY_TURNS)
  let priorLines: string[]

  if (promptCache && promptCache.key === cacheKey) {
    priorLines = promptCache.priorLines
  } else {
    // Cache miss: compute and store
    priorLines = prior
      .map((m) => {
        const label = m.role === 'assistant' ? 'Assistant' : 'User'
        const text = summarizeMessage(m)
        return text ? `${label}: ${text}` : null
      })
      .filter((line): line is string => line !== null)

    promptCache = { key: cacheKey, priorLines, result: '' }
  }

  if (priorLines.length === 0) {
    return currentText || latestUserText.trim()
  }

  const transcript = priorLines.join('\n\n')
  const result = `[Conversation history]\n${transcript}\n\n[Current request]\n${currentText}`

  // Update cache with full result for potential exact match next time
  if (promptCache) {
    promptCache.result = result
  }

  return result
}

/** Clear the conversation prompt cache. Useful for testing. */
export function clearCursorPromptCache(): void {
  promptCache = null
}
