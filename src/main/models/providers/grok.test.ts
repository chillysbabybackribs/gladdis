import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeGrok, runGrokToolLoop, stubOldGrokResults, streamGrokPlain } from './grok'
import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import type { ToolDef } from '../browserTools'

/** Audit double that records nothing but satisfies the begin/finish contract. */
function fakeAudit() {
  const finish = vi.fn()
  const addOutput = vi.fn()
  const begin = vi.fn(() => ({ addOutput, finish }))
  return { audit: { begin } as never, begin, addOutput, finish }
}

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
        cancel: async () => {}
      }
    }
  } as never
}

afterEach(() => vi.unstubAllGlobals())

describe('completeGrok', () => {
  it('posts an OpenAI-shaped body and returns the message content', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi there' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit, finish } = fakeAudit()

    const text = await completeGrok({
      apiKey: 'xai-test',
      audit,
      modelId: 'grok-4.3',
      system: 'be brief',
      user: 'hello',
      maxOutputTokens: 100,
      stage: 'complete'
    })

    expect(text).toBe('hi there')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('grok-4.3')
    expect(body.stream).toBe(false)
    expect(body.reasoning_effort).toBe('medium')
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' }
    ])
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai-test')
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ output: 'hi there' }))
  })

  it('uses the xAI conversation header when supplied for prompt cache routing', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit } = fakeAudit()

    await completeGrok({
      apiKey: 'xai-test',
      audit,
      modelId: 'grok-4.3',
      system: 'sys',
      user: 'hi',
      maxOutputTokens: 100,
      stage: 'planner',
      conversationId: 'conv-cache-key'
    })

    const [, init] = fetchSpy.mock.calls[0]
    expect((init.headers as Record<string, string>)['x-grok-conv-id']).toBe('conv-cache-key')
  })

  it('treats grok-latest as a Grok 4.3 reasoning alias', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit } = fakeAudit()

    await completeGrok({
      apiKey: 'xai-test',
      audit,
      modelId: 'grok-latest',
      system: 'sys',
      user: 'hi',
      maxOutputTokens: 100,
      stage: 'pipeline:planner'
    })

    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse(String(init.body))
    // grok-latest resolves to the 4.3 reasoning policy; planning is the high-effort band.
    expect(body.reasoning_effort).toBe('high')
  })

  it('bands reasoning effort by stage: planning high, execution medium, light low', async () => {
    const cases: Array<[string, string]> = [
      ['pipeline:planner', 'high'],
      ['pipeline:replan', 'high'],
      ['planner', 'high'],
      ['chat:browser:2', 'medium'],
      ['complete', 'medium'],
      ['pipeline:final', 'medium'],
      ['chat:plain', 'low'],
      ['title', 'low']
    ]
    for (const [stage, expected] of cases) {
      const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] })
      }))
      vi.stubGlobal('fetch', fetchSpy)
      const { audit } = fakeAudit()
      await completeGrok({ apiKey: 'x', audit, modelId: 'grok-4.3', system: '', user: 'hi', maxOutputTokens: 10, stage })
      const [, init] = fetchSpy.mock.calls[0]
      const body = JSON.parse(String(init.body))
      expect(body.reasoning_effort, `stage ${stage}`).toBe(expected)
    }
  })

  it('throws a descriptive error on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' })))
    const { audit } = fakeAudit()
    await expect(
      completeGrok({ apiKey: 'x', audit, modelId: 'grok-4.3', system: '', user: 'hi', maxOutputTokens: 10, stage: 'complete' })
    ).rejects.toThrow(/401/)
  })
})

