import { describe, expect, it } from 'vitest'
import { parsePlanJson } from './Planner'

describe('Planner JSON parsing', () => {
  it('parses a raw plan object', () => {
    expect(parsePlanJson('{"steps":[]}')).toEqual({ steps: [] })
  })

  it('parses a fenced plan object', () => {
    expect(parsePlanJson('```json\n{"steps":[]}\n```')).toEqual({ steps: [] })
  })

  it('parses a plan object surrounded by prose', () => {
    expect(parsePlanJson('Here is the plan:\n{"steps":[]}\nDone.')).toEqual({ steps: [] })
  })

  it('parses a bare steps array', () => {
    const parsed = parsePlanJson('[{"intent":"Wait","action":{"type":"press","key":"Enter"}}]')
    expect(parsed.steps).toHaveLength(1)
  })

  it('does not get confused by braces inside strings', () => {
    const parsed = parsePlanJson(
      'Plan:\n{"steps":[{"intent":"Find text {like this}","action":{"type":"press","key":"Enter"}}]}\nThanks.'
    )
    expect(parsed.steps).toHaveLength(1)
  })

  it('throws the existing no-json error for prose-only output', () => {
    expect(() => parsePlanJson('No browser action is needed.')).toThrow('planner returned no JSON object')
  })
})
