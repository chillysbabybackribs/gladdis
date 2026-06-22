import { describe, expect, it } from 'vitest'
import { classifyScrollKey, decideFollowOnScroll, isScrolledToBottom } from './useAutoScroll'

describe('isScrolledToBottom', () => {
  it('reports true when the scroller is exactly anchored at the bottom', () => {
    expect(isScrolledToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true)
  })

  it('allows a configurable threshold of slack so sub-pixel rounding does not unstick', () => {
    // 31px above the bottom is still "at the bottom" with the 32px default.
    expect(isScrolledToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 569 })).toBe(true)
    // 33px above the bottom is not.
    expect(isScrolledToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 567 })).toBe(false)
  })

  it('respects an explicit threshold override', () => {
    expect(
      isScrolledToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 599 }, 1)
    ).toBe(true)
    expect(
      isScrolledToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 598 }, 1)
    ).toBe(false)
  })

  it('treats a non-scrollable container as already at the bottom', () => {
    expect(isScrolledToBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 })).toBe(true)
  })

  it('handles rubber-band overscroll without flipping state', () => {
    // On macOS, scrollTop can briefly exceed scrollHeight - clientHeight.
    expect(isScrolledToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 650 })).toBe(true)
  })
})

describe('decideFollowOnScroll', () => {
  it('keeps the current follow flag while a programmatic scroll is settling', () => {
    // We just issued a programmatic pin and the synthetic scroll event arrives
    // 50ms later; user intent must NOT be re-derived from that synthetic event.
    expect(
      decideFollowOnScroll(
        { following: false, programmaticUntilMs: 1_000 },
        { nowMs: 950, atBottom: true }
      )
    ).toBe(false)
    expect(
      decideFollowOnScroll(
        { following: true, programmaticUntilMs: 1_000 },
        { nowMs: 950, atBottom: false }
      )
    ).toBe(true)
  })

  it('once the settle window has elapsed, follow tracks the scroll position', () => {
    expect(
      decideFollowOnScroll(
        { following: false, programmaticUntilMs: 1_000 },
        { nowMs: 1_001, atBottom: true }
      )
    ).toBe(true)
    expect(
      decideFollowOnScroll(
        { following: true, programmaticUntilMs: 1_000 },
        { nowMs: 1_001, atBottom: false }
      )
    ).toBe(false)
  })

  it('treats programmaticUntilMs=0 as no settle window at all', () => {
    expect(
      decideFollowOnScroll(
        { following: true, programmaticUntilMs: 0 },
        { nowMs: 0, atBottom: false }
      )
    ).toBe(false)
  })
})

describe('classifyScrollKey', () => {
  it('classifies upward-scroll keys as yield (immediately drop follow)', () => {
    expect(classifyScrollKey('ArrowUp')).toBe('yield')
    expect(classifyScrollKey('PageUp')).toBe('yield')
    expect(classifyScrollKey('Home')).toBe('yield')
  })

  it('classifies downward-scroll keys as open (clear the settle window)', () => {
    expect(classifyScrollKey('ArrowDown')).toBe('open')
    expect(classifyScrollKey('PageDown')).toBe('open')
    expect(classifyScrollKey('End')).toBe('open')
    // Spacebar pages down in the default scroller and is part of normal
    // reading behavior — treat it the same as PageDown.
    expect(classifyScrollKey(' ')).toBe('open')
  })

  it('ignores non-scroll keys so typing in unrelated inputs does not flip follow', () => {
    expect(classifyScrollKey('a')).toBe('ignore')
    expect(classifyScrollKey('Enter')).toBe('ignore')
    expect(classifyScrollKey('Escape')).toBe('ignore')
    expect(classifyScrollKey('Shift')).toBe('ignore')
  })
})
