import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __testInternals,
  completeOpenAi,
  streamOpenAiPlain,
  runOpenAiToolLoop,
  stubOldOpenAiResults,
  titleOpenAi,
  toOpenAiMessages
} from './openai'
import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import type { ToolDef } from '../browserTools'

/** Build a fake ReadableStream that yields the given SSE text in one chunk. */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { value: undefined, done: true }
          sent = true
          return { value: bytes, done: false }
        },
        cancel: async () => {},
        releaseLock: () => {}
      }
    }
  } as never
}

function fakeAudit() {
  const finish = vi.fn()
  const addOutput = vi.fn()
  const begin = vi.fn(() => ({ addOutput, finish }))
  return { audit: { begin } as never, begin, addOutput, finish }
}

afterEach(() => vi.unstubAllGlobals())

describe('completeOpenAi', () => {
  it('posts an OpenAI-shaped body and returns the message content with developer role', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi there' } }] })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit, finish } = fakeAudit()

    const text = await completeOpenAi({
      apiKey: 'openai-test',
      audit,
      modelId: 'openai-gpt-5.5',
      system: 'be brief',
      user: 'hello',
      maxOutputTokens: 100,
      stage: 'complete'
    })

    expect(text).toBe('hi there')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('gpt-5.5')
    expect(body.reasoning_effort).toBe('medium')
    expect(body.reasoning).toBeUndefined()
    expect(body.messages).toEqual([
      { role: 'developer', content: 'be brief' },
      { role: 'user', content: 'hello' }
    ])
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer openai-test')
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ output: 'hi there' }))
  })

  it('correctly maps reasoning effort and max_completion_tokens for reasoning models', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit } = fakeAudit()

    await completeOpenAi({
      apiKey: 'openai-test',
      audit,
      modelId: 'openai-gpt-5.4',
      system: 'sys',
      user: 'hi',
      maxOutputTokens: 100,
      stage: 'plan'
    })

    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('gpt-5.4')
    expect(body.reasoning_effort).toBe('high')
    expect(body.reasoning).toBeUndefined()
    expect(body.max_completion_tokens).toBe(100)
    expect(body.max_tokens).toBeUndefined()
  })
})

describe('titleOpenAi', () => {
  it('creates a clean title payload', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Beautiful Title' } }] })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit } = fakeAudit()

    const title = await titleOpenAi({
      apiKey: 'openai-test',
      audit,
      modelId: 'openai-gpt-5.5',
      prompt: 'summarize this chat'
    })

    expect(title).toBe('Beautiful Title')
    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('gpt-5.5')
    expect(body.reasoning_effort).toBe('low')
    expect(body.reasoning).toBeUndefined()
  })
})

describe('openAiBody (reasoning_effort + tools compatibility)', () => {
  const { openAiBody } = __testInternals
  const messages = [{ role: 'user' as const, content: 'hi' }]
  const toolDef = [{ type: 'function', function: { name: 't', description: '', parameters: {} } }]

  it('omits reasoning_effort for gpt-5.4-nano when function tools are present', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.4-nano',
      messages,
      tools: toolDef,
      stage: 'chat:browser:0',
      maxTokens: 200
    })
    expect(body.model).toBe('gpt-5.4-nano')
    expect(body.tools).toEqual(toolDef)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.max_completion_tokens).toBe(200)
  })

  it('omits reasoning_effort for gpt-5.5-mini when function tools are present', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.5-mini',
      messages,
      tools: toolDef,
      stage: 'chat:browser:0'
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('omits reasoning_effort for full-size gpt-5.4 when function tools are present', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.4',
      messages,
      tools: toolDef,
      stage: 'chat:browser:0'
    })
    expect(body.model).toBe('gpt-5.4')
    expect(body.tools).toEqual(toolDef)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('omits reasoning_effort for gpt-5.4-pro when function tools are present', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.4-pro',
      messages,
      tools: toolDef,
      stage: 'chat:browser:0'
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('keeps reasoning_effort for gpt-5.4-nano when no tools are present', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.4-nano',
      messages,
      stage: 'chat:browser:0'
    })
    expect(body.reasoning_effort).toBe('medium')
  })

  it('keeps reasoning_effort for full-size gpt-5.4 when no tools are present', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.4',
      messages,
      stage: 'plan'
    })
    expect(body.reasoning_effort).toBe('high')
  })

  it('keeps reasoning_effort for full-size gpt-5.5 even with tools', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-5.5',
      messages,
      tools: toolDef,
      stage: 'chat:browser:0'
    })
    expect(body.reasoning_effort).toBe('medium')
    expect(body.tools).toEqual(toolDef)
  })

  it('maps legacy gpt-4-1-mini id to the OpenAI api model name', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-4-1-mini',
      messages,
      stage: 'chat:plain',
      maxTokens: 100
    })
    expect(body.model).toBe('gpt-4.1-mini')
    expect(body.max_tokens).toBe(100)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('caps max_tokens for gpt-4o-mini below the global agent ceiling', () => {
    const body = openAiBody({
      modelId: 'openai-gpt-4o-mini',
      messages,
      stage: 'chat:browser:0',
      maxTokens: 32_000,
      tools: toolDef
    })
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.max_tokens).toBe(16_384)
  })
})

