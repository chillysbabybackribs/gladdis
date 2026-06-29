import { describe, expect, it } from 'vitest'
import { sampleTranscripts, scopeToMaxAgeMs } from './transcriptSampler'
import type { ChatStore } from '../ChatStore'
import type { Conversation, ConversationMeta } from '../../../../shared/types'

function mkConv(id: string, ageMs: number, now: number, body: string[] = ['hello world']): Conversation {
  return {
    id,
    title: `Conv ${id}`,
    createdAt: now - ageMs,
    updatedAt: now - ageMs,
    messages: body.map((text, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text
    }))
  }
}

function fakeStore(convs: Conversation[]): ChatStore {
  const list = (): ConversationMeta[] =>
    convs
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }))
  const get = (id: string): Conversation | null => convs.find((c) => c.id === id) ?? null
  return { list, get } as unknown as ChatStore
}

describe('scopeToMaxAgeMs', () => {
  it('returns finite windows for 24h / 7d / 30d', () => {
    const now = Date.now()
    expect(scopeToMaxAgeMs('24h', now)).toBe(86_400_000)
    expect(scopeToMaxAgeMs('7d', now)).toBe(7 * 86_400_000)
    expect(scopeToMaxAgeMs('30d', now)).toBe(30 * 86_400_000)
  })
  it('returns null for all-time', () => {
    expect(scopeToMaxAgeMs('all')).toBeNull()
  })
})

describe('sampleTranscripts', () => {
  const now = new Date('2026-06-29T12:00:00Z').getTime()
  const hour = 3_600_000
  const day = 24 * hour

  it('drops conversations older than the scope window', () => {
    const store = fakeStore([
      mkConv('young', hour, now),
      mkConv('mid', 3 * day, now),
      mkConv('old', 10 * day, now)
    ])
    const sample = sampleTranscripts(store, '24h', { now })
    expect(sample.conversationIds).toEqual(['young'])
    expect(sample.truncated).toBe(false)
  })

  it('keeps everything when scope is "all"', () => {
    const store = fakeStore([
      mkConv('a', day, now),
      mkConv('b', 30 * day, now),
      mkConv('c', 100 * day, now)
    ])
    const sample = sampleTranscripts(store, 'all', { now })
    expect(sample.conversationIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('returns newest-first ordering inside the window', () => {
    const store = fakeStore([
      mkConv('older', 5 * day, now),
      mkConv('newer', day, now)
    ])
    const sample = sampleTranscripts(store, '7d', { now })
    expect(sample.conversationIds).toEqual(['newer', 'older'])
  })

  it('flags truncation when the char ceiling is reached', () => {
    const big = 'x'.repeat(400) // single rendered message
    const store = fakeStore([
      mkConv('a', hour, now, [big, big, big]),
      mkConv('b', 2 * hour, now, [big, big, big]),
      mkConv('c', 3 * hour, now, [big, big, big])
    ])
    const sample = sampleTranscripts(store, '24h', { now, ceiling: 600 })
    expect(sample.truncated).toBe(true)
    expect(sample.conversationIds.length).toBeGreaterThan(0)
  })

  it('renders conversation IDs into the text body for evidence citation', () => {
    const store = fakeStore([mkConv('conv-abc', hour, now, ['first message', 'second one'])])
    const sample = sampleTranscripts(store, '24h', { now })
    expect(sample.text).toContain('conv-abc')
    expect(sample.text).toContain('first message')
  })
})