describe('streamGrokPlain', () => {
  it('emits a delta per text chunk and finishes with the assembled output', async () => {
    const frames =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n' +
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n' +
      'data: [DONE]\n'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: sseBody(frames) })))
    const { audit, finish } = fakeAudit()
    const events: ChatStreamEvent[] = []
    const req: ChatRequest = {
      requestId: 'r1',
      modelId: 'grok-4.3',
      messages: [{ role: 'user', content: 'hi' }]
    }

    await streamGrokPlain({
      apiKey: 'xai-test',
      audit,
      emit: (e) => events.push(e),
      req,
      modelId: 'grok-4.3',
      signal: new AbortController().signal,
      system: 'sys',
      maxTokens: 100
    })

    expect(events.filter((e) => e.type === 'delta').map((e) => (e as any).text)).toEqual(['Hel', 'lo'])
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    if (!init) throw new Error('expected fetch init')
    const body = JSON.parse(String(init.body))
    expect(body.reasoning_effort).toBe('low')
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ output: 'Hello', usage: { inputTokens: 3, outputTokens: 1 } })
    )
  })
})

describe('runGrokToolLoop', () => {
  it('continues to validation when files were edited and the model tries to stop', async () => {
    const editArgs = JSON.stringify({ path: 'src/a.ts', old_string: 'x', new_string: 'y' })
    const responses = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_edit","type":"function","function":{"name":"edit_file","arguments":' + JSON.stringify(editArgs) + '}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"All done."}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_validate","type":"function","function":{"name":"run_validation","arguments":"{\\"check\\":\\"typecheck\\"}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Validated now."}}]}\n' +
        'data: [DONE]\n'
    ]
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      body: sseBody(responses.shift() ?? 'data: [DONE]\n')
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit } = fakeAudit()
    const events: ChatStreamEvent[] = []
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'edited' })
      .mockResolvedValueOnce({ ok: true, text: 'PASS: npm run typecheck' })
    const req: ChatRequest = {
      requestId: 'r1',
      modelId: 'grok-4.3',
      messages: [{ role: 'user', content: 'edit src/a.ts' }]
    }
    const toolDefs: ToolDef[] = [
      {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'run_validation',
        description: 'validate',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    ]

    await runGrokToolLoop({
      apiKey: 'xai-test',
      audit,
      emit: (e) => events.push(e),
      req,
      modelId: 'grok-4.3',
      signal: new AbortController().signal,
      tools: { run } as never,
      ctx: { tabId: 'tab-1', fullResults: new Map() },
      toolDefs,
      agentSystem: 'sys',
      workspaceBlock: null,
      maxTokens: 100,
      keepResults: 5
    })

    expect(run.mock.calls.map((call) => call[0])).toEqual(['edit_file', 'run_validation'])
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as any).tool)).toEqual([
      'edit_file',
      'run_validation'
    ])
    const thirdInit = fetchSpy.mock.calls[2][1] as RequestInit
    const thirdBody = JSON.parse(String(thirdInit.body))
    expect(JSON.stringify(thirdBody.messages)).toContain('You must call run_validation')
  })

  it('auto-runs typecheck if the model ignores the validation reminder', async () => {
    const editArgs = JSON.stringify({ path: 'src/a.ts', old_string: 'x', new_string: 'y' })
    const responses = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_edit","type":"function","function":{"name":"edit_file","arguments":' + JSON.stringify(editArgs) + '}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"All done."}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Still done."}}]}\n' +
        'data: [DONE]\n'
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: true,
        body: sseBody(responses.shift() ?? 'data: [DONE]\n')
      }))
    )
    const { audit } = fakeAudit()
    const events: ChatStreamEvent[] = []
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'edited' })
      .mockResolvedValueOnce({ ok: true, text: 'PASS: npm run typecheck' })
    const req: ChatRequest = {
      requestId: 'r1',
      modelId: 'grok-4.3',
      messages: [{ role: 'user', content: 'edit src/a.ts' }]
    }
    const toolDefs: ToolDef[] = [
      { name: 'edit_file', description: 'edit', parameters: { type: 'object', properties: {} } },
      { name: 'run_validation', description: 'validate', parameters: { type: 'object', properties: {} } }
    ]

    await runGrokToolLoop({
      apiKey: 'xai-test',
      audit,
      emit: (e) => events.push(e),
      req,
      modelId: 'grok-4.3',
      signal: new AbortController().signal,
      tools: { run } as never,
      ctx: { tabId: 'tab-1', fullResults: new Map() },
      toolDefs,
      agentSystem: 'sys',
      workspaceBlock: null,
      maxTokens: 100,
      keepResults: 5
    })

    expect(run.mock.calls).toEqual([
      ['edit_file', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }, expect.any(Object)],
      ['run_validation', { check: 'typecheck' }, expect.any(Object)]
    ])
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as any).tool)).toEqual([
      'edit_file',
      'run_validation'
    ])
  })

  it('requires repair and another validation pass after validation fails', async () => {
    const editArgs = JSON.stringify({ path: 'src/a.ts', old_string: 'x', new_string: 'broken' })
    const fixArgs = JSON.stringify({ path: 'src/a.ts', old_string: 'broken', new_string: 'fixed' })
    const responses = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_edit","type":"function","function":{"name":"edit_file","arguments":' + JSON.stringify(editArgs) + '}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_validate_fail","type":"function","function":{"name":"run_validation","arguments":"{\\"check\\":\\"typecheck\\"}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Done anyway."}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_fix","type":"function","function":{"name":"edit_file","arguments":' + JSON.stringify(fixArgs) + '}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_validate_pass","type":"function","function":{"name":"run_validation","arguments":"{\\"check\\":\\"typecheck\\"}"}}]}}]}\n' +
        'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"Validated after repair."}}]}\n' +
        'data: [DONE]\n'
    ]
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      body: sseBody(responses.shift() ?? 'data: [DONE]\n')
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { audit } = fakeAudit()
    const events: ChatStreamEvent[] = []
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'edited' })
      .mockResolvedValueOnce({ ok: false, text: 'FAIL: src/a.ts(1,1): Type error' })
      .mockResolvedValueOnce({ ok: true, text: 'fixed' })
      .mockResolvedValueOnce({ ok: true, text: 'PASS: npm run typecheck' })
    const req: ChatRequest = {
      requestId: 'r1',
      modelId: 'grok-4.3',
      messages: [{ role: 'user', content: 'edit src/a.ts' }]
    }
    const toolDefs: ToolDef[] = [
      { name: 'edit_file', description: 'edit', parameters: { type: 'object', properties: {} } },
      { name: 'run_validation', description: 'validate', parameters: { type: 'object', properties: {} } }
    ]

    await runGrokToolLoop({
      apiKey: 'xai-test',
      audit,
      emit: (e) => events.push(e),
      req,
      modelId: 'grok-4.3',
      signal: new AbortController().signal,
      tools: { run } as never,
      ctx: { tabId: 'tab-1', fullResults: new Map() },
      toolDefs,
      agentSystem: 'sys',
      workspaceBlock: null,
      maxTokens: 100,
      keepResults: 5
    })

    expect(run.mock.calls.map((call) => call[0])).toEqual([
      'edit_file',
      'run_validation',
      'edit_file',
      'run_validation'
    ])
    const fourthInit = fetchSpy.mock.calls[3][1] as RequestInit
    const fourthBody = JSON.parse(String(fourthInit.body))
    const messages = JSON.stringify(fourthBody.messages)
    expect(messages).toContain('Validation failed after your code edit')
    expect(messages).toContain('Type error')
  })
})

describe('stubOldGrokResults', () => {
  it('collapses all but the last `keep` tool results, preserving recall ids', () => {
    const msgs = [
      { role: 'tool' as const, tool_call_id: 'a', content: 'old A' },
      { role: 'tool' as const, tool_call_id: 'b', content: 'old B' },
      { role: 'tool' as const, tool_call_id: 'c', content: 'fresh C' }
    ]
    stubOldGrokResults(msgs, 1)
    expect(msgs[0].content).toContain('[trimmed]')
    expect(msgs[0].content).toContain('"a"')
    expect(msgs[1].content).toContain('[trimmed]')
    expect(msgs[2].content).toBe('fresh C')
  })

  it('is idempotent (does not re-stub an already-stubbed result)', () => {
    const msgs = [{ role: 'tool' as const, tool_call_id: 'a', content: 'orig' }]
    stubOldGrokResults(msgs, 0)
    const once = msgs[0].content
    stubOldGrokResults(msgs, 0)
    expect(msgs[0].content).toBe(once)
  })
})