describe('toOpenAiMessages with history compaction', () => {
  it('does not touch messages when total count is within maxMessages', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`
    }))
    const req: ChatRequest = { requestId: 'test-req-1', modelId: 'openai-test', messages }
    const result = toOpenAiMessages(req)

    expect(result.length).toBe(10)
    expect(result[0].content).toBe('msg 0')
    // The latest user turn carries the current-date freshness preamble; its
    // original text is preserved at the end. Earlier turns are untouched.
    expect(result[9].content).toContain('Current date:')
    expect(typeof result[9].content === 'string' && result[9].content.endsWith('msg 9')).toBe(true)
  })

  it('compacts messages when total count exceeds maxMessages', () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `msg ${i}`
    }))
    const req: ChatRequest = { requestId: 'test-req-1', modelId: 'openai-test', messages }
    const result = toOpenAiMessages(req, { maxMessages: 10, keepTail: 4 })

    // Expected: 1 notice + 4 tail messages = 5 messages
    expect(result.length).toBe(5)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toContain('[Trimmed 11 earlier messages; keeping the last 4 verbatim.]')

    // Verbatim tail messages preserved: msg 11, msg 12, msg 13, msg 14
    expect(result[1].content).toBe('msg 11')
    expect(result[2].content).toBe('msg 12')
    expect(result[3].content).toBe('msg 13')
    // The latest user turn (msg 14) leads with the current-date preamble; the
    // preamble is added before compaction so it always lands in the kept tail.
    expect(result[4].content).toContain('Current date:')
    expect(typeof result[4].content === 'string' && result[4].content.endsWith('msg 14')).toBe(true)
  })
})

describe('runOpenAiToolLoop', () => {
  it('emits a matching tool_result event even when tool execution throws', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_watch","type":"function","function":{"name":"watch_network","arguments":"{}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Done."}}]}\n' +
        'data: [DONE]\n'
    ]

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sseBody(frames.shift() ?? 'data: [DONE]\n')
    })))

    const { audit } = fakeAudit()
    const events: ChatStreamEvent[] = []
    const run = vi.fn(async () => {
      throw new Error('simulated tool crash')
    })

    const req: ChatRequest = {
      requestId: 'openai-tool-error-1',
      modelId: 'openai-gpt-5.5',
      messages: [{ role: 'user', content: 'watch api' }]
    }

    const toolDefs: ToolDef[] = [
      {
        name: 'watch_network',
        description: 'network capture',
        parameters: { type: 'object', properties: {} }
      }
    ]

    await runOpenAiToolLoop({
      apiKey: 'openai-test',
      audit,
      emit: (evt) => events.push(evt),
      req,
      modelId: 'openai-gpt-5.5',
      signal: new AbortController().signal,
      tools: { run } as never,
      ctx: { tabId: 'tab-1', fullResults: new Map() },
      toolDefs,
      agentSystem: 'sys',
      workspaceBlock: null,
      maxTokens: 100,
      keepResults: 5
    })

    const toolCallEvents = events.filter((evt) => evt.type === 'tool_call')
    const toolResultEvents = events.filter((evt) => evt.type === 'tool_result')

    expect(toolCallEvents).toHaveLength(1)
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0].callId).toBe(toolCallEvents[0].callId)
    expect(toolResultEvents[0].ok).toBe(false)
    expect(toolResultEvents[0].preview).toContain('simulated tool crash')

    const secondCallInit = vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit | undefined
    if (!secondCallInit) throw new Error('Expected model to run a follow-up turn')
    const secondBody = JSON.parse(String(secondCallInit.body))
    const toolMessages = (secondBody.messages ?? []).filter((msg: any) => msg.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0].tool_call_id).toBe('call_watch')
  })

  it('blocks broad OpenAI read_file calls on code paths until a repo narrowing tool runs', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/main/models/providers/openai.ts\\"}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Done."}}]}\n' +
        'data: [DONE]\n'
    ]

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sseBody(frames.shift() ?? 'data: [DONE]\n')
    })))

    const { audit } = fakeAudit()
    const events: ChatStreamEvent[] = []
    const run = vi.fn(async () => ({ ok: true, text: 'should not be reached' }))

    await runOpenAiToolLoop({
      apiKey: 'openai-test',
      audit,
      emit: (evt) => events.push(evt),
      req: {
        requestId: 'openai-read-policy-1',
        modelId: 'openai-gpt-5.5',
        messages: [{ role: 'user', content: 'inspect openai provider' }]
      },
      modelId: 'openai-gpt-5.5',
      signal: new AbortController().signal,
      tools: { run } as never,
      ctx: {
        tabId: 'tab-1',
        workspaceRoot: '/workspace/project',
        fullResults: new Map()
      },
      toolDefs: [
        { name: 'read_file', description: 'read file', parameters: { type: 'object', properties: {} } },
        { name: 'search_files', description: 'search files', parameters: { type: 'object', properties: {} } }
      ],
      agentSystem: 'sys',
      workspaceBlock: null,
      maxTokens: 100,
      keepResults: 5
    })

    expect(run).not.toHaveBeenCalled()
    const toolResult = events.find((evt) => evt.type === 'tool_result')
    expect(toolResult?.ok).toBe(false)
    expect(toolResult?.preview).toContain('OpenAI local-work policy')
    expect(toolResult?.preview).toContain('search_files')
    expect(toolResult?.preview).toContain('as the first step')
    expect(toolResult?.preview).toContain('explicit start_line/end_line')
  })

  it('allows direct read_file after search_files has already narrowed the task', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_search","type":"function","function":{"name":"search_files","arguments":"{\\"query\\":\\"runOpenAiToolLoop\\"}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/main/models/providers/openai.ts\\"}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Done."}}]}\n' +
        'data: [DONE]\n'
    ]

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sseBody(frames.shift() ?? 'data: [DONE]\n')
    })))

    const { audit } = fakeAudit()
    const run = vi.fn(async (name: string) => ({ ok: true, text: `${name} ok` }))

    await runOpenAiToolLoop({
      apiKey: 'openai-test',
      audit,
      emit: () => {},
      req: {
        requestId: 'openai-read-policy-2',
        modelId: 'openai-gpt-5.5',
        messages: [{ role: 'user', content: 'inspect openai provider' }]
      },
      modelId: 'openai-gpt-5.5',
      signal: new AbortController().signal,
      tools: { run } as never,
      ctx: {
        tabId: 'tab-1',
        workspaceRoot: '/workspace/project',
        fullResults: new Map()
      },
      toolDefs: [
        { name: 'read_file', description: 'read file', parameters: { type: 'object', properties: {} } },
        { name: 'search_files', description: 'search files', parameters: { type: 'object', properties: {} } }
      ],
      agentSystem: 'sys',
      workspaceBlock: null,
      maxTokens: 100,
      keepResults: 5
    })

    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0][0]).toBe('search_files')
    expect(run.mock.calls[1][0]).toBe('read_file')
  })
})

describe('stubOldOpenAiResults', () => {
  it('keeps an informative text summary in trimmed tool history', () => {
    const msgs = [
      {
        role: 'tool' as const,
        tool_call_id: 'call_search',
        name: 'search_files',
        content:
          'src/main/models/providers/openai.ts:785 export function stubOldOpenAiResults\n' +
          'src/main/models/providers/openai.ts:723 stubOldOpenAiResults(resultMsgs, args.keepResults)\n' +
          'src/main/models/providers/google.ts:539 export async function stubOldGoogleResults'
      },
      { role: 'tool' as const, tool_call_id: 'call_fresh', name: 'read_file', content: 'fresh result' }
    ]

    stubOldOpenAiResults(msgs, 1)

    expect(msgs[0].content).toContain('[trimmed]')
    expect(msgs[0].content).toContain('search_files result summarized')
    expect(msgs[0].content).toContain('openai.ts:785')
    expect(msgs[0].content).toContain('"call_search"')
    expect(msgs[1].content).toBe('fresh result')
  })

  it('extracts useful fields from JSON tool results', () => {
    const msgs = [
      {
        role: 'tool' as const,
        tool_call_id: 'call_json',
        name: 'watch_network',
        content: JSON.stringify({
          status: 200,
          url: 'https://example.com/api/search',
          items: [{ title: 'OpenAI provider', path: 'src/main/models/providers/openai.ts', line: 785 }]
        })
      }
    ]

    stubOldOpenAiResults(msgs, 0)

    expect(msgs[0].content).toContain('status: 200')
    expect(msgs[0].content).toContain('url: https://example.com/api/search')
    expect(msgs[0].content).toContain('items.title: OpenAI provider')
  })

  it('is idempotent once a result has already been trimmed', () => {
    const msgs = [{ role: 'tool' as const, tool_call_id: 'call_once', name: 'search_files', content: 'alpha\nbeta' }]
    stubOldOpenAiResults(msgs, 0)
    const once = msgs[0].content
    stubOldOpenAiResults(msgs, 0)
    expect(msgs[0].content).toBe(once)
  })
})
