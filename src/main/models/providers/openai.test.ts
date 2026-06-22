import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __testInternals,
  completeOpenAi,
  streamOpenAiPlain,
  runOpenAiToolLoop,
  titleOpenAi
} from './openai'
import type { ChatRequest } from '../../../../shared/types'

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
