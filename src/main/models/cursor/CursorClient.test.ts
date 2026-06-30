import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  // probeCursorBinary() shells out to `agent --version`; succeed so runTurn proceeds.
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: unknown, res: { stdout: string; stderr: string }) => void
    cb(null, { stdout: '2026.1.0', stderr: '' })
    return new EventEmitter()
  }
}))

import { classifyAssistantEvent, computeCursorEmitDelta, ensureWorkspaceMcpConfig, isMcpConfigWarm, probeMcpConfigWarm, shouldEmitAssistantStreamText, CursorClient } from './CursorClient'
import { CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME } from '../claudeCode/browserTools'

/** A fake `agent` child that emits a single terminal stream-json `result` then closes 0. */
function makeFakeCursorChild(resultText: string): import('node:child_process').ChildProcess {
  const child = new EventEmitter() as import('node:child_process').ChildProcess & EventEmitter
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  ;(child as any).stdout = stdout
  ;(child as any).stderr = stderr
  child.kill = vi.fn() as any
  // Emit the result on the next tick so spawnTurn has wired its readline listeners.
  setTimeout(() => {
    stdout.write(JSON.stringify({ type: 'result', result: resultText, subtype: 'success' }) + '\n')
    stdout.end()
    stderr.end()
    child.emit('close', 0, null)
  }, 0)
  return child
}

describe('CursorClient assistant stream parsing', () => {
  it('keeps only true streaming deltas and classifies duplicate flushes', () => {
    expect(
      classifyAssistantEvent({
        type: 'assistant',
        timestamp_ms: 1,
        message: { content: [{ type: 'text', text: 'alpha' }] }
      })
    ).toBe('stream_delta')

    expect(
      classifyAssistantEvent({
        type: 'assistant',
        timestamp_ms: 2,
        model_call_id: 'call-1',
        message: { content: [{ type: 'text', text: 'alpha' }] }
      })
    ).toBe('tool_boundary_flush')

    expect(
      classifyAssistantEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'alpha beta' }] }
      })
    ).toBe('final_flush')
  })

  it('streams live deltas and final flushes but not tool-boundary duplicates', () => {
    expect(shouldEmitAssistantStreamText('stream_delta')).toBe(true)
    expect(shouldEmitAssistantStreamText('final_flush')).toBe(true)
    expect(shouldEmitAssistantStreamText('tool_boundary_flush')).toBe(false)
    expect(shouldEmitAssistantStreamText('unknown')).toBe(false)
  })

  it('treats empty or non-text assistant payloads as ignorable', () => {
    expect(classifyAssistantEvent({ type: 'assistant', timestamp_ms: 1, message: { content: [] } })).toBe('unknown')
    expect(
      classifyAssistantEvent({
        type: 'assistant',
        timestamp_ms: 1,
        message: { content: [{ type: 'tool_use', name: 'read_page' }] }
      })
    ).toBe('unknown')
  })

  it('dedupes reformatted final_flush snapshots that repeat streamed prose', () => {
    let emitted = 'I will check the file.'
    const extension = computeCursorEmitDelta(
      emitted,
      'I will check the file.\n\nDone — updated CursorClient.ts.',
      'final_flush'
    )
    expect(extension.delta).toBe('\n\nDone — updated CursorClient.ts.')
    emitted = extension.nextEmitted

    const duplicate = computeCursorEmitDelta(
      emitted,
      'I will check the file.\n\nDone — updated CursorClient.ts.',
      'final_flush'
    )
    expect(duplicate.delta).toBe('')
    expect(duplicate.nextEmitted).toBe(emitted)
  })

  it('suppresses a terminal result that only restates already-streamed text across tool calls', () => {
    // Repro of the "answer repeated once per tool call" bug: the preamble before a
    // tool call is streamed, the post-tool answer is streamed, then the terminal
    // `result` arrives as a *partial reformat* that is a substring (not a prefix)
    // of everything already emitted. It must not be re-emitted.
    const emitted =
      'The search found files recursively. Let me get just the top-level files.' +
      'There are 12 files in the current directory: CLAUDE.md, package.json, README.md.'
    const result = computeCursorEmitDelta(
      emitted,
      'The search found files recursively. Let me get just the top-level files.',
      'final_flush'
    )
    expect(result.delta).toBe('')
    expect(result.nextEmitted).toBe(emitted)
  })

  it('handles incremental stream chunks and whitespace-only final reformats', () => {
    let emitted = ''
    let step = computeCursorEmitDelta(emitted, 'p', 'stream_delta')
    expect(step.delta).toBe('p')
    emitted = step.nextEmitted

    step = computeCursorEmitDelta(emitted, 'ong', 'stream_delta')
    expect(step.delta).toBe('ong')
    emitted = step.nextEmitted
    expect(emitted).toBe('pong')

    step = computeCursorEmitDelta(emitted, 'pong', 'final_flush')
    expect(step.delta).toBe('')
    expect(step.nextEmitted).toBe('pong')

    step = computeCursorEmitDelta('HelloWorld', 'Hello\n\nWorld', 'final_flush')
    expect(step.delta).toBe('')
    expect(step.nextEmitted).toBe('Hello\n\nWorld')
  })
})

