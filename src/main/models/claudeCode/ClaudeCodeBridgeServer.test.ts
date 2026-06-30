import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ClaudeCodeBridgeServer } from './ClaudeCodeBridgeServer'
import { CLAUDE_CODE_BROWSER_TOOL_SERVER_NAME } from './browserTools'

describe('ClaudeCodeBridgeServer', () => {
  const servers = new Set<ClaudeCodeBridgeServer>()

  afterEach(async () => {
    await Promise.allSettled([...servers].map((server) => server.close()))
    servers.clear()
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
})
