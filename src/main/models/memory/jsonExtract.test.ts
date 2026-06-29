import { describe, expect, it } from 'vitest'
import { extractJsonObject } from './jsonExtract'

describe('extractJsonObject', () => {
  it('parses clean JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips markdown json fences', () => {
    const text = 'sure!\n```json\n{ "answer": 42 }\n```\n'
    expect(extractJsonObject(text)).toEqual({ answer: 42 })
  })

  it('handles ``` fences without a language tag', () => {
    const text = '```\n{"k":"v"}\n```'
    expect(extractJsonObject(text)).toEqual({ k: 'v' })
  })

  it('extracts the first balanced { ... } block from prose', () => {
    const text = 'Here you go: { "x": 1, "y": [1,2,3] } trailing prose'
    expect(extractJsonObject(text)).toEqual({ x: 1, y: [1, 2, 3] })
  })

  it('returns null on garbage', () => {
    expect(extractJsonObject('completely not json')).toBeNull()
  })

  it('returns null on truncated JSON', () => {
    expect(extractJsonObject('{ "incomplete": ')).toBeNull()
  })

  it('handles braces inside strings', () => {
    const text = '{ "text": "this has } in it", "ok": true }'
    expect(extractJsonObject(text)).toEqual({ text: 'this has } in it', ok: true })
  })

  it('handles escaped quotes', () => {
    const text = '{ "msg": "she said \\"hi\\"" }'
    expect(extractJsonObject(text)).toEqual({ msg: 'she said "hi"' })
  })
})
