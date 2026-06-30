import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TabManager } from './TabManager'

type DebugMessageHandler = (_event: unknown, method: string, params: any) => void

class FakeDebugger extends EventEmitter {
  emitMessage(method: string, params: any): void {
    this.emit('message', {}, method, params)
  }

  override on(event: 'message', listener: DebugMessageHandler): this
  override on(event: string, listener: (...args: any[]) => void): this
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  override removeListener(event: 'message', listener: DebugMessageHandler): this
  override removeListener(event: string, listener: (...args: any[]) => void): this
  override removeListener(event: string, listener: (...args: any[]) => void): this {
    return super.removeListener(event, listener)
  }
}

function createHarness(options?: {
  onGetResponseBody?: (requestId: string) => { body: string; base64Encoded?: boolean } | Promise<{ body: string; base64Encoded?: boolean }>
}) {
  const debuggerInstance = new FakeDebugger()
  const sentCommands: Array<{ method: string; params: Record<string, unknown> }> = []
  const getResponseBodyCalls: string[] = []

  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sentCommands.push({ method, params })
      if (method === 'Network.getResponseBody') {
        const requestId = String(params.requestId ?? '')
        getResponseBodyCalls.push(requestId)
        const result = options?.onGetResponseBody?.(requestId)
        if (result) {
          const awaited = await result
          return {
            body: awaited.body,
            base64Encoded: awaited.base64Encoded ?? false
          }
        }
        return {
          body: `body:${requestId}`,
          base64Encoded: false
        }
      }
      return {}
    }
  }

  const view = {
    webContents: {
      debugger: debuggerInstance
    }
  }

  const manager = new TabManager({} as any, () => {}, () => {})
  ;(manager as any).tabs.set('tab-1', {
    id: 'tab-1',
    view,
    cdp
  })

  return {
    manager,
    debuggerInstance,
    sentCommands,
    getResponseBodyCalls
  }
}

function emitRequestLifecycle(
  debuggerInstance: FakeDebugger,
  request: {
    requestId: string
    url: string
    method?: string
    type?: string
    status?: number
    mimeType?: string
    requestTimestamp?: number
    responseTimestamp?: number
    finishTimestamp?: number
    encodedDataLength?: number
  }
): void {
  debuggerInstance.emitMessage('Network.requestWillBeSent', {
    requestId: request.requestId,
    type: request.type ?? 'Fetch',
    timestamp: request.requestTimestamp ?? 1,
    request: {
      url: request.url,
      method: request.method ?? 'GET',
      headers: { accept: 'application/json' }
    }
  })

  debuggerInstance.emitMessage('Network.responseReceived', {
    requestId: request.requestId,
    type: request.type ?? 'Fetch',
    timestamp: request.responseTimestamp ?? 2,
    response: {
      url: request.url,
      status: request.status ?? 200,
      mimeType: request.mimeType ?? 'application/json',
      headers: { 'content-type': request.mimeType ?? 'application/json' }
    }
  })

  debuggerInstance.emitMessage('Network.loadingFinished', {
    requestId: request.requestId,
    timestamp: request.finishTimestamp ?? 3,
    encodedDataLength: request.encodedDataLength ?? 123
  })
}

describe('TabManager.watchNetwork sequencing', () => {
  it('claims body slots in loadingFinished order before the post-window sweep', async () => {
    const { manager, debuggerInstance, getResponseBodyCalls } = createHarness()

    const watchPromise = manager.watchNetwork('tab-1', {
      urlFilter: 'api',
      resourceTypes: ['fetch'],
      windowMs: 20,
      maxBodies: 1,
      maxBodyChars: 1000
    })

    emitRequestLifecycle(debuggerInstance, {
      requestId: 'req-1',
      url: 'https://example.com/api/first',
      finishTimestamp: 4
    })
    emitRequestLifecycle(debuggerInstance, {
      requestId: 'req-2',
      url: 'https://example.com/api/second',
      finishTimestamp: 3
    })

    const result = await watchPromise

    expect(getResponseBodyCalls).toEqual(['req-1'])
    expect(result.totalSeen).toBe(2)
    expect(result.bodies).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        url: 'https://example.com/api/first',
        body: 'body:req-1'
      })
    ])
    expect(result.captured.map((item) => item.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('keeps a claimed slot consumed after an early body-capture failure', async () => {
    const { manager, debuggerInstance, getResponseBodyCalls } = createHarness({
      onGetResponseBody: async (requestId) => {
        if (requestId === 'req-1') {
          throw new Error('body not available yet')
        }
        return { body: `body:${requestId}` }
      }
    })

    const watchPromise = manager.watchNetwork('tab-1', {
      urlFilter: 'api',
      resourceTypes: ['fetch'],
      windowMs: 20,
      maxBodies: 1,
      maxBodyChars: 1000
    })

    emitRequestLifecycle(debuggerInstance, {
      requestId: 'req-1',
      url: 'https://example.com/api/claimed-slot-fails'
    })
    emitRequestLifecycle(debuggerInstance, {
      requestId: 'req-2',
      url: 'https://example.com/api/cannot-backfill-after-claim'
    })

    const result = await watchPromise

    expect(getResponseBodyCalls).toEqual(['req-1'])
    expect(result.bodies).toEqual([])
    expect(result.captured.map((item) => item.requestId)).toEqual(['req-1', 'req-2'])
  })
})
