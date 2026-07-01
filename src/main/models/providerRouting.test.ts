import { describe, expect, it, vi } from 'vitest'

vi.mock('./agentLoopRunner', () => ({
  runProviderAgenticTurn: vi.fn(async ({ loop, supervisor }: any) => loop(supervisor))
}))

vi.mock('./providers/openai', () => ({
  streamOpenAiPlain: vi.fn(),
  runOpenAiToolLoop: vi.fn(async () => undefined)
}))

vi.mock('./providers/anthropic', () => ({
  streamAnthropicPlain: vi.fn(),
  runAnthropicToolLoop: vi.fn(async () => undefined)
}))

vi.mock('./providers/google', () => ({
  streamGooglePlain: vi.fn(),
  runGoogleToolLoop: vi.fn(async () => undefined)
}))

vi.mock('./providers/grok', () => ({
  streamGrokPlain: vi.fn(),
  runGrokToolLoop: vi.fn(async () => undefined)
}))

import { AgentConfigurationService } from './AgentConfigurationService'
import { dispatchAgenticTurn } from './providerRouting'

function makeAgentConfig() {
  const tools = {
    getWorkspaceRoot: () => '/home/user/project',
    tabs: { liveTabId: vi.fn((id?: string | null) => id ?? 'tab-1') },
    calibrationBlock: vi.fn(() => '## Tool calibration')
  } as any
  return new AgentConfigurationService(tools, {} as any, vi.fn())
}

describe('providerRouting contract trace', () => {
  it('emits the shared browser + filesystem tool surface for OpenAI agentic turns', async () => {
    const emit = vi.fn()
    const req = {
      requestId: 'req-1',
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'check the current docs site and then update the parser code' }]
    } as any

    await dispatchAgenticTurn({
      req,
      model: { id: 'gpt-5', label: 'GPT-5', provider: 'openai' } as any,
      signal: new AbortController().signal,
      client: 'test-key',
      maxOutputTokens: 512,
      deps: {
        tools: {} as any,
        agentConfig: makeAgentConfig(),
        audit: {} as any,
        emit,
        emitLoopState: vi.fn(),
        logSystemPrompt: vi.fn(),
        buildToolContext: vi.fn(() => ({} as any))
      }
    })

    const trace = emit.mock.calls
      .map((call) => call[0])
      .find((event) => event?.type === 'contract_trace')

    expect(trace).toBeTruthy()
    expect(trace.provider).toBe('openai')
    expect(trace.profile).toBe('full')
    expect(trace.tools).toEqual(expect.arrayContaining([
      'search',
      'navigate',
      'grep_page',
      'search_files',
      'read_file',
      'edit_file'
    ]))
    expect(trace.toolCount).toBe(trace.tools.length)
  })
})
