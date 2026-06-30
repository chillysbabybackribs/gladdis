import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDef } from '../browserTools'
import { __testInternals, toAnthropicTools, toOpenAiFunctionTools } from './toolPromptCache'

afterEach(() => __testInternals.reset())

function sampleTools(): ToolDef[] {
  return [
    {
      name: 'search_repo',
      description: 'Search the workspace.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    },
    {
      name: 'read_spans',
      description: 'Read bounded file spans.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  ]
}

describe('toOpenAiFunctionTools', () => {
  it('reuses the adapted tool block for the same resolved tool list', () => {
    const tools = sampleTools()

    const first = toOpenAiFunctionTools(tools)
    const second = toOpenAiFunctionTools(tools)

    expect(second).toBe(first)
    expect(second).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_repo',
          description: 'Search the workspace.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_spans',
          description: 'Read bounded file spans.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
      }
    ])
    expect(__testInternals.getState()).toEqual({
      openAiToolComputeCount: 1,
      anthropicToolComputeCount: 0
    })
  })
})

describe('toAnthropicTools', () => {
  it('reuses the adapted tool block and keeps cache_control on the last tool', () => {
    const tools = sampleTools()

    const first = toAnthropicTools(tools)
    const second = toAnthropicTools(tools)

    expect(second).toBe(first)
    expect(second).toEqual([
      {
        name: 'search_repo',
        description: 'Search the workspace.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
      },
      {
        name: 'read_spans',
        description: 'Read bounded file spans.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        cache_control: { type: 'ephemeral' }
      }
    ])
    expect(__testInternals.getState()).toEqual({
      openAiToolComputeCount: 0,
      anthropicToolComputeCount: 1
    })
  })
})
