import { describe, expect, it } from 'vitest'
import { isGladdisDynamicToolCall, codexToolName } from './toolItems'

describe('codex tool items', () => {
  it('flags gladdis.* dynamic tool calls so the lifecycle path does not double-chip them', () => {
    // A gladdis browser tool: chipped by respondToCodexBrowserToolCall, so the
    // generic item-lifecycle path must skip it.
    expect(
      isGladdisDynamicToolCall({ type: 'dynamicToolCall', id: '1', namespace: 'gladdis', tool: 'browse_task' } as any)
    ).toBe(true)
  })

  it('does NOT flag non-gladdis dynamic tools or other tool items', () => {
    expect(
      isGladdisDynamicToolCall({ type: 'dynamicToolCall', id: '2', namespace: 'other', tool: 'foo' } as any)
    ).toBe(false)
    expect(isGladdisDynamicToolCall({ type: 'mcpToolCall', id: '3', tool: 'foo' } as any)).toBe(false)
    expect(isGladdisDynamicToolCall({ type: 'commandExecution', id: '4' } as any)).toBe(false)
  })

  it('names dynamic tool calls by their tool field', () => {
    expect(codexToolName({ type: 'dynamicToolCall', id: '5', tool: 'browse_task' } as any)).toBe('browse_task')
  })
})
