import { afterEach, describe, expect, it } from 'vitest'
import { __testInternals, summarizeTrimmedToolResult } from './toolResultSummary'

afterEach(() => __testInternals.resetSummaryCaches())

describe('summarizeTrimmedToolResult cache', () => {
  it('reuses the cached summary for the same tool_call_id', () => {
    const text = 'src/main/models/providers/openai.ts:785 export function stubOldOpenAiResults'

    const first = summarizeTrimmedToolResult(text, 'call-1')
    const second = summarizeTrimmedToolResult(`${text}\nchanged later but should not matter for same id`, 'call-1')

    expect(second).toBe(first)
    expect(__testInternals.getSummaryCacheState()).toEqual({
      idEntries: 1,
      hashEntries: 1,
      computeCount: 1
    })
  })

  it('reuses the cached summary for identical content across tool call ids', () => {
    const text = JSON.stringify({
      status: 200,
      path: 'src/main/models/providers/openai.ts',
      line: 785,
      items: [{ title: 'stubOldOpenAiResults' }]
    })

    const first = summarizeTrimmedToolResult(text, 'call-a')
    const second = summarizeTrimmedToolResult(text, 'call-b')

    expect(second).toBe(first)
    expect(__testInternals.getSummaryCacheState()).toEqual({
      idEntries: 2,
      hashEntries: 1,
      computeCount: 1
    })
  })
})
