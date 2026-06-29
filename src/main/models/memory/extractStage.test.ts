import { describe, expect, it } from 'vitest'
import { sanitizeCandidates } from './extractStage'

describe('sanitizeCandidates', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeCandidates(null)).toEqual([])
    expect(sanitizeCandidates({})).toEqual([])
    expect(sanitizeCandidates('foo')).toEqual([])
  })

  it('keeps well-formed candidates', () => {
    const out = sanitizeCandidates([
      {
        kind: 'preference',
        scope: 'workspace',
        text: 'user prefers TypeScript',
        evidence: [{ conversationId: 'conv-1', messageIndex: 4, turnExcerpt: 'we use ts' }],
        tags: ['lang'],
        confidence: 0.85
      }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('preference')
    expect(out[0].evidence[0].conversationId).toBe('conv-1')
  })

  it('drops candidates without evidence', () => {
    const out = sanitizeCandidates([
      {
        kind: 'preference',
        scope: 'workspace',
        text: 'foo',
        evidence: [],
        tags: [],
        confidence: 0.8
      }
    ])
    expect(out).toHaveLength(0)
  })

  it('drops candidates with unknown kind', () => {
    const out = sanitizeCandidates([
      {
        kind: 'fabrication',
        scope: 'workspace',
        text: 'foo',
        evidence: [{ conversationId: 'c1' }],
        tags: [],
        confidence: 0.8
      }
    ])
    expect(out).toHaveLength(0)
  })

  it('drops candidates with invalid scope', () => {
    const out = sanitizeCandidates([
      {
        kind: 'preference',
        scope: 'global',
        text: 'foo',
        evidence: [{ conversationId: 'c1' }],
        tags: [],
        confidence: 0.8
      }
    ])
    expect(out).toHaveLength(0)
  })

  it('clamps confidence into [0, 1] and defaults missing/NaN', () => {
    const out = sanitizeCandidates([
      { kind: 'preference', scope: 'workspace', text: 'a', evidence: [{ conversationId: 'c' }], tags: [], confidence: 1.7 },
      { kind: 'preference', scope: 'workspace', text: 'b', evidence: [{ conversationId: 'c' }], tags: [], confidence: -1 },
      { kind: 'preference', scope: 'workspace', text: 'c', evidence: [{ conversationId: 'c' }], tags: [] }
    ])
    expect(out[0].confidence).toBe(1)
    expect(out[1].confidence).toBe(0)
    expect(out[2].confidence).toBe(0.6)
  })

  it('caps tags at 8 and filters non-strings', () => {
    const out = sanitizeCandidates([
      {
        kind: 'preference',
        scope: 'workspace',
        text: 'foo',
        evidence: [{ conversationId: 'c' }],
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 42, null],
        confidence: 0.8
      }
    ])
    expect(out[0].tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })

  it('preserves taskId only when scope is "task"', () => {
    const out = sanitizeCandidates([
      { kind: 'preference', scope: 'workspace', taskId: 't1', text: 'a', evidence: [{ conversationId: 'c' }], tags: [], confidence: 0.8 },
      { kind: 'preference', scope: 'task', taskId: 't1', text: 'b', evidence: [{ conversationId: 'c' }], tags: [], confidence: 0.8 }
    ])
    expect(out[0].taskId).toBeUndefined()
    expect(out[1].taskId).toBe('t1')
  })
})
