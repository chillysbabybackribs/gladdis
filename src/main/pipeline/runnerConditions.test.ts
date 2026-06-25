import { describe, expect, it, vi } from 'vitest'
import type { PageCapture } from '../../../shared/types'
import { checkCondition, resolveTarget } from './runnerConditions'

describe('runnerConditions', () => {
  it('checks urlMatches from location.href without full page capture', async () => {
    const cdpSend = vi.fn(async (_tabId: string, method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
        return { result: { value: 'https://example.com/docs/performance' } }
      }
      return {}
    })
    const capture = vi.fn(async (): Promise<PageCapture> => {
      throw new Error('capture should not be used for urlMatches')
    })

    const result = await checkCondition(
      { cdpSend, capture },
      'tab-1',
      { kind: 'urlMatches', pattern: 'example\\.com/docs' },
      { inFlight: () => 0 }
    )

    expect(result.ok).toBe(true)
    expect(capture).not.toHaveBeenCalled()
    expect(cdpSend).toHaveBeenCalledWith(
      'tab-1',
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'location.href' })
    )
  })

  it('resolves stable selector targets through direct CSS before capture', async () => {
    const cdpSend = vi.fn(async (_tabId: string, method: string) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: {
              idx: -1,
              role: 'button',
              name: 'Submit',
              tag: 'button',
              selector: 'button[data-testid="submit"]',
              rect: { x: 20, y: 30, w: 80, h: 24 },
              inViewport: true,
              disabled: false
            }
          }
        }
      }
      return {}
    })
    const capture = vi.fn(async (): Promise<PageCapture> => {
      throw new Error('capture should not be used for stable selector resolution')
    })

    const node = await resolveTarget({ cdpSend, capture }, 'tab-1', {
      selector: 'button[data-testid="submit"]'
    })

    expect(node?.name).toBe('Submit')
    expect(capture).not.toHaveBeenCalled()
  })
})
