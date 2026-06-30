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
  onGetRequestPostData?: (requestId: string) => { postData: string } | Promise<{ postData: string }>
  onCommand?: (method: string) => void
  onLoadUrl?: (url: string) => void
}) {
  const debuggerInstance = new FakeDebugger()
  const sentCommands: Array<{ method: string; params: Record<string, unknown> }> = []
  const getResponseBodyCalls: string[] = []
  const getRequestPostDataCalls: string[] = []

  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      options?.onCommand?.(method)
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
      if (method === 'Network.getRequestPostData') {
        const requestId = String(params.requestId ?? '')
        getRequestPostDataCalls.push(requestId)
        const result = options?.onGetRequestPostData?.(requestId)
        if (result) return await result
        return { postData: `payload:${requestId}` }
      }
      return {}
    }
  }

  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerInstance,
    isLoading: () => false,
    loadURL: (url: string) => {
      options?.onLoadUrl?.(url)
      webContents.emit('did-start-loading')
      webContents.emit('dom-ready')
      webContents.emit('did-stop-loading')
      return Promise.resolve()
    }
  })

  const view = { webContents }

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
    getResponseBodyCalls,
    getRequestPostDataCalls
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
    postData?: string
    requestHeaders?: Record<string, string>
    responseHeaders?: Record<string, string>
  }
): void {
  debuggerInstance.emitMessage('Network.requestWillBeSent', {
    requestId: request.requestId,
    type: request.type ?? 'Fetch',
    timestamp: request.requestTimestamp ?? 1,
    request: {
      url: request.url,
      method: request.method ?? 'GET',
      headers: request.requestHeaders ?? { accept: 'application/json' },
      postData: request.postData
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
      headers: request.responseHeaders ?? { 'content-type': request.mimeType ?? 'application/json' }
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

  it('releases a failed early body claim so fallback can backfill another finished request', async () => {
    const getResponseBodyAttempts = new Map<string, number>()
    const { manager, debuggerInstance, getResponseBodyCalls } = createHarness({
      onGetResponseBody: async (requestId) => {
        const attempts = (getResponseBodyAttempts.get(requestId) ?? 0) + 1
        getResponseBodyAttempts.set(requestId, attempts)
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
      url: 'https://example.com/api/fallback-backfills-after-release'
    })

    const result = await watchPromise

    expect(getResponseBodyCalls).toEqual(['req-1', 'req-1', 'req-2'])
    expect(result.bodies).toEqual([
      expect.objectContaining({
        requestId: 'req-2',
        url: 'https://example.com/api/fallback-backfills-after-release',
        body: 'body:req-2'
      })
    ])
    expect(result.captured.map((item) => item.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('arms Network before navigation and restores the quiet posture after settling', async () => {
    const timeline: string[] = []
    const { manager, sentCommands } = createHarness({
      onCommand: (method) => timeline.push(`cmd:${method}`),
      onLoadUrl: (url) => timeline.push(`load:${url}`)
    })

    const capturePromise = manager.navigateWithNetworkCapture('tab-1', 'https://example.com/feed', {
      resourceTypes: ['fetch'],
      maxBodies: 1,
      maxBodyChars: 1000,
      quietWindowMs: 0
    })

    const result = await capturePromise

    expect(timeline.slice(0, 2)).toEqual(['cmd:Network.enable', 'load:https://example.com/feed'])
    expect(sentCommands.at(-1)?.method).toBe('Network.disable')
    expect(result.filter).toEqual(expect.objectContaining({ resourceTypes: ['fetch'] }))
  })

  it('does not pay the full quiet window when navigation had no matching network activity', async () => {
    const { manager } = createHarness()

    const startedAt = Date.now()
    await manager.navigateWithNetworkCapture('tab-1', 'https://example.com/quiet', {
      resourceTypes: ['fetch'],
      maxBodies: 1,
      maxBodyChars: 1000,
      quietWindowMs: 400
    })
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(300)
  })

  it('arms the next browser action before it runs and captures its traffic', async () => {
    const timeline: string[] = []
    const { manager, debuggerInstance, sentCommands } = createHarness({
      onCommand: (method) => timeline.push(`cmd:${method}`)
    })

    manager.armNextNetworkCapture('tab-1', {
      resourceTypes: ['fetch'],
      windowMs: 0,
      maxBodies: 1,
      maxBodyChars: 1000
    })

    const capturePromise = manager.runWithPendingNetworkCapture('tab-1', async () => {
      timeline.push('action:start')
      emitRequestLifecycle(debuggerInstance, {
        requestId: 'req-armed',
        url: 'https://example.com/api/armed'
      })
      timeline.push('action:end')
      return 'ok'
    })

    const result = await capturePromise

    expect(result.value).toBe('ok')
    expect(timeline.slice(0, 3)).toEqual(['cmd:Network.enable', 'action:start', 'action:end'])
    expect(sentCommands.at(-1)?.method).toBe('Network.disable')
    expect(result.network).not.toBeNull()
    expect(manager.peekArmedNetworkCapture('tab-1')).toBeNull()
  })

  it('captures and redacts request post data when enabled', async () => {
    const { manager, debuggerInstance, getRequestPostDataCalls } = createHarness()

    const watchPromise = manager.watchNetwork('tab-1', {
      urlFilter: 'graphql',
      includeRequestBody: true,
      redactSensitive: true,
      windowMs: 20,
      maxBodies: 1,
      maxBodyChars: 1000
    })

    emitRequestLifecycle(debuggerInstance, {
      requestId: 'req-graphql',
      url: 'https://example.com/graphql',
      method: 'POST',
      postData: JSON.stringify({
        operationName: 'ViewerQuery',
        variables: { token: 'super-secret', q: 'ok' }
      }),
      requestHeaders: {
        authorization: 'Bearer secret-token',
        accept: 'application/json'
      },
      responseHeaders: {
        'set-cookie': 'session=abc123',
        'content-type': 'application/json'
      }
    })

    const result = await watchPromise

    expect(getRequestPostDataCalls).toEqual([])
    expect(result.captured).toEqual([
      expect.objectContaining({
        requestId: 'req-graphql',
        requestHeaders: {
          authorization: '[REDACTED]',
          accept: 'application/json'
        },
        responseHeaders: {
          'set-cookie': '[REDACTED]',
          'content-type': 'application/json'
        },
        requestBody: expect.stringContaining('"token": "[REDACTED]"'),
        requestBodyTruncated: false
      })
    ])
  })

  it('falls back to Network.getRequestPostData when the event did not include postData', async () => {
    const { manager, debuggerInstance, getRequestPostDataCalls } = createHarness({
      onGetRequestPostData: async () => ({
        postData: 'query=hello&password=hunter2'
      })
    })

    const watchPromise = manager.watchNetwork('tab-1', {
      urlFilter: 'submit',
      includeRequestBody: true,
      windowMs: 20,
      maxBodies: 1,
      maxBodyChars: 1000
    })

    emitRequestLifecycle(debuggerInstance, {
      requestId: 'req-form',
      url: 'https://example.com/submit',
      method: 'POST',
      mimeType: 'text/plain'
    })

    const result = await watchPromise

    expect(getRequestPostDataCalls).toEqual(['req-form'])
    expect(result.captured[0]).toEqual(
      expect.objectContaining({
        requestBody: 'query=hello&password=%5BREDACTED%5D',
        requestBodyTruncated: false
      })
    )
  })
})
