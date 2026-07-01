import { describe, expect, it, vi } from 'vitest'

// Electron is pulled in transitively by KeyStore; stub it like the other
// main-process tests so the module graph loads under vitest.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

// Every per-domain handler is mocked to an inert ack. This test asserts the
// DISPATCH wiring (does run() reach a handler for each tool name), not handler
// behaviour — so we must keep real handlers (navigate, run_command, write_file,
// …) from doing any real I/O.
const { ack } = vi.hoisted(() => ({ ack: async () => ({ ok: true, text: 'mocked' }) }))

vi.mock('./tools/driveTools', () => ({
  runAct: vi.fn(ack),
  runCdpCommand: vi.fn(ack),
  runExecuteInBrowser: vi.fn(ack),
  runNavigate: vi.fn(ack),
  runGrepClick: vi.fn(ack),
  runGrepType: vi.fn(ack)
}))
vi.mock('./tools/fsTools', () => ({
  runEditFile: vi.fn(ack),
  runListDir: vi.fn(ack),
  runReadFile: vi.fn(ack),
  runSearchFiles: vi.fn(ack),
  runWriteFile: vi.fn(ack)
}))
vi.mock('./tools/perceiveTools', () => ({
  runExtractStructured: vi.fn(ack),
  runGrepPage: vi.fn(ack),
  runReadA11y: vi.fn(ack),
  runReadPage: vi.fn(ack),
  runWaitForLoad: vi.fn(ack),
  runScreenshot: vi.fn(ack),
  runScreenshotApp: vi.fn(ack),
  runWatchNetwork: vi.fn(ack)
}))
vi.mock('./tools/searchTools', () => ({
  runSearchTool: vi.fn(ack)
}))
vi.mock('./tools/shellTools', () => ({ runShellCommand: vi.fn(ack) }))
vi.mock('./tools/historyTools', () => ({
  runRecallHistory: vi.fn(ack)
}))
vi.mock('./memory/memoryUsageLog', () => ({
  instrumentMemoryTool: vi.fn(async (_name: string, _meta: unknown, thunk: () => Promise<unknown>) => thunk()),
  memoryListHitCount: () => 0,
  memoryReadHitCount: () => 0,
  recallHistoryHitCount: () => 0
}))
vi.mock('./memoryStore', () => ({
  memoryWrite: vi.fn(ack),
  memoryRead: vi.fn(ack),
  memoryList: vi.fn(ack),
  memoryForget: vi.fn(ack),
  memoryCreateTask: vi.fn(ack)
}))

import { BrowserTools } from './browserTools'
import { AGENT_TOOLS, isKnownToolName } from './agentTools'
import { CODEX_BROWSER_TOOL_NAMES } from './codex/dynamicBrowserTools'
import { CURSOR_MCP_TOOL_NAMES } from './claudeCode/browserTools'

// Profiles + request_tools were retired: AGENT_TOOLS is the whole dispatchable
// surface, offered every turn.
const DISPATCHABLE_NAMES = AGENT_TOOLS.map((tool) => tool.name)

describe('tool surface coverage', () => {
  it('leads the registry with web search and has no tool-discovery verb', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name)
    // The full surface is offered every turn, so the search_tool discovery
    // hatch is retired — there is no routed-away subset to discover.
    expect(names).not.toContain('search_tool')
    expect(names[0]).toBe('search')
  })

  it('dispatches every registered tool — no tool resolves to "Unknown tool"', async () => {
    const tools = new BrowserTools({} as any, {} as any, {} as any)
    // A workspace root lets memory_* proceed into their (mocked) store instead
    // of short-circuiting, exercising the real dispatch arm for those names.
    tools.setWorkspaceRoot('/tmp/gladdis-vitest-ws')
    const ctx = {
      tabId: 'tab-1',
      requestId: 'req-1',
      conversationId: 'conv-1',
      taskId: 'task-1',
      workspaceRoot: '/tmp/gladdis-vitest-ws'
    } as any

    const unknown: string[] = []
    for (const name of DISPATCHABLE_NAMES) {
      const result = await tools.run(name, {}, ctx)
      if (result.text === `Unknown tool: ${name}`) unknown.push(name)
    }

    expect(unknown, `these registered tools have no dispatch arm in BrowserTools.run: ${unknown.join(', ')}`).toEqual([])
  })

  it('keeps the Codex MCP allowlist free of dead tool references', () => {
    for (const name of CODEX_BROWSER_TOOL_NAMES) {
      expect(isKnownToolName(name), `CODEX_BROWSER_TOOL_NAMES references unknown tool "${name}"`).toBe(true)
    }
  })

  it('keeps the Cursor/Claude MCP allowlist free of dead tool references', () => {
    for (const name of CURSOR_MCP_TOOL_NAMES) {
      expect(isKnownToolName(name), `CURSOR_MCP_TOOL_NAMES references unknown tool "${name}"`).toBe(true)
    }
  })

  it('keeps the Codex and Cursor/Claude MCP surfaces in parity', () => {
    // Both embedded-CLI runtimes supply their own native FS/shell, so neither
    // surface carries raw filesystem tools — but the Gladdis-native families
    // (browser, search, memory notebook, recall_history) should be identical.
    // Divergence here means one runtime is silently missing a capability its
    // own instruction prose may already promise.
    const codex = [...CODEX_BROWSER_TOOL_NAMES].sort()
    const cursor = [...CURSOR_MCP_TOOL_NAMES].sort()
    expect(codex).toEqual(cursor)

    // And both must exclude raw FS/shell (those belong to the native CLI).
    const nativeOnly = ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'run_command']
    for (const name of nativeOnly) {
      expect(CODEX_BROWSER_TOOL_NAMES.has(name), `Codex surface should not attach native tool "${name}"`).toBe(false)
      expect(CURSOR_MCP_TOOL_NAMES.has(name), `Cursor surface should not attach native tool "${name}"`).toBe(false)
    }
  })
})
