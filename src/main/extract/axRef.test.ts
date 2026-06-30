import { describe, expect, it } from 'vitest'
import {
  axNodeClickable,
  axRefStillValid,
  describeAxRefMatch,
  isAxRefQuery,
  normalizePageUrl,
  parseAxRefQuery,
  resolveAxRef,
  type AxRefStore
} from './axRef'
import type { AxSnapshotNode } from './axTree'

const sampleNodes: AxSnapshotNode[] = [
  {
    ref: '@a1',
    role: 'button',
    name: 'Sign in',
    states: [],
    inViewport: true,
    score: 10,
    bounds: { x: 120, y: 40, width: 80, height: 32, top: 24, left: 80 }
  }
]

describe('axRef', () => {
  it('parses @aN refs in multiple forms', () => {
    expect(parseAxRefQuery('@a3')).toBe('@a3')
    expect(parseAxRefQuery('a3')).toBe('@a3')
    expect(parseAxRefQuery('  @A12 ')).toBe('@a12')
    expect(parseAxRefQuery('Sign in')).toBeNull()
  })

  it('auto-detects ref queries when type is omitted or text', () => {
    expect(isAxRefQuery('@a2')).toBe(true)
    expect(isAxRefQuery('pricing', 'selector')).toBe(false)
    expect(isAxRefQuery('@a2', 'ref')).toBe(true)
  })

  it('resolves refs from the latest snapshot nodes', () => {
    expect(resolveAxRef(sampleNodes, 'a1')?.name).toBe('Sign in')
    expect(resolveAxRef(sampleNodes, '@a9')).toBeNull()
  })

  it('tracks ref-store freshness by url and age', () => {
    const store: AxRefStore = {
      pageUrl: 'https://example.com#section',
      capturedAt: Date.now() - 1_000,
      nodes: sampleNodes
    }
    expect(axRefStillValid(store, 'https://example.com', 5_000)).toBe(true)
    expect(axRefStillValid(store, 'https://other.example', 5_000)).toBe(false)
    expect(normalizePageUrl('https://example.com#section')).toBe('https://example.com/')
  })

  it('describes ref matches for tool acks', () => {
    expect(describeAxRefMatch(sampleNodes[0])).toContain('@a1')
    expect(axNodeClickable(sampleNodes[0])).toBe(true)
  })
})
