import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../../../shared/types'
import { CLAUDE_CODE_SYSTEM } from '../prompts'

const spawnMock = vi.fn()
const execFileMock = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock
}))

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null

  kill(): boolean {
    return true
  }
}

function installExecFileProbe(): void {
  ;(execFileMock as any)[promisify.custom] = vi.fn(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }))
  execFileMock.mockImplementation((
    _file: string,
    _args: string[],
    _options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void => {
    callback(null, 'claude 1.0.0\n', '')
  })
}

function emitJsonLine(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`)
}

describe('ClaudeCodeClient', () => {
  afterEach(() => {
    spawnMock.mockReset()
    execFileMock.mockReset()
    vi.resetModules()
  })

  it('passes memory guidance into Claude and surfaces memory tool calls from the live transcript path', async () => {
    installExecFileProbe()

    spawnMock.mockImplementation((_command: string, cliArgs: string[]) => {
      const child = new FakeChildProcess()

      queueMicrotask(() => {
        expect(cliArgs).toContain('--append-system-prompt')
        expect(cliArgs).toContain('--allowedTools')
        expect(cliArgs).toContain('mcp__gladdis__*')
        expect(cliArgs).toContain('--strict-mcp-config')

        const prompt = cliArgs[cliArgs.indexOf('--append-system-prompt') + 1]
        expect(prompt).toContain('call memory_read at the start of a task')
        expect(prompt).toContain('use memory_write to store decisions, constraints, identifiers, and partial findings')

        emitJsonLine(child.stdout, {
          type: 'stream_event',
          session_id: 'session-123',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_read',
              name: 'memory_read'
            }
          }
        })
        emitJsonLine(child.stdout, {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_read',
                content: [{ type: 'text', text: 'Workspace memory:\n- release_channel: beta' }]
              }
            ]
          }
        })
        emitJsonLine(child.stdout, {
          type: 'stream_event',
          session_id: 'session-123',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'toolu_write',
              name: 'memory_write'
            }
          }
        })
        emitJsonLine(child.stdout, {
          type: 'result',
          session_id: 'session-123',
          result: 'Kept going with the saved workspace context.',
          usage: {
            input_tokens: 120,
            output_tokens: 40
          }
        })
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })

      return child
    })

    const { ClaudeCodeClient } = await import('./ClaudeCodeClient')
    const emitted: ChatStreamEvent[] = []
    const sessions = {
      get: vi.fn(() => null),
      set: vi.fn()
    }
    const client = new ClaudeCodeClient(
      (event) => emitted.push(event),
      () => '/tmp/workspace',
      sessions,
      async () => ({
        dispose: vi.fn(),
        env: { GLADDIS_CLAUDE_BRIDGE: '1' },
        mcpConfig: JSON.stringify({
          mcpServers: {
            gladdis: {
              type: 'http',
              url: 'http://127.0.0.1:43123/mcp',
              headers: { Authorization: 'Bearer test-token' }
            }
          }
        })
      })
    )

    const text = await client.send(
      {
        requestId: 'req-1',
        conversationId: 'conv-1',
        modelId: 'claude-code',
        messages: []
      } as any,
      new AbortController().signal,
      CLAUDE_CODE_SYSTEM,
      'Continue the rollout and reuse whatever workspace context is already saved.'
    )

    expect(text).toBe('Kept going with the saved workspace context.')
    expect(sessions.set).toHaveBeenCalledWith('conv-1', 'session-123')
    expect(emitted).toEqual(
      expect.arrayContaining([
        {
          requestId: 'req-1',
          type: 'tool_call',
          tool: 'gladdis.memory_read',
          args: {},
          callId: 'toolu_read'
        },
        {
          requestId: 'req-1',
          type: 'tool_call',
          tool: 'gladdis.memory_write',
          args: {},
          callId: 'toolu_write'
        },
        {
          requestId: 'req-1',
          type: 'tool_result',
          callId: 'toolu_read',
          ok: true,
          preview: 'Workspace memory:\n- release_channel: beta',
          imageDataUrl: undefined
        }
      ])
    )
  })
})
