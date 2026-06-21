import { describe, expect, it } from 'vitest'
import { applyStreamEventToMessages } from './useStreamConsumer'
import type { Message } from '../components/chatTypes'

describe('applyStreamEventToMessages', () => {
  it('routes stream events to the targeted assistant message', () => {
    const messages: Message[] = [
      { id: 'user-a', role: 'user', text: 'first' },
      { id: 'assistant-a', role: 'assistant', text: 'alpha', parts: [{ kind: 'text', text: 'alpha' }] },
      { id: 'user-b', role: 'user', text: 'second' },
      { id: 'assistant-b', role: 'assistant', text: 'beta', parts: [{ kind: 'text', text: 'beta' }] }
    ]

    const next = applyStreamEventToMessages(messages, {
      requestId: 'req-b',
      assistantMessageId: 'assistant-b',
      type: 'contract_trace',
      profile: 'browser',
      tools: ['read_page'],
      activePage: { included: true, reason: 'active-page-followup' }
    })

    expect(next[1]).toEqual(messages[1])
    expect(next[3].parts).toEqual([
      { kind: 'text', text: 'beta' },
      {
        kind: 'contract',
        trace: {
          profile: 'browser',
          tools: ['read_page'],
          activePage: { included: true, reason: 'active-page-followup' },
          workspace: undefined,
          codexCwd: undefined,
          inputs: undefined
        }
      }
    ])
  })

  it('does not fall back to the latest assistant when a target id is missing', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: 'alpha', parts: [{ kind: 'text', text: 'alpha' }] }
    ]

    const next = applyStreamEventToMessages(messages, {
      requestId: 'req-missing',
      assistantMessageId: 'assistant-missing',
      type: 'delta',
      text: ' wrong turn'
    })

    expect(next).toBe(messages)
  })

  it('keeps the legacy trailing-assistant fallback for untargeted events', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: 'alpha', parts: [{ kind: 'text', text: 'alpha' }] }
    ]

    const next = applyStreamEventToMessages(messages, {
      requestId: 'legacy-req',
      type: 'delta',
      text: ' tail'
    })

    expect(next[0].text).toBe('alpha tail')
    expect(next[0].parts).toEqual([{ kind: 'text', text: 'alpha tail' }])
  })

  it('keeps tool timing on the matching assistant message', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: '', parts: [] }
    ]

    const withCall = applyStreamEventToMessages(messages, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'tool_call',
      tool: 'fetch_page',
      args: { url: 'https://example.com' },
      callId: 'call-1',
      startedAt: 1000
    })
    const withResult = applyStreamEventToMessages(withCall, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'tool_result',
      callId: 'call-1',
      ok: true,
      endedAt: 4250,
      durationMs: 3250,
      preview: 'Example'
    })

    expect(withResult[0].parts).toEqual([
      {
        kind: 'tool',
        tool: {
          callId: 'call-1',
          tool: 'fetch_page',
          args: { url: 'https://example.com' },
          status: 'ok',
          startedAt: 1000,
          endedAt: 4250,
          durationMs: 3250,
          preview: 'Example'
        }
      }
    ])
  })
})