describe('isMcpConfigWarm', () => {
  it('returns false before first write and true after ensureWorkspaceMcpConfig runs', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'gladdis-warm-'))
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: {
          type: 'http',
          url: 'http://127.0.0.1:9999/mcp',
          headers: { Authorization: 'Bearer warm-token' }
        }
      }
    })

    expect(isMcpConfigWarm(workdir, mcpConfig)).toBe(false)
    await ensureWorkspaceMcpConfig(workdir, mcpConfig)
    expect(isMcpConfigWarm(workdir, mcpConfig)).toBe(true)
  })

  it('returns false when config changes (new port/token)', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'gladdis-warm2-'))
    const v1 = JSON.stringify({
      mcpServers: { [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: { url: 'http://127.0.0.1:1111/mcp' } }
    })
    const v2 = JSON.stringify({
      mcpServers: { [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: { url: 'http://127.0.0.1:2222/mcp' } }
    })

    await ensureWorkspaceMcpConfig(workdir, v1)
    expect(isMcpConfigWarm(workdir, v1)).toBe(true)
    expect(isMcpConfigWarm(workdir, v2)).toBe(false)
  })

  it('probeMcpConfigWarm hydrates the cache from an existing on-disk mcp.json', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'gladdis-warm3-'))
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: {
          type: 'http',
          url: 'http://127.0.0.1:5555/mcp',
          headers: { Authorization: 'Bearer disk-token' }
        }
      }
    })

    const cursorDir = join(workdir, '.cursor')
    await mkdir(cursorDir, { recursive: true })
    await writeFile(join(cursorDir, 'mcp.json'), mcpConfig + '\n')

    expect(isMcpConfigWarm(workdir, mcpConfig)).toBe(false)
    await expect(probeMcpConfigWarm(workdir, mcpConfig)).resolves.toBe(true)
    expect(isMcpConfigWarm(workdir, mcpConfig)).toBe(true)
  })
})

describe('ensureWorkspaceMcpConfig', () => {
  it('writes the gladdis entry once and skips identical follow-up writes', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'gladdis-mcp-'))
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: {
          type: 'http',
          url: 'http://127.0.0.1:4321/mcp',
          headers: { Authorization: 'Bearer stable-token' }
        }
      }
    })

    await ensureWorkspaceMcpConfig(workdir, mcpConfig)
    const file = join(workdir, '.cursor', 'mcp.json')
    const first = await readFile(file, 'utf8')

    await ensureWorkspaceMcpConfig(workdir, mcpConfig)
    const second = await readFile(file, 'utf8')

    expect(first).toBe(second)
  })

  it('merges gladdis into an existing mcp.json without clobbering other servers', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'gladdis-mcp-'))
    const cursorDir = join(workdir, '.cursor')
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            other: { type: 'stdio', command: 'echo' }
          }
        },
        null,
        2
      ) + '\n'
    )

    const mcpConfig = JSON.stringify({
      mcpServers: {
        [CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]: {
          type: 'http',
          url: 'http://127.0.0.1:4321/mcp',
          headers: { Authorization: 'Bearer stable-token' }
        }
      }
    })

    await ensureWorkspaceMcpConfig(workdir, mcpConfig)
    const parsed = JSON.parse(await readFile(join(cursorDir, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }

    expect(parsed.mcpServers.other).toEqual({ type: 'stdio', command: 'echo' })
    expect(parsed.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]).toEqual(
      JSON.parse(mcpConfig).mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]
    )
  })
})

describe('CursorClient pause/resume', () => {
  it('tracks paused requests and resumes the send loop', () => {
    const client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() }
    )

    const child = new EventEmitter() as import('node:child_process').ChildProcess & EventEmitter
    child.kill = vi.fn()
    ;(client as any).activeProcesses.set('req-1', child)

    expect(client.pauseRequest('req-1')).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(client.pauseRequest('req-1')).toBe(false)

    let resumed = false
    ;(client as any).resumeResolvers.set('req-1', () => {
      resumed = true
    })

    expect(client.resumeRequest('req-1')).toBe(true)
    expect(resumed).toBe(true)
  })
})

