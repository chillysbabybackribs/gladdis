import { afterEach, describe, expect, it } from 'vitest'
import { __testInternals, estimatePromptInputChars } from './promptAuditCache'

afterEach(() => __testInternals.reset())

describe('estimatePromptInputChars', () => {
  it('reuses the cached prefix size for repeated turns with the same tool block', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'search_repo',
          description: 'Search the workspace.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      }
    ]

    const first = estimatePromptInputChars({
      system: 'Use surgical file reads.',
      tools,
      dynamic: [{ role: 'user', content: 'first turn' }]
    })
    const second = estimatePromptInputChars({
      system: 'Use surgical file reads.',
      tools,
      dynamic: [{ role: 'user', content: 'second turn' }]
    })

    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    expect(__testInternals.getState()).toEqual({ promptPrefixComputeCount: 1 })
  })

  it('recomputes the prefix size when the resolved tool set changes', () => {
    const baseTools = [
      {
        type: 'function',
        function: {
          name: 'search_repo',
          description: 'Search the workspace.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      }
    ]
    const expandedTools = [
      ...baseTools,
      {
        type: 'function',
        function: {
          name: 'read_spans',
          description: 'Read file spans.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
      }
    ]

    estimatePromptInputChars({
      system: 'Use surgical file reads.',
      tools: baseTools,
      dynamic: [{ role: 'user', content: 'turn one' }]
    })
    estimatePromptInputChars({
      system: 'Use surgical file reads.',
      tools: expandedTools,
      dynamic: [{ role: 'user', content: 'turn two' }]
    })

    expect(__testInternals.getState()).toEqual({ promptPrefixComputeCount: 2 })
  })
})
