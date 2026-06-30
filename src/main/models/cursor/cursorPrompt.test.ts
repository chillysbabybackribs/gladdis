import { describe, expect, it, beforeEach } from 'vitest'
import { formatCursorConversationPrompt, clearCursorPromptCache } from './cursorPrompt'

describe('formatCursorConversationPrompt', () => {
  beforeEach(() => {
    clearCursorPromptCache()
  })

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

  it('omits conversation history when resuming an existing Cursor session', () => {
    const prompt = formatCursorConversationPrompt(
      [
        { role: 'user', content: 'find the cursor client' },
        { role: 'assistant', content: 'It lives in src/main/models/cursor/CursorClient.ts.' },
        { role: 'user', content: 'add tests for it' }
      ],
      'add tests for it',
      { includeHistory: false }
    )

    expect(prompt).toBe('add tests for it')
    expect(prompt).not.toContain('[Conversation history]')
  })

  describe('caching', () => {
    it('returns consistent results for identical message arrays', () => {
      const messages = [
        { role: 'user' as const, content: 'first message' },
        { role: 'assistant' as const, content: 'first response' },
        { role: 'user' as const, content: 'second message' }
      ]

      const first = formatCursorConversationPrompt(messages, 'second message')
      const second = formatCursorConversationPrompt(messages, 'second message')
      expect(first).toBe(second)
    })

    it('recomputes when messages change', () => {
      const firstPrompt = formatCursorConversationPrompt(
        [
          { role: 'user', content: 'message one' },
          { role: 'assistant', content: 'response one' }
        ],
        'response one'
      )

      const secondPrompt = formatCursorConversationPrompt(
        [
          { role: 'user', content: 'message one' },
          { role: 'assistant', content: 'response one' },
          { role: 'user', content: 'message two' }
        ],
        'message two'
      )

      expect(secondPrompt).toContain('message one')
      expect(secondPrompt).toContain('response one')
      expect(secondPrompt).toContain('message two')
    })

    it('handles content changes with same message lengths', () => {
      const firstPrompt = formatCursorConversationPrompt(
        [{ role: 'user', content: 'hello world' }],
        'hello world'
      )

      const secondPrompt = formatCursorConversationPrompt(
        [{ role: 'user', content: 'goodbye now' }],
        'goodbye now'
      )

      // Same length but different content should produce different results
      expect(secondPrompt).toBe('goodbye now')
    })

    it('does not reuse cached prior history when same-length turns change content', () => {
      const firstPrompt = formatCursorConversationPrompt(
        [
          { role: 'user', content: 'alpha bravo' },
          { role: 'assistant', content: 'delta echo' },
          { role: 'user', content: 'final ask one' }
        ],
        'final ask one'
      )
      expect(firstPrompt).toContain('User: alpha bravo')
      expect(firstPrompt).toContain('Assistant: delta echo')

      const secondPrompt = formatCursorConversationPrompt(
        [
          { role: 'user', content: 'kappa sigma' },
          { role: 'assistant', content: 'omega zulu' },
          { role: 'user', content: 'final ask two' }
        ],
        'final ask two'
      )

      expect(secondPrompt).toContain('User: kappa sigma')
      expect(secondPrompt).toContain('Assistant: omega zulu')
      expect(secondPrompt).not.toContain('alpha bravo')
      expect(secondPrompt).not.toContain('delta echo')
    })

    it('respects the 12-turn history limit', () => {
      const messages = Array.from({ length: 15 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `msg${i.toString().padStart(2, '0')}`
      }))

      const prompt = formatCursorConversationPrompt(messages, 'msg14')

      // Should only include last 12 turns (messages 3-14, indices 3-14)
      expect(prompt).not.toContain('msg00')
      expect(prompt).not.toContain('msg01')
      expect(prompt).not.toContain('msg02')
      expect(prompt).toContain('msg03')
      expect(prompt).toContain('msg14')
    })

    it('updates cache when new messages are added to existing history', () => {
      // First call with 3 messages
      const prompt1 = formatCursorConversationPrompt(
        [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'response to first' },
          { role: 'user', content: 'second' }
        ],
        'second'
      )
      expect(prompt1).toContain('first')
      expect(prompt1).toContain('response to first')

      // Second call adds 2 more messages - cache should update
      const prompt2 = formatCursorConversationPrompt(
        [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'response to first' },
          { role: 'user', content: 'second' },
          { role: 'assistant', content: 'response to second' },
          { role: 'user', content: 'third' }
        ],
        'third'
      )
      expect(prompt2).toContain('second')
      expect(prompt2).toContain('response to second')
      expect(prompt2).toContain('[Current request]\nthird')
    })
  })
})
