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

/** Format recent Gladdis chat history for the Cursor Agent CLI prompt body. */
export function formatCursorConversationPrompt(
  messages: ChatMessage[],
  latestUserText: string
): string {
  const recent = messages.slice(-HISTORY_TURNS)
  const last = recent[recent.length - 1]
  const currentText = last?.role === 'user' ? summarizeMessage(last) : latestUserText.trim()
  const prior = last?.role === 'user' ? recent.slice(0, -1) : recent

  const priorLines = prior
    .map((m) => {
      const label = m.role === 'assistant' ? 'Assistant' : 'User'
      const text = summarizeMessage(m)
      return text ? `${label}: ${text}` : null
    })
    .filter(Boolean)

  if (!priorLines.length) return currentText || latestUserText.trim()

  const transcript = priorLines.join('\n\n')
  return `[Conversation history]\n${transcript}\n\n[Current request]\n${currentText}`
}
