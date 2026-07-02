import { describe, expect, it, vi } from 'vitest'
import { CDPSession } from './CDPSession'

function makeDebugger() {
  const listeners = new Map<string, Function[]>()
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    on: vi.fn((event: string, listener: Function) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    sendCommand: vi.fn(async (method: string, params?: any, sessionId?: string) => {
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            {
              targetId: 'iframe-1',
              type: 'iframe',
              attached: false,
              url: 'https://widgets.example.test'
            }
          ]
        }
      }
      if (method === 'Target.attachToTarget') {
        return { sessionId: 'session-1' }
      }
      return {}
    }),
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
  }
}

describe('CDPSession', () => {
  it('auto-attaches iframe targets and remembers their child session ids', async () => {
    const debuggerMock = makeDebugger()
    const wc = { debugger: debuggerMock } as any
    const events: any[] = []
    const session = new CDPSession(wc, 'tab-1', (event) => events.push(event))

    await session.attach()

    expect(debuggerMock.sendCommand).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      expect.objectContaining({ autoAttach: true, flatten: true }),
      undefined
    )
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith(
      'Target.attachToTarget',
      { targetId: 'iframe-1', flatten: true },
      undefined
    )
    expect(session.sessionIdForTarget('iframe-1')).toBe('session-1')

    debuggerMock.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'session-1' }, '')
    expect(session.sessionIdForTarget('iframe-1')).toBeNull()
    expect(events.at(-1)).toMatchObject({ method: 'Target.detachedFromTarget' })
  })

  it('passes an explicit child session id through send()', async () => {
    const debuggerMock = makeDebugger()
    const wc = { debugger: debuggerMock } as any
    const session = new CDPSession(wc, 'tab-1', () => {})

    await session.send('Runtime.evaluate', { expression: '1+1' }, 'session-7')

    expect(debuggerMock.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      { expression: '1+1' },
      'session-7'
    )
  })
})
