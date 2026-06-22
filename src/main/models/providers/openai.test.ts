import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeOpenAi, streamOpenAiPlain, runOpenAiToolLoop, titleOpenAi } from './openai'
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
    expect(body.reasoning).toEqual({ effort: 'medium' })
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
    expect(body.reasoning).toEqual({ effort: 'high' })
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
    expect(body.reasoning).toEqual({ effort: 'low' })
  })
})
