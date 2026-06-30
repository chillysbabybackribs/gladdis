import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../../../shared/types'
import { routeNotification, type ActiveTurn, type NotificationContext } from './codexTurnRouter'

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
