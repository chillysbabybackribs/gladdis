import { describe, expect, it, vi } from 'vitest'
import type { PageCapture } from '../../../shared/types'
import { Runner } from './Runner'
import type { Plan } from './types'

describe('Runner', () => {
  it('waits for click-triggered URL navigation before checking urlMatches', async () => {
    let url = 'https://news.ycombinator.com/'
    const cdpSend = vi.fn(async (_tabId: string, method: string, params?: Record<string, any>) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        setTimeout(() => {
          url = 'https://www.reuters.com/legal/transactional/spacex-buy-anysphere-60-billion-2026-06-16/'
        }, 25)
        return {}
      }
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'location.href') {
          return { result: { value: url } }
        }
        if (params?.expression === 'document.readyState') {
          return { result: { value: 'complete' } }
        }
      }
      return {}
    })
    const capture = vi.fn(async (): Promise<PageCapture> => ({
      url,
      title: url.includes('reuters') ? 'Reuters' : 'Hacker News',
      capturedAt: Date.now(),
      tookMs: 1,
      content: {
        title: url.includes('reuters') ? 'SpaceX locks in $60 billion Cursor deal' : 'Hacker News',
        byline: null,
        text: url.includes('reuters') ? 'Article text' : 'SpaceX to buy Cursor for $60B',
        markdown: url.includes('reuters') ? 'Article text' : 'SpaceX to buy Cursor for $60B',
        headings: [],
        wordCount: 2
      },
      data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
      actions: url.includes('reuters')
        ? []
        : [
            {
              idx: 0,
              role: 'link',
              name: 'SpaceX to buy Cursor for $60B',
              tag: 'a',
              value: 'https://www.reuters.com/legal/transactional/spacex-buy-anysphere-60-billion-2026-06-16/',
              selector: 'a.storylink',
              rect: { x: 10, y: 10, w: 200, h: 20 },
              inViewport: true,
              disabled: false
            }
          ],
      dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 }
    }))
    const plan: Plan = {
      task: 'open the SpaceX title and summarize it',
      site: 'Hacker News',
      basedOnUrl: 'https://news.ycombinator.com/',
      steps: [
        {
          intent: 'Open the SpaceX story',
          action: {
            type: 'click',
            target: { role: 'link', name: 'SpaceX to buy Cursor for $60B' }
          },
          postCondition: { kind: 'urlMatches', pattern: 'reuters\\.com' }
        }
      ]
    }

    const trajectory = await new Runner({ cdpSend, capture }).run('tab-1', plan)

    expect(trajectory.success).toBe(true)
    expect(trajectory.steps[0].status).toBe('passed')
    expect(cdpSend).toHaveBeenCalledWith(
      'tab-1',
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'location.href' })
    )
  })

  it('does not retry submit-style URL checks by default when the URL pattern misses', async () => {
    const cdpSend = vi.fn(async (_tabId: string, method: string, params?: Record<string, any>) => {
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'location.href') {
          return { result: { value: 'https://duckduckgo.com/?t=h_&q=OpenAI+Responses+API' } }
        }
        if (params?.expression === 'document.readyState') {
          return { result: { value: 'interactive' } }
        }
      }
      return {}
    })
    const capture = vi.fn(async (): Promise<PageCapture> => ({
      url: 'https://duckduckgo.com/?t=h_&q=OpenAI+Responses+API',
      title: 'DuckDuckGo',
      capturedAt: Date.now(),
      tookMs: 1,
      content: {
        title: 'DuckDuckGo search results',
        byline: null,
        text: 'OpenAI Responses API docs',
        markdown: 'OpenAI Responses API docs',
        headings: [],
        wordCount: 4
      },
      data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
      actions: [],
      dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 }
    }))
    const plan: Plan = {
      task: 'search for OpenAI Responses API docs',
      site: 'DuckDuckGo',
      basedOnUrl: 'https://duckduckgo.com/',
      steps: [
        {
          intent: 'Submit search',
          action: { type: 'press', key: 'Enter' },
          postCondition: { kind: 'urlMatches', pattern: 'duckduckgo\\.com/\\?q=.*Responses.*' },
          onFail: 'abort'
        }
      ]
    }

    const trajectory = await new Runner({ cdpSend, capture }).run('tab-1', plan)

    expect(trajectory.success).toBe(false)
    expect(trajectory.steps[0].status).toBe('aborted')
    expect(cdpSend.mock.calls.filter((call) => call[1] === 'Input.dispatchKeyEvent')).toHaveLength(2)
  })

  it('consumes an armed network capture before the first pipeline action', async () => {
    const cdpSend = vi.fn(async (_tabId: string, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: 'complete' } }
      }
      return {}
    })
    const capture = vi.fn(async (): Promise<PageCapture> => ({
      url: 'https://example.com/',
      title: 'Example',
      capturedAt: Date.now(),
      tookMs: 1,
      content: {
        title: 'Example',
        byline: null,
        text: 'Example body',
        markdown: 'Example body',
        headings: [],
        wordCount: 2
      },
      data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
      actions: [],
      dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 }
    }))
    const seenTabs: string[] = []
    async function runWithPendingNetworkCapture<T>(tabId: string, action: () => Promise<T> | T) {
      seenTabs.push(tabId)
      const value = await action()
      return {
        value,
        network: {
          captured: [],
          totalSeen: 2,
          bodies: []
        }
      }
    }
    const plan: Plan = {
      task: 'open example.com',
      site: 'Example',
      basedOnUrl: 'https://example.com/',
      steps: [
        {
          intent: 'Navigate to example.com',
          action: { type: 'navigate', url: 'https://example.com/' },
          postCondition: { kind: 'always' }
        }
      ]
    }

    const trajectory = await new Runner({ cdpSend, capture, runWithPendingNetworkCapture }).run('tab-1', plan)

    expect(seenTabs).toEqual(['tab-1'])
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Page.navigate', { url: 'https://example.com/' })
    expect(trajectory.preActionNetwork?.totalSeen).toBe(2)
  })
})