describe('CursorClient bridge warming', () => {
  it('warms bridge and reuses it for subsequent turns', async () => {
    const mockDispose = vi.fn()
    const mockBridge = { dispose: mockDispose, env: {}, mcpConfig: '{}' }
    const createBridge = vi.fn().mockResolvedValue(mockBridge)

    const client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() },
      createBridge
    )

    // Warm the bridge
    await client.warmBridge()
    expect(createBridge).toHaveBeenCalledWith({
      conversationId: null,
      modelId: 'warmup',
      requestId: null
    })
    expect((client as any).warmedBridge).not.toBeNull()

    // Clear the mock to check it's not called again
    createBridge.mockClear()

    // Taking the warmed bridge clears the cache
    const taken = (client as any).takeWarmedBridge('/tmp/workspace', 'conv-1', 'model-1', 'req-1')
    expect(taken).toBe(mockBridge)
    expect((client as any).warmedBridge).toBeNull()

    // Taking again returns null (already consumed)
    const takenAgain = (client as any).takeWarmedBridge('/tmp/workspace', 'conv-2', 'model-2', 'req-2')
    expect(takenAgain).toBeNull()
  })

  it('clears warmed bridge when workspace changes', async () => {
    const mockDispose = vi.fn()
    const mockBridge = { dispose: mockDispose, env: {}, mcpConfig: '{}' }
    const createBridge = vi.fn().mockResolvedValue(mockBridge)

    let currentWorkspace = '/tmp/workspace-a'
    const client = new CursorClient(
      vi.fn(),
      () => currentWorkspace,
      { get: () => null, set: vi.fn() },
      createBridge
    )

    // Warm for workspace-a
    await client.warmBridge()
    expect((client as any).warmedBridge?.workdir).toBe('/tmp/workspace-a')

    // Change workspace and warm again
    currentWorkspace = '/tmp/workspace-b'
    await client.warmBridge()

    // Old bridge should be disposed, new one created for workspace-b
    expect(mockDispose).toHaveBeenCalled()
    expect(createBridge).toHaveBeenCalledTimes(2)
    expect((client as any).warmedBridge?.workdir).toBe('/tmp/workspace-b')
  })

  it('clears warmed bridge on explicit call', async () => {
    const mockDispose = vi.fn()
    const mockBridge = { dispose: mockDispose, env: {}, mcpConfig: '{}' }
    const createBridge = vi.fn().mockResolvedValue(mockBridge)

    const client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() },
      createBridge
    )

    await client.warmBridge()
    expect((client as any).warmedBridge).not.toBeNull()

    client.clearWarmedBridge()
    expect(mockDispose).toHaveBeenCalled()
    expect((client as any).warmedBridge).toBeNull()
  })

  it('does not warm if createBridgeSession is not provided', async () => {
    const client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() }
      // No createBridgeSession
    )

    await client.warmBridge()
    expect((client as any).warmedBridge).toBeNull()
  })
})

describe('CursorClient spawn mode', () => {
  function newClient(): CursorClient {
    return new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() }
    )
  }

  function lastSpawnArgs(): string[] {
    const call = spawnMock.mock.calls.at(-1)
    return (call?.[1] as string[]) ?? []
  }

  it('send() spawns agent turns with --force', async () => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeCursorChild('done'))
    const client = newClient()

    const req = {
      modelId: 'gpt-5.5-medium',
      messages: [{ role: 'user' as const, content: 'open example.com' }],
      conversationId: null,
      requestId: null
    } as any
    const result = await client.send(req, new AbortController().signal, 'sys', 'open example.com', 'agent')

    expect(result.text).toBe('done')
    const args = lastSpawnArgs()
    expect(args).toContain('--force')
    expect(args).not.toContain('--mode')
  })

  it('send() keeps plain turns in ask mode', async () => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeCursorChild('done'))
    const client = newClient()

    const req = {
      modelId: 'gpt-5.5-medium',
      messages: [{ role: 'user' as const, content: 'tell me a joke' }],
      conversationId: null,
      requestId: null
    } as any
    const result = await client.send(req, new AbortController().signal, 'sys', 'tell me a joke', 'ask')

    expect(result.text).toBe('done')
    const args = lastSpawnArgs()
    expect(args).toContain('--mode')
    expect(args).toContain('ask')
    expect(args).not.toContain('--force')
  })

  it('only approves MCPs when browser tools are enabled', async () => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeCursorChild('done'))
    const client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() },
      vi.fn().mockResolvedValue({ dispose: vi.fn(), env: {}, mcpConfig: '{}' })
    )

    const req = {
      modelId: 'gpt-5.5-medium',
      messages: [{ role: 'user' as const, content: 'open example.com' }],
      conversationId: null,
      requestId: null
    } as any

    await client.send(req, new AbortController().signal, 'sys', 'open example.com', 'agent', {
      enableBrowserTools: false
    })
    expect(lastSpawnArgs()).not.toContain('--approve-mcps')

    await client.send(req, new AbortController().signal, 'sys', 'open example.com', 'agent', {
      enableBrowserTools: true
    })
    expect(lastSpawnArgs()).toContain('--approve-mcps')
  })

  // The background utility path (titles, classification) genuinely has no tools,
  // so it stays in read-only ask mode.
  it('complete() spawns with --mode ask (no tools needed)', async () => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeCursorChild('A Title'))
    const client = newClient()

    await client.complete('gpt-5.5-medium', 'sys', 'name this chat')

    const args = lastSpawnArgs()
    expect(args).toContain('--mode')
    expect(args).toContain('ask')
    expect(args).not.toContain('--force')
  })
})
