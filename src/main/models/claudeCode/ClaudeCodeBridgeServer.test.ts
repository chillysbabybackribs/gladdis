import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ClaudeCodeBridgeServer } from './ClaudeCodeBridgeServer'
import {
  CLAUDE_CODE_BROWSER_INSTRUCTIONS,
  CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME,
  CURSOR_MCP_TOOL_NAMES
} from './browserTools'

describe('ClaudeCodeBridgeServer', () => {
  const servers = new Set<ClaudeCodeBridgeServer>()

  afterEach(async () => {
    await Promise.allSettled([...servers].map((server) => server.close()))
    servers.clear()
  })

  it('teaches Claude Code to use memory tools as a working notebook', () => {
    expect(CLAUDE_CODE_BROWSER_INSTRUCTIONS).toContain('use the memory_* tools as a lightweight notebook')
    expect(CLAUDE_CODE_BROWSER_INSTRUCTIONS).toContain('call memory_read before re-asking for context that may already be known')
    expect(CLAUDE_CODE_BROWSER_INSTRUCTIONS).toContain('use memory_write for durable decisions/constraints/identifiers')
    expect(CLAUDE_CODE_BROWSER_INSTRUCTIONS).toContain('use memory_create_task for task-specific notes')
    expect(CLAUDE_CODE_BROWSER_INSTRUCTIONS).toContain('Store concise, reusable facts rather than large transcript dumps')
  })

  it('exposes Claude browser tools over direct HTTP MCP', async () => {
    const run = vi.fn(async (name: string) => {
      if (name === 'memory_read') {
        return {
          ok: true,
          text: 'Workspace memory:\n- theme: {"accent":"orange"}',
          imageBase64: null,
          structuredContent: {
            scope: 'workspace',
            updatedAt: '2026-06-30T00:00:00.000Z',
            values: {
              theme: { accent: 'orange' }
            }
          }
        }
      }

      return {
        ok: true,
        text: 'tool ok',
        imageBase64: null,
        structuredContent: {
          workspaceRoot: '/tmp/workspace',
          packageManager: 'npm',
          packageName: 'demo',
          scripts: ['build', 'test'],
          keyFiles: ['package.json'],
          topDirectories: ['src'],
          entryPoints: ['src/main.ts']
        }
      }
    })
    const bridge = new ClaudeCodeBridgeServer(
      {
        run,
        tabs: { activeTabId: 'tab-1', create: () => ({ id: 'tab-created' }) },
        getWorkspaceRoot: () => '/tmp/workspace'
      } as any,
      vi.fn()
    )
    servers.add(bridge)

    const registration = await bridge.registerSession({
      conversationId: 'conv-1',
      modelId: 'claude-code',
      requestId: 'req-1',
      browserLlm: vi.fn()
    })

    const config = JSON.parse(registration.mcpConfig) as {
      mcpServers: Record<string, { type: string, url: string, headers: Record<string, string> }>
    }

    expect(config.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]).toEqual(
      expect.objectContaining({
        type: 'http',
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /)
        })
      })
    )

    const client = new Client({ name: 'vitest-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(config.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME].url),
      {
        requestInit: {
          headers: config.mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME].headers
        }
      }
    )

    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('read_page')
    expect(tools.tools.map((tool) => tool.name)).toContain('read_a11y')
    expect(tools.tools.find((tool) => tool.name === 'recall_history')).toEqual(
      expect.objectContaining({
        outputSchema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            mode: expect.objectContaining({ type: 'string' }),
            matches: expect.anything()
          })
        })
      })
    )
    expect(tools.tools.find((tool) => tool.name === 'memory_read')).toEqual(
      expect.objectContaining({
        outputSchema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            scope: expect.objectContaining({ type: 'string' }),
            values: expect.anything()
          })
        })
      })
    )
    expect(tools.tools.find((tool) => tool.name === 'repo_overview')).toEqual(
      expect.objectContaining({
        outputSchema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            workspaceRoot: expect.objectContaining({ type: 'string' }),
            packageName: expect.anything()
          })
        })
      })
    )

    const result = await client.callTool({
      name: 'repo_overview',
      arguments: { focus: 'bridge test' }
    })

    expect(run).toHaveBeenCalledWith(
      'repo_overview',
      { focus: 'bridge test' },
      expect.objectContaining({
        tabId: 'tab-1',
        conversationId: 'conv-1',
        requestId: 'req-1',
        workspaceRoot: '/tmp/workspace'
      })
    )
    expect(result.content).toEqual([{ type: 'text', text: 'tool ok' }])
    expect(result.structuredContent).toEqual({
      workspaceRoot: '/tmp/workspace',
      packageManager: 'npm',
      packageName: 'demo',
      scripts: ['build', 'test'],
      keyFiles: ['package.json'],
      topDirectories: ['src'],
      entryPoints: ['src/main.ts']
    })

    const memoryResult = await client.callTool({
      name: 'memory_read',
      arguments: { scope: 'workspace', keys: ['theme'] }
    })

    expect(run).toHaveBeenCalledWith(
      'memory_read',
      { scope: 'workspace', keys: ['theme'] },
      expect.objectContaining({
        tabId: 'tab-1',
        conversationId: 'conv-1',
        requestId: 'req-1',
        workspaceRoot: '/tmp/workspace'
      })
    )
    expect(memoryResult.content).toEqual([
      { type: 'text', text: 'Workspace memory:\n- theme: {"accent":"orange"}' }
    ])
    expect(memoryResult.structuredContent).toEqual({
      scope: 'workspace',
      updatedAt: '2026-06-30T00:00:00.000Z',
      values: {
        theme: { accent: 'orange' }
      }
    })

    await transport.close()
    registration.dispose()
  })

  // Regression: MCP clients (Cursor's `agent` CLI, Claude Code CLI) probe
  // resources/list and prompts/list right after initialize. The server must
  // answer with empty lists, not `-32601 Method not found` ("Failed to list MCP
  // resources").
  it('answers resources/list and prompts/list with empty lists, not -32601', async () => {
    const bridge = new ClaudeCodeBridgeServer(
      {
        run: vi.fn(),
        tabs: { activeTabId: 'tab-1', create: () => ({ id: 'tab-created' }) },
        getWorkspaceRoot: () => '/tmp/workspace'
      } as any,
      vi.fn()
    )
    servers.add(bridge)

    const registration = await bridge.registerSession({
      conversationId: 'conv-1',
      modelId: 'cursor',
      requestId: 'req-1',
      browserLlm: vi.fn()
    })
    const server = JSON.parse(registration.mcpConfig).mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]

    const client = new Client({ name: 'vitest-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers }
    })
    await client.connect(transport)

    await expect(client.listResources()).resolves.toEqual(
      expect.objectContaining({ resources: [] })
    )
    await expect(client.listResourceTemplates()).resolves.toEqual(
      expect.objectContaining({ resourceTemplates: [] })
    )
    await expect(client.listPrompts()).resolves.toEqual(
      expect.objectContaining({ prompts: [] })
    )

    await transport.close()
    registration.dispose()
  })

  it('reuses a stable bearer token when persistTokenKey is set', async () => {
    const bridge = new ClaudeCodeBridgeServer(
      {
        run: vi.fn(),
        tabs: { activeTabId: 'tab-1', create: () => ({ id: 'tab-created' }) },
        getWorkspaceRoot: () => '/tmp/workspace'
      } as any,
      vi.fn()
    )
    servers.add(bridge)

    const session = {
      conversationId: 'conv-1',
      modelId: 'composer-2.5',
      requestId: 'req-1',
      browserLlm: vi.fn()
    }

    const first = await bridge.registerSession(session, { persistTokenKey: '/tmp/workspace' })
    const second = await bridge.registerSession(
      { ...session, requestId: 'req-2' },
      { persistTokenKey: '/tmp/workspace' }
    )

    const firstAuth =
      JSON.parse(first.mcpConfig).mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME].headers.Authorization
    const secondAuth =
      JSON.parse(second.mcpConfig).mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME].headers.Authorization

    expect(firstAuth).toBe(secondAuth)
    first.dispose()
    second.dispose()
  })

  it('can scope a session to the reduced Cursor MCP tool surface', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      text: 'tool ok',
      imageBase64: null
    }))
    const bridge = new ClaudeCodeBridgeServer(
      {
        run,
        tabs: { activeTabId: 'tab-1', create: () => ({ id: 'tab-created' }) },
        getWorkspaceRoot: () => '/tmp/workspace'
      } as any,
      vi.fn()
    )
    servers.add(bridge)

    const registration = await bridge.registerSession({
      conversationId: 'conv-1',
      modelId: 'cursor',
      requestId: 'req-1',
      allowedToolNames: CURSOR_MCP_TOOL_NAMES,
      browserLlm: vi.fn()
    })

    const server = JSON.parse(registration.mcpConfig).mcpServers[CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME]
    const client = new Client({ name: 'vitest-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers }
    })
    await client.connect(transport)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    expect(names).toContain('read_page')
    expect(names).toContain('read_a11y')
    expect(names).toContain('memory_read')
    // Gladdis-native repo intelligence is now attached (it is not redundant with
    // Cursor's native grep — it returns bounded, architecture-aware digests).
    expect(names).toContain('repo_overview')
    expect(names).toContain('search_repo')
    expect(names).toContain('verify_change')
    // Raw FS/shell stays off this surface — the CLI runtime supplies it natively.
    expect(names).not.toContain('read_file')
    expect(names).not.toContain('run_command')

    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: 'should-not-be-exposed.ts' }
    })
    expect(result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()

    await transport.close()
    registration.dispose()
  })
})
