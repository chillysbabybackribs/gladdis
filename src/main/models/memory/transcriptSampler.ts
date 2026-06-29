/**
 * Pick conversations from the ChatStore for a dream job, scope them by recency,
 * and render them into LLM-friendly transcript text. Bounded by a hard char
 * cap so a runaway workspace cannot accidentally bill against a 30M-token
 * context.
 */

import type { ChatStore } from '../ChatStore'
import type { Conversation } from '../../../../shared/types'
import type { DreamScope } from '../../../../shared/dream'

/** Hard upper bound on transcripts shipped to a single stage. */
export const TRANSCRIPT_CHAR_CEILING = 250_000

/** Per-turn excerpt cap so very long tool outputs do not crowd out other turns. */
const TURN_EXCERPT_CHARS = 1_200

const MS_PER_DAY = 86_400_000

export interface SampledTranscripts {
  /** Rendered transcript text ready to ship to the extract stage. */
  text: string
  /** Conversation IDs included, for the diff's audit trail. */
  conversationIds: string[]
  /** Cumulative char count of `text`. */
  chars: number
  /** True if the ceiling forced us to drop older conversations from the sample. */
  truncated: boolean
}

export function scopeToMaxAgeMs(scope: DreamScope, now: number = Date.now()): number | null {
  switch (scope) {
    case '24h': return MS_PER_DAY
    case '7d': return 7 * MS_PER_DAY
    case '30d': return 30 * MS_PER_DAY
    case 'all': return null
    default: {
      const exhaustive: never = scope
      return exhaustive
    }
  }
}

/** Sort newest-updated first, filter by scope, then trim to the char ceiling. */
export function sampleTranscripts(
  chats: ChatStore,
  scope: DreamScope,
  options: { now?: number; ceiling?: number } = {}
): SampledTranscripts {
  const now = options.now ?? Date.now()
  const ceiling = options.ceiling ?? TRANSCRIPT_CHAR_CEILING
  const maxAgeMs = scopeToMaxAgeMs(scope, now)

  const metas = chats.list()
  const candidates: Conversation[] = []
  for (const meta of metas) {
    if (maxAgeMs !== null && now - meta.updatedAt > maxAgeMs) continue
    const full = chats.get(meta.id)
    if (full && full.messages.length > 0) candidates.push(full)
  }

  // Newest first — ChatStore.list already sorts by updatedAt desc, but be defensive.
  candidates.sort((a, b) => b.updatedAt - a.updatedAt)

  let chars = 0
  let truncated = false
  const includedIds: string[] = []
  const sections: string[] = []

  for (const conv of candidates) {
    const rendered = renderConversation(conv)
    if (chars + rendered.length > ceiling && includedIds.length > 0) {
      truncated = true
      break
    }
    if (rendered.length > ceiling) {
      // Single huge conversation: include only its head so the dreamer at
      // least sees its identity rather than skipping it entirely.
      sections.push(rendered.slice(0, ceiling))
      includedIds.push(conv.id)
      chars += ceiling
      truncated = true
      break
    }
    sections.push(rendered)
    includedIds.push(conv.id)
    chars += rendered.length
  }

  return {
    text: sections.join('\n\n---\n\n'),
    conversationIds: includedIds,
    chars,
    truncated
  }
}

function renderConversation(conv: Conversation): string {
  const header = `### Conversation ${conv.id} — "${conv.title}"\n` +
    `updated: ${new Date(conv.updatedAt).toISOString()} (turns: ${conv.messages.length})`
  const body = conv.messages
    .map((m, i) => {
      const role = m.role === 'assistant' ? 'Assistant' : 'User'
      const text = clip(m.text || '', TURN_EXCERPT_CHARS)
      const tools = (m.tools ?? [])
        .map((t) => `    · ${t.tool} (${t.status})${t.preview ? `: ${clip(t.preview, 240)}` : ''}`)
        .join('\n')
      return `#${i} ${role}: ${text}${tools ? `\n${tools}` : ''}`
    })
    .join('\n')
  return `${header}\n${body}`
}

function clip(text: string, max: number): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}
