import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawnMock = vi.fn()
const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args)
}))

import { classifyAssistantEvent, computeCursorEmitDelta, cursorToolOk, cursorToolPreview, ensureWorkspaceMcpConfig, formatCursorToolName, isMcpConfigWarm, normalizeCursorToolName, parseCursorModels, probeMcpConfigWarm, shouldEmitAssistantStreamText, CursorClient } from './CursorClient'
import { CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME } from '../claudeCode/browserTools'

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: unknown, res: { stdout: string; stderr: string }) => void
    const cmdArgs = args[1] as string[]
    if (cmdArgs?.[0] === '--version') {
      cb(null, { stdout: '2026.1.0', stderr: '' })
      return new EventEmitter()
    }
    if (cmdArgs?.[0] === 'models') {
      cb(null, { stdout: '', stderr: '' })
      return new EventEmitter()
    }
    if (cmdArgs?.[0] === 'status') {
      cb(null, { stdout: 'Logged in as test@example.com', stderr: '' })
      return new EventEmitter()
    }
    cb(null, { stdout: '', stderr: '' })
    return new EventEmitter()
  })
})

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

function makeCursorChildWithJsonLines(
  lines: Record<string, unknown>[],
  delayMs = 0
): import('node:child_process').ChildProcess {
  const child = new EventEmitter() as import('node:child_process').ChildProcess & EventEmitter
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  ;(child as any).stdout = stdout
  ;(child as any).stderr = stderr
  child.kill = vi.fn() as any
  setTimeout(() => {
    for (const line of lines) stdout.write(JSON.stringify(line) + '\n')
    stdout.end()
    stderr.end()
    child.emit('close', 0, null)
  }, delayMs)
  return child
}

