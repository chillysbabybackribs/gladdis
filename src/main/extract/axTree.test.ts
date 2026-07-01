import { describe, expect, it } from 'vitest'
import {
  boxFromContentQuad,
  digestAxSnapshot,
  flattenAxNodes,
  isBoundsInViewport,
  type AxSnapshot,
  type CdpAxNode
} from './axTree'

describe('axTree', () => {
  it('derives bounds from a DOM content quad', () => {
    const bounds = boxFromContentQuad([10, 20, 110, 20, 110, 60, 10, 60])
    expect(bounds).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 40,
      x: 60,
      y: 40
    })
  })

  it('detects viewport intersection', () => {
    expect(isBoundsInViewport({ left: 10, top: 10, width: 20, height: 20, x: 20, y: 20 }, { width: 100, height: 100 })).toBe(true)
    expect(isBoundsInViewport({ left: -50, top: 10, width: 20, height: 20, x: -40, y: 20 }, { width: 100, height: 100 })).toBe(false)
  })

  it('flattens interactive accessibility nodes in document order', () => {
    const nodes: CdpAxNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, ignored: false },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'Sign in' }, ignored: false, backendDOMNodeId: 10 },
      { nodeId: '3', role: { value: 'link' }, name: { value: 'Pricing' }, ignored: false, backendDOMNodeId: 11 },
      { nodeId: '4', role: { value: 'generic' }, ignored: false }
    ]

    const flattened = flattenAxNodes(
      nodes.map((node) => ({ node })),
      { focus: 'pricing' },
      { width: 800, height: 600 }
    )
    expect(flattened.totalSeen).toBe(2)
    expect(flattened.entries[0].name).toBe('Sign in')
    expect(flattened.entries[1].name).toBe('Pricing')
  })

  it('preserves source order on a link-heavy feed', () => {
    const nodes: CdpAxNode[] = [
      { nodeId: '1', role: { value: 'link' }, name: { value: '1 hour ago' }, ignored: false, backendDOMNodeId: 1 },
      { nodeId: '2', role: { value: 'link' }, name: { value: '1 comment' }, ignored: false, backendDOMNodeId: 2 },
      { nodeId: '3', role: { value: 'link' }, name: { value: '10 hours ago' }, ignored: false, backendDOMNodeId: 3 },
      { nodeId: '4', role: { value: 'link' }, name: { value: 'Claude Sonnet 5 is much better at following instructions' }, ignored: false, backendDOMNodeId: 4 },
      { nodeId: '5', role: { value: 'searchbox' }, name: { value: 'Search' }, ignored: false, backendDOMNodeId: 5 }
    ]
    const flattened = flattenAxNodes(
      nodes.map((node) => ({ node })),
      {},
      { width: 800, height: 600 }
    )
    const order = flattened.entries.map((e) => e.name)
    expect(order).toEqual([
      '1 hour ago',
      '1 comment',
      '10 hours ago',
      'Claude Sonnet 5 is much better at following instructions',
      'Search'
    ])
  })

  // (The a11y wireframe was removed — navigate's wireframe now comes from the
  // DOM; see pageWireframe.test.ts. read_a11y still uses the capture above.)

  it('formats a compact digest for model consumption', () => {
    const digest = digestAxSnapshot(
      {
        url: 'https://example.com',
        title: 'Example',
        capturedAt: Date.now(),
        totalSeen: 1,
        truncated: false,
        nodes: [
          {
            ref: '@a1',
            role: 'button',
            name: 'Sign in',
            states: ['focused'],
            inViewport: true,
            bounds: { x: 120, y: 40, width: 80, height: 32, top: 24, left: 80 }
          }
        ]
      },
      { focus: 'sign' }
    )

    expect(digest).toContain('SOURCE: CDP Accessibility.getFullAXTree')
    expect(digest).toContain('@a1')
    expect(digest).toContain('Sign in')
    expect(digest).toContain('focused')
  })
})
