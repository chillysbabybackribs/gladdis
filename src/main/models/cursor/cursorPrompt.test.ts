import { describe, expect, it } from 'vitest'
import { formatCursorConversationPrompt } from './cursorPrompt'

describe('formatCursorConversationPrompt', () => {
  it('returns the lone user message verbatim', () => {
    expect(
      formatCursorConversationPrompt([{ role: 'user', content: 'hello' }], 'hello')
    ).toBe('hello')
  })

  it('embeds prior turns and keeps the latest user request separate', () => {
    const prompt = formatCursorConversationPrompt(
      [
        { role: 'user', content: 'find the cursor client' },
        { role: 'assistant', content: 'It lives in src/main/models/cursor/CursorClient.ts.' },
        { role: 'user', content: 'add tests for it' }
      ],
      'add tests for it'
    )

    expect(prompt).toContain('[Conversation history]')
    expect(prompt).toContain('User: find the cursor client')
    expect(prompt).toContain('Assistant: It lives in src/main/models/cursor/CursorClient.ts.')
    expect(prompt).toContain('[Current request]\nadd tests for it')
  })

  it('preserves active-page preambles from the renderer history slice', () => {
    const prompt = formatCursorConversationPrompt(
      [
        {
          role: 'user',
          content: '[Active page: Example — https://example.com]\n\nwhat is the headline?'
        }
      ],
      'what is the headline?'
    )

    expect(prompt).toContain('[Active page: Example — https://example.com]')
    expect(prompt).toContain('what is the headline?')
  })

  it('uses latestUserText as the current request when history does not end on a user turn', () => {
    const prompt = formatCursorConversationPrompt(
      [{ role: 'assistant', content: 'partial stream' }],
      'continue from here'
    )

    expect(prompt).toContain('[Conversation history]\nAssistant: partial stream')
    expect(prompt).toContain('[Current request]\ncontinue from here')
  })

  it('notes image-only turns as [image] so they are not silently dropped', () => {
    const prompt = formatCursorConversationPrompt(
      [
        { role: 'user', content: '', images: ['data:image/png;base64,abc'] },
        { role: 'user', content: 'what is in this screenshot?' }
      ],
      'what is in this screenshot?'
    )

    expect(prompt).toContain('User: [image]')
    expect(prompt).toContain('[Current request]\nwhat is in this screenshot?')
  })
})
