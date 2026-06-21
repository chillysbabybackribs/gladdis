import type { Message } from '../components/chatTypes'

export function previousTurnAttachedActivePage(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') continue
    return Boolean(
      message.parts?.some((part) =>
        part.kind === 'contract' && part.trace.activePage?.included === true
      )
    )
  }
  return false
}
