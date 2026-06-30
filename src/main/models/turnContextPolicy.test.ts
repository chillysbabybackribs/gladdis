import { describe, expect, it } from 'vitest'
import { resolveTurnContextPolicy, shouldEnableCursorMcpBridge } from './turnContextPolicy'
import type { ChatRequest } from '../../../shared/types'

function policyFor(userText: string, hints?: ChatRequest['contextHints']): ReturnType<typeof resolveTurnContextPolicy> {
  return resolveTurnContextPolicy({
    requestId: 'req_1',
    modelId: 'composer-2.5',
    messages: [{ role: 'user', content: userText }],
    mode: 'agent',
    contextHints: hints
  })
}

describe('shouldEnableCursorMcpBridge', () => {
  it('keeps MCP off for plain chat and local code work', () => {
    expect(shouldEnableCursorMcpBridge(policyFor('hello'))).toBe(false)
    expect(shouldEnableCursorMcpBridge(policyFor('refactor ChatService.ts'))).toBe(false)
    expect(shouldEnableCursorMcpBridge(policyFor('run the unit tests'))).toBe(false)
  })

  it('enables MCP for web search and browser control', () => {
    expect(shouldEnableCursorMcpBridge(policyFor('search the web for Cursor docs'))).toBe(true)
    expect(shouldEnableCursorMcpBridge(policyFor('click the login button on this page'))).toBe(true)
    expect(shouldEnableCursorMcpBridge(policyFor('open https://example.com'))).toBe(true)
  })

  it('enables MCP when the UI attached an active-page preamble', () => {
    const policy = policyFor('[Active page: Example — https://example.com]\n\nwhat is the headline?')
    expect(policy.hadActivePagePreamble).toBe(true)
    expect(shouldEnableCursorMcpBridge(policy)).toBe(true)
  })

  it('enables MCP for active-page follow-ups', () => {
    expect(
      shouldEnableCursorMcpBridge(
        policyFor('what about the pricing section?', { activePageFollowup: true })
      )
    ).toBe(true)
  })
})
