import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../../../shared/types'
import {
  routeNotification,
  routeServerRequest,
  type ActiveTurn,
  type NotificationContext,
  type ServerRequestContext
} from './codexTurnRouter'

function makeTurn(): ActiveTurn {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    modelId: 'gpt-5.5',
    threadId: 'thread-1',
    turnId: 'turn-1',
    done: vi.fn(),
    aborted: false,
    paused: false,
    queuedUserContext: [],
    autoResumeAfterPause: false,
    resumeResolver: null,
    text: '',
    silent: false,
    error: null,
    toolItems: new Map(),
    blockedItems: new Set()
  }
}

function makeContext(turn: ActiveTurn, emitted: any[]): NotificationContext {
  return {
    emit: (event) => emitted.push(event),
    compactor: {
      record: vi.fn(),
      finish: vi.fn()
    } as any,
    turnForThread: () => turn,
    server: () => null,
    lastToolEndAt: { value: 0 }
  }
}

describe('Codex turn router', () => {
  it('steers native browser commands to gladdis tools without killing the turn', () => {
    const turn = makeTurn()
    const events: ChatStreamEvent[] = []
    const notify = vi.fn()

    routeNotification(
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          item: {
            id: 'item-1',
            type: 'commandExecution',
            command: 'google-chrome-stable --headless --screenshot=/tmp/ui.png http://127.0.0.1:5174'
          }
        }
      } as any,
      {
        emit: (event) => events.push(event),
        compactor: { record: vi.fn(), finish: vi.fn() } as any,
        turnForThread: () => turn,
        server: () => ({ notify }) as any,
        lastToolEndAt: { value: 0 }
      }
    )

    expect(events.map((event) => event.type)).toEqual(['tool_call', 'tool_result'])
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      tool: 'gladdis_browser_guardrail',
      callId: 'item-1'
    })
    expect(events[1]).toMatchObject({
      type: 'tool_result',
      ok: true,
      callId: 'item-1'
    })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(turn.aborted).toBe(false)
    expect(turn.error).toBeNull()
    expect(turn.blockedItems.has('item-1')).toBe(true)
    expect(notify).not.toHaveBeenCalled()
    expect(turn.done).not.toHaveBeenCalled()
  })

  it('streams agentMessage deltas once and does not replay them on completion', () => {
    const turn = makeTurn()
    const emitted: any[] = []
    const ctx = makeContext(turn, emitted)

    routeNotification(
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'msg-1',
          delta: 'Hello'
        }
      },
      ctx
    )
    routeNotification(
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'msg-1',
          delta: ' world'
        }
      },
      ctx
    )
    routeNotification(
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'msg-1',
            type: 'agentMessage',
            text: 'Hello world'
          }
        }
      },
      ctx
    )
    routeNotification(
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' }
        }
      },
      ctx
    )

    expect(turn.text).toBe('Hello world')
    expect(emitted).toEqual([
      { requestId: 'req-1', type: 'delta', text: 'Hello' },
      { requestId: 'req-1', type: 'delta', text: ' world' }
    ])
    expect(turn.done).toHaveBeenCalledOnce()
  })
})

describe('routeServerRequest error handling', () => {
  function makeServerCtx(args: {
    run: ServerRequestContext['browserTools']['run']
    responds: Array<{ id: unknown; result: unknown }>
  }): ServerRequestContext {
    const server = {
      respond: (id: unknown, result: unknown) => args.responds.push({ id, result }),
      notify: vi.fn()
    }
    return {
      emit: vi.fn(),
      server: () => server as any,
      turnForThread: () => undefined,
      browserTools: {
        run: args.run,
        tabs: { liveTabId: () => 'tab-1' }
      } as any,
      completeWithModel: vi.fn()
    }
  }

  it('responds with a tool-error envelope (does not reject) when a browser tool throws', async () => {
    const responds: Array<{ id: unknown; result: unknown }> = []
    const ctx = makeServerCtx({
      run: vi.fn().mockRejectedValue(new Error('Unknown tab tab-1')),
      responds
    })

    // Must resolve — a rejection here is the UnhandledPromiseRejectionWarning we fixed.
    await expect(
      routeServerRequest(
        {
          id: 7,
          method: 'item/tool/call',
          params: { namespace: 'gladdis', tool: 'grep_page', arguments: { query: 'example' }, itemId: 'call-1' }
        } as any,
        ctx
      )
    ).resolves.toBeUndefined()

    // The blocked Codex turn must still get exactly one response so it can proceed.
    expect(responds).toHaveLength(1)
    expect(responds[0].id).toBe(7)
    const result = responds[0].result as { success: boolean; contentItems: Array<{ text: string }> }
    expect(result.success).toBe(false)
    const payload = JSON.parse(result.contentItems[0].text) as { ok: boolean; text: string }
    expect(payload.ok).toBe(false)
    expect(payload.text).toContain('Unknown tab tab-1')
  })

  it('does not double-respond on the success path', async () => {
    const responds: Array<{ id: unknown; result: unknown }> = []
    const ctx = makeServerCtx({
      run: vi.fn().mockResolvedValue({ ok: true, text: 'ok' }),
      responds
    })

    await routeServerRequest(
      {
        id: 9,
        method: 'item/tool/call',
        params: { namespace: 'gladdis', tool: 'grep_page', arguments: { query: 'example' }, itemId: 'call-2' }
      } as any,
      ctx
    )

    expect(responds).toHaveLength(1)
    const result = responds[0].result as { success: boolean }
    expect(result.success).toBe(true)
  })
})
