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
    expect(next[0].parts).toEqual([{ kind: 'text', text: 'alpha' }])
    expect(next[0].liveText).toBe(' tail')
    expect(next[0].liveTextSegments).toEqual([' tail'])
  })

  it('keeps streaming prose out of parts until a structural event needs ordering', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: 'alpha', parts: [{ kind: 'text', text: 'alpha' }] }
    ]

    const withDelta = applyStreamEventToMessages(messages, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'delta',
      text: ' beta'
    })

    expect(withDelta[0].parts).toEqual([{ kind: 'text', text: 'alpha' }])
    expect(withDelta[0].liveText).toBe(' beta')
    expect(withDelta[0].liveTextSegments).toEqual([' beta'])

    const withTool = applyStreamEventToMessages(withDelta, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'tool_call',
      tool: 'memory_read',
      args: { scope: 'workspace' },
      callId: 'tool-1'
    })

    expect(withTool[0].parts).toEqual([
      { kind: 'text', text: 'alpha beta' },
      {
        kind: 'tool',
        tool: {
          callId: 'tool-1',
          tool: 'memory_read',
          args: { scope: 'workspace' },
          status: 'running',
          startedAt: undefined
        }
      }
    ])
    expect(withTool[0].liveText).toBeUndefined()
    expect(withTool[0].liveTextSegments).toBeUndefined()
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

  it('preserves tool screenshots on the matching assistant message', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: '', parts: [] }
    ]

    const withCall = applyStreamEventToMessages(messages, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'tool_call',
      tool: 'screenshot_app',
      args: {},
      callId: 'shot-1'
    })
    const withResult = applyStreamEventToMessages(withCall, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'tool_result',
      callId: 'shot-1',
      ok: true,
      preview: 'Screenshot captured.',
      imageDataUrl: 'data:image/png;base64,abc123'
    })

    expect(withResult[0].parts).toEqual([
      {
        kind: 'tool',
        tool: {
          callId: 'shot-1',
          tool: 'screenshot_app',
          args: {},
          status: 'ok',
          startedAt: undefined,
          endedAt: undefined,
          durationMs: undefined,
          preview: 'Screenshot captured.',
          imageDataUrl: 'data:image/png;base64,abc123'
        }
      }
    ])
  })

  it('appends loop, capability, verification, and task-memory events as ordered parts', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: 'alpha', parts: [{ kind: 'text', text: 'alpha' }] }
    ]

    const withLoop = applyStreamEventToMessages(messages, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'loop_state',
      taskId: 'task-1',
      event: 'task_started',
      phase: 'inspect',
      iteration: 1,
      summary: 'Starting task.'
    })
    const withCapability = applyStreamEventToMessages(withLoop, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'capability_activity',
      callId: 'cap-1',
      capability: 'repo_overview',
      event: 'capability_cache_hit',
      cached: true,
      summary: 'Used cached repo card.'
    })
    const withVerification = applyStreamEventToMessages(withCapability, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'verification_state',
      event: 'verification_failed',
      check: 'typecheck',
      status: 'fail',
      summary: 'Type errors found.'
    })
    const withMemory = applyStreamEventToMessages(withVerification, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'task_memory',
      event: 'memory_write',
      scope: 'task',
      keys: ['summary'],
      summary: 'Stored current blocker.'
    })

    expect(withMemory[0].parts).toEqual([
      { kind: 'text', text: 'alpha' },
      {
        kind: 'loop_state',
        taskId: 'task-1',
        event: 'task_started',
        phase: 'inspect',
        iteration: 1,
        reason: undefined,
        summary: 'Starting task.'
      },
      {
        kind: 'capability_activity',
        callId: 'cap-1',
        capability: 'repo_overview',
        event: 'capability_cache_hit',
        service: undefined,
        summary: 'Used cached repo card.',
        cached: true,
        artifactId: undefined,
        durationMs: undefined
      },
      {
        kind: 'verification_state',
        event: 'verification_failed',
        check: 'typecheck',
        status: 'fail',
        summary: 'Type errors found.',
        rawLogArtifactId: undefined
      },
      {
        kind: 'task_memory',
        event: 'memory_write',
        scope: 'task',
        keys: ['summary'],
        summary: 'Stored current blocker.',
        artifactId: undefined
      }
    ])
  })

  it('materializes any trailing live text when the turn ends', () => {
    const messages: Message[] = [
      {
        id: 'assistant-a',
        role: 'assistant',
        text: 'alpha beta',
        parts: [{ kind: 'text', text: 'alpha' }],
        liveText: ' beta',
        liveTextSegments: [' beta']
      }
    ]

    const next = applyStreamEventToMessages(messages, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'done',
      text: 'alpha beta'
    } as any)

    expect(next[0].parts).toEqual([{ kind: 'text', text: 'alpha beta' }])
    expect(next[0].liveText).toBeUndefined()
    expect(next[0].liveTextSegments).toBeUndefined()
  })

  it('seals long streaming prose into bounded markdown segments at paragraph breaks', () => {
    const messages: Message[] = [
      { id: 'assistant-a', role: 'assistant', text: '', parts: [] }
    ]

    const longParagraph = `${'a'.repeat(1300)}\n\n${'b'.repeat(50)}`
    const next = applyStreamEventToMessages(messages, {
      requestId: 'req-a',
      assistantMessageId: 'assistant-a',
      type: 'delta',
      text: longParagraph
    })

    expect(next[0].liveText).toBe(longParagraph)
    expect(next[0].liveTextSegments).toEqual([
      `${'a'.repeat(1300)}\n\n`,
      'b'.repeat(50)
    ])
  })
})
