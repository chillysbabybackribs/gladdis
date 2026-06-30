import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { classifyAssistantEvent, ensureWorkspaceMcpConfig, isMcpConfigWarm, shouldEmitAssistantStreamText } from './CursorClient'
import { CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME } from '../claudeCode/browserTools'

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