describe('CursorClient assistant stream parsing', () => {
  it('parses live model catalogs from `agent models` output', () => {
    const models = parseCursorModels(`
Available models

composer-2.5 - Composer 2.5 (current)
composer-2.5-fast - Composer 2.5 Fast (default)
gpt-5.5-medium - GPT-5.5 1M

Tip: use --model <id> to switch.
`)

    expect(models).toEqual([
      { id: 'composer-2.5', label: 'Cursor · Composer 2.5', provider: 'cursor' },
      { id: 'composer-2.5-fast', label: 'Cursor · Composer 2.5 Fast', provider: 'cursor' },
      { id: 'gpt-5.5-medium', label: 'Cursor · GPT-5.5 1M', provider: 'cursor' }
    ])
  })

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

  it('maps Cursor native local tools to Gladdis-equivalent names', () => {
    expect(normalizeCursorToolName('shellToolCall')).toBe('run_command')
    expect(normalizeCursorToolName('runValidationToolCall')).toBe('run_validation')
    expect(
      formatCursorToolName({
        mcpToolCall: {
          serverName: 'gladdis',
          toolName: 'read_page'
        }
      })
    ).toBe('gladdis.read_page')
  })

  it('normalizes successful native validation results into actionable summaries', () => {
    expect(
      cursorToolPreview({
        runValidationToolCall: {
          args: { check: 'typecheck' },
          result: { success: true }
        }
      })
    ).toBe('typecheck: pass')
  })

  it('surfaces failed native validation results as provider-style tool errors', () => {
    expect(
      cursorToolPreview({
        runValidationToolCall: {
          args: { check: 'typecheck' },
          result: { success: false, stderr: 'src/main/index.ts:42 error TS2322' }
        }
      })
    ).toBe('[tool error] typecheck: src/main/index.ts:42 error TS2322')
    expect(
      cursorToolOk({
        runValidationToolCall: {
          args: { check: 'typecheck' },
          result: { status: 'failed', stderr: 'TS2322' }
        }
      })
    ).toBe(false)
  })

  it('keeps failed shell tool previews concise and scoped to the command', () => {
    expect(
      cursorToolPreview({
        shellToolCall: {
          args: { command: 'npm test -- CursorClient.test.ts' },
          result: {
            exitCode: 1,
            stderr: '\n FAIL  CursorClient.test.ts\n  expected true to be false\n'
          }
        }
      })
    ).toBe('[tool error] npm test -- CursorClient.test.ts: FAIL CursorClient.test.ts expected true to be false')
  })

  it('keeps successful edit previews scoped to the touched file', () => {
    expect(
      cursorToolPreview({
        editToolCall: {
          args: { path: 'src/main/index.ts' },
          result: { success: true }
        }
      })
    ).toBe('Edited src/main/index.ts')
  })

  it('surfaces failed no-op edits as actionable tool errors', () => {
    expect(
      cursorToolPreview({
        editToolCall: {
          args: { path: 'src/main/index.ts' },
          result: { success: false, message: 'old_string equals new_string; nothing to change' }
        }
      })
    ).toBe('[tool error] src/main/index.ts: old_string equals new_string; nothing to change')
  })

  it('avoids dumping raw file contents for successful reads', () => {
    expect(
      cursorToolPreview({
        readToolCall: {
          args: { path: 'src/main/index.ts', start_line: 10, end_line: 30 },
          result: { content: 'very long file body that should not become the preview' }
        }
      })
    ).toBe('Read src/main/index.ts (10-30)')
  })

  it('summarizes successful searches instead of falling back to vague text', () => {
    expect(
      cursorToolPreview({
        searchToolCall: {
          args: { query: 'runCursorWithRepairLoop' },
          result: { hits: [{ path: 'src/main/models/ChatService.ts' }, { path: 'src/main/models/ChatService.test.ts' }] }
        }
      })
    ).toBe('Search found 2 hit(s) for runCursorWithRepairLoop')
  })

  it('summarizes Gladdis MCP tool results from MCP content blocks', () => {
    expect(
      cursorToolPreview({
        mcpToolCall: {
          serverName: 'gladdis',
          toolName: 'read_page',
          args: { tabId: 'tab-1' },
          result: {
            content: [{ type: 'text', text: 'Page title: Example Domain\nURL: https://example.com' }]
          }
        }
      })
    ).toBe('Page title: Example Domain URL: https://example.com')
  })

  it('summarizes Gladdis act results through the current MCP surface', () => {
    expect(
      cursorToolPreview({
        mcpToolCall: {
          serverName: 'gladdis',
          toolName: 'act',
          args: { kind: 'click', query: 'Sign in' },
          result: {
            content: [{ type: 'text', text: 'act(click): clicked Sign in. Now at https://example.com/login' }]
          }
        }
      })
    ).toBe('act(click): clicked Sign in. Now at https://example.com/login')
  })

  it('surfaces failed Gladdis MCP tool results as actionable tool errors', () => {
    expect(
      cursorToolPreview({
        mcpToolCall: {
          serverName: 'gladdis',
          toolName: 'grep_click',
          args: { query: 'Sign in' },
          result: {
            isError: true,
            content: [{ type: 'text', text: 'No visible match for "Sign in".' }]
          }
        }
      })
    ).toBe('[tool error] Sign in: No visible match for "Sign in".')
    expect(
      cursorToolOk({
        mcpToolCall: {
          serverName: 'gladdis',
          toolName: 'grep_click',
          args: { query: 'Sign in' },
          result: { isError: true, content: [{ type: 'text', text: 'No visible match for "Sign in".' }] }
        }
      })
    ).toBe(false)
  })

  it('keeps long MCP read_page output compact in the UI preview', () => {
    const longBody = 'A'.repeat(400)
    const preview = cursorToolPreview({
      mcpToolCall: {
        serverName: 'gladdis',
        toolName: 'read_page',
        args: {},
        result: { content: [{ type: 'text', text: longBody }] }
      }
    })
    expect(preview.length).toBeLessThanOrEqual(280)
    expect(preview.endsWith('…')).toBe(true)
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
  it('warms the bridge server without retaining a warmup session', async () => {
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
    expect(mockDispose).toHaveBeenCalledTimes(1)
    expect((client as any).warmedBridge).toBeUndefined()
  })

  it('re-warms independently after a workspace change', async () => {
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
    expect(createBridge).toHaveBeenNthCalledWith(1, {
      conversationId: null,
      modelId: 'warmup',
      requestId: null
    })

    // Change workspace and warm again
    currentWorkspace = '/tmp/workspace-b'
    await client.warmBridge()

    // Each warmup session is disposed immediately.
    expect(mockDispose).toHaveBeenCalledTimes(2)
    expect(createBridge).toHaveBeenCalledTimes(2)
  })

  it('clearWarmedBridge is a safe no-op when no session is retained', async () => {
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
    client.clearWarmedBridge()
    expect(mockDispose).toHaveBeenCalledTimes(1)
    expect((client as any).warmedBridge).toBeUndefined()
  })

  it('does not warm if createBridgeSession is not provided', async () => {
    const client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      { get: () => null, set: vi.fn() }
      // No createBridgeSession
    )

    await client.warmBridge()
    expect((client as any).warmedBridge).toBeUndefined()
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

  it('resumes with queued user context instead of replaying the original prompt', async () => {
    spawnMock.mockReset()
    const queued = ['Use ripgrep instead of grep.']
    let client!: CursorClient
    let spawnCount = 0
    let sessionId: string | null = null
    spawnMock.mockImplementation(() => {
      spawnCount += 1
      if (spawnCount === 1) {
        const child = makeCursorChildWithJsonLines([
          { type: 'result', session_id: 'sess-1', result: 'first pass', subtype: 'success' }
        ], 10)
        setTimeout(() => {
          client.pauseRequest('req-1')
        }, 0)
        return child
      }
      return makeCursorChildWithJsonLines([
        { type: 'result', session_id: 'sess-1', result: 'resumed pass', subtype: 'success' }
      ])
    })

    client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      {
        get: vi.fn(() => sessionId),
        set: vi.fn((_conversationId: string, nextSessionId: string | null) => {
          sessionId = nextSessionId
        })
      }
    )

    const req = {
      modelId: 'gpt-5.5-medium',
      messages: [{ role: 'user' as const, content: 'search the repo with grep' }],
      conversationId: 'conv-1',
      requestId: 'req-1'
    } as any

    const sendPromise = client.send(
      req,
      new AbortController().signal,
      'sys',
      'search the repo with grep',
      'agent',
      {
        getQueuedContext: () => queued.shift() ?? null
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.resumeRequest('req-1')).toBe(true)
    const result = await sendPromise

    expect(result.text).toBe('resumed pass')
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const resumedArgs = spawnMock.mock.calls[1]?.[1] as string[]
    expect(resumedArgs).toContain('--resume')
    expect(resumedArgs).toContain('sess-1')
    expect(resumedArgs.at(-1)).toContain('Use ripgrep instead of grep.')
    expect(resumedArgs.at(-1)).not.toContain('search the repo with grep')
    expect(resumedArgs.at(-1)).not.toContain('[Conversation history]')
  })

  it('uses an explicit continue prompt when resuming without queued context', async () => {
    spawnMock.mockReset()
    let client!: CursorClient
    let spawnCount = 0
    let sessionId: string | null = null
    spawnMock.mockImplementation(() => {
      spawnCount += 1
      if (spawnCount === 1) {
        const child = makeCursorChildWithJsonLines([
          { type: 'result', session_id: 'sess-2', result: 'first pass', subtype: 'success' }
        ], 10)
        setTimeout(() => {
          client.pauseRequest('req-2')
        }, 0)
        return child
      }
      return makeCursorChildWithJsonLines([
        { type: 'result', session_id: 'sess-2', result: 'continued pass', subtype: 'success' }
      ])
    })

    client = new CursorClient(
      vi.fn(),
      () => '/tmp/workspace',
      {
        get: vi.fn(() => sessionId),
        set: vi.fn((_conversationId: string, nextSessionId: string | null) => {
          sessionId = nextSessionId
        })
      }
    )

    const req = {
      modelId: 'gpt-5.5-medium',
      messages: [{ role: 'user' as const, content: 'keep going' }],
      conversationId: 'conv-2',
      requestId: 'req-2'
    } as any

    const sendPromise = client.send(req, new AbortController().signal, 'sys', 'keep going', 'agent', {
      getQueuedContext: () => null
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.resumeRequest('req-2')).toBe(true)
    await sendPromise

    const resumedArgs = spawnMock.mock.calls[1]?.[1] as string[]
    expect(resumedArgs.at(-1)).toContain('Continue from where you left off.')
    expect(resumedArgs.at(-1)).not.toContain('[Conversation history]')
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

  it('lists live Cursor models from the CLI catalog', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: unknown, res: { stdout: string; stderr: string }) => void
      const cmdArgs = args[1] as string[]
      if (cmdArgs?.[0] === '--version') {
        cb(null, { stdout: '2026.1.0', stderr: '' })
        return new EventEmitter()
      }
      if (cmdArgs?.[0] === 'models') {
        cb(null, {
          stdout: [
            'Available models',
            '',
            'composer-2.5-fast - Composer 2.5 Fast (default)',
            'gpt-5.5-medium - GPT-5.5 1M',
            ''
          ].join('\n'),
          stderr: ''
        })
        return new EventEmitter()
      }
      cb(null, { stdout: '', stderr: '' })
      return new EventEmitter()
    })

    const client = newClient()
    await expect(client.listModels()).resolves.toEqual([
      { id: 'composer-2.5-fast', label: 'Cursor · Composer 2.5 Fast', provider: 'cursor' },
      { id: 'gpt-5.5-medium', label: 'Cursor · GPT-5.5 1M', provider: 'cursor' }
    ])
  })
})
