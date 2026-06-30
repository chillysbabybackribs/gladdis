import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../../../../shared/types'
import { currentDatePreamble, withDateContext, prependDateContextToText } from './dateContext'

const FIXED = new Date('2026-06-29T12:00:00Z')

describe('currentDatePreamble', () => {
  it('states the human-readable current date', () => {
    const text = currentDatePreamble(FIXED)
    expect(text).toContain('2026')
    expect(text).toContain('June')
  })

  it('tells the model its training data is stale and to search for time-sensitive info', () => {
    const text = currentDatePreamble(FIXED)
    expect(text.toLowerCase()).toContain('training data is older')
    expect(text.toLowerCase()).toContain('search the web')
  })

  it('tells the model to frame dated facts relative to today', () => {
    const text = currentDatePreamble(FIXED)
    expect(text.toLowerCase()).toContain('relative to today')
    expect(text.toLowerCase()).toContain('as of')
  })
})

describe('withDateContext', () => {
  it('prepends the preamble to the latest user message only', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest question' }
    ]
    const out = withDateContext(messages, FIXED)
    expect(out[0].content).toBe('first') // earlier user turn untouched
    expect(out[1].content).toBe('reply') // assistant untouched
    expect(out[2].content).toContain('2026')
    expect(out[2].content.endsWith('latest question')).toBe(true)
  })

  it('does not mutate the input array or its messages', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    const out = withDateContext(messages, FIXED)
    expect(messages[0].content).toBe('hi')
    expect(out).not.toBe(messages)
    expect(out[0]).not.toBe(messages[0])
  })

  it('uses the preamble alone when the latest user message is empty', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '' }]
    const out = withDateContext(messages, FIXED)
    expect(out[0].content).toBe(currentDatePreamble(FIXED))
  })

  it('returns the array unchanged when there is no user message', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'system note' }]
    const out = withDateContext(messages, FIXED)
    expect(out).toBe(messages)
  })
})

describe('prependDateContextToText', () => {
  it('prepends the date preamble to the given text', () => {
    const text = 'What is the latest version of React?'
    const result = prependDateContextToText(text, FIXED)
    expect(result).toContain('2026')
    expect(result).toContain('June')
    expect(result).toContain('What is the latest version of React?')
    expect(result.startsWith('[Current date:')).toBe(true)
  })

  it('returns just the preamble when text is empty', () => {
    const result = prependDateContextToText('', FIXED)
    expect(result).toBe(currentDatePreamble(FIXED))
  })

  it('tells the model to search for time-sensitive info', () => {
    const result = prependDateContextToText('What is the latest news?', FIXED)
    expect(result.toLowerCase()).toContain('training data is older')
    expect(result.toLowerCase()).toContain('search the web')
  })
})
