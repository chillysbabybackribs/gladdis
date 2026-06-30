import type { ChatMessage } from '../../../../shared/types'

/**
 * Anchor every turn to the real current date. This does two jobs:
 *  1. Tells the model its weights are stale so it searches for time-sensitive
 *     facts instead of recalling them. Weak models (e.g. Gemini 2.5 Flash)
 *     otherwise assume the year is whatever their training cutoff was.
 *  2. Tells the model to frame dated facts relative to today ("as of <date>…")
 *     rather than the present tense, so correct-but-stale info doesn't read as
 *     current. Nothing else in the prompt chain states today's date.
 *
 * This rides on the *current user turn* (not the cached system block) so it can't
 * go stale inside Gemini's 30-min context cache, and so it survives OpenAI/Grok
 * history compaction (the latest user message is always in the kept tail).
 */
export function currentDatePreamble(now: Date = new Date()): string {
  const today = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  return (
    `[Current date: ${today}. Your training data is older than this. For anything ` +
    `time-sensitive — prices, news, releases/versions, "latest", "current", "recent", ` +
    `or "this year" — search the web instead of answering from memory. When you state a ` +
    `fact that was only true as of an earlier date, frame it relative to today (e.g. ` +
    `"as of <date>…", "at the time", "since superseded") rather than in the present tense, ` +
    `so the user isn't misled into thinking dated information is still current.]`
  )
}

/**
 * Return a shallow copy of the conversation with the date/freshness preamble
 * prepended to the latest user message's text. No-op (returns the same array)
 * when there is no user message to attach it to.
 */
export function withDateContext(messages: ChatMessage[], now: Date = new Date()): ChatMessage[] {
  const lastUserIndex = findLastUserIndex(messages)
  if (lastUserIndex === -1) return messages
  const preamble = currentDatePreamble(now)
  return messages.map((m, i) =>
    i === lastUserIndex
      ? { ...m, content: m.content ? `${preamble}\n\n${m.content}` : preamble }
      : m
  )
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/**
 * Prepend the date/freshness preamble to a raw text string.
 * Used for local CLI agents (Cursor, Claude Code, Codex) that don't
 * use the message-array format of API providers.
 */
export function prependDateContextToText(text: string, now: Date = new Date()): string {
  const preamble = currentDatePreamble(now)
  return text ? `${preamble}\n\n${text}` : preamble
}
