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
// behaviour — so we must keep real handlers (navigate, run_command,
// publish_changes, write_file, dev server, …) from doing any real I/O.
const { ack } = vi.hoisted(() => ({ ack: async () => ({ ok: true, text: 'mocked' }) }))

vi.mock('./tools/driveTools', () => ({
  runClickXY: vi.fn(ack),
  runCdpCommand: vi.fn(ack),
  runExecuteInBrowser: vi.fn(ack),
  runNavigate: vi.fn(ack),
  runPressKey: vi.fn(ack),
  runTypeText: vi.fn(ack),
  runGrepClick: vi.fn(ack),
  runGrepType: vi.fn(ack)
}))
vi.mock('./tools/clipboardTools', () => ({
  runReadClipboard: vi.fn(ack),
  runWriteClipboard: vi.fn(ack)
}))
vi.mock('./tools/fsTools', () => ({
  runEditFile: vi.fn(ack),
  runListDir: vi.fn(ack),
  runReadFile: vi.fn(ack),
  runSearchFiles: vi.fn(ack),
  runWriteFile: vi.fn(ack)
}))
vi.mock('./tools/perceiveTools', () => ({
  runGrepPage: vi.fn(ack),
  runReadA11y: vi.fn(ack),
  runReadPage: vi.fn(ack),
  runScreenshot: vi.fn(ack),
  runScreenshotApp: vi.fn(ack),
  runWatchNetwork: vi.fn(ack)
}))
vi.mock('./tools/repoCapabilityTools', () => ({
  runReadSpans: vi.fn(ack),
  runRepoGrepTask: vi.fn(ack),
  runRepoOverview: vi.fn(ack),
  runResearchDossier: vi.fn(ack),
  runSearchRepo: vi.fn(ack),
  runVerifyChange: vi.fn(ack)
}))
vi.mock('./tools/searchTools', () => ({
  runDeepSearchTool: vi.fn(ack),
  runFetchPage: vi.fn(ack),
  runSearchOpenTool: vi.fn(ack),
  runSearchTool: vi.fn(ack)
}))
vi.mock('./tools/shellTools', () => ({ runShellCommand: vi.fn(ack) }))
vi.mock('./tools/devServerTool', () => ({ runLaunchWebDevServer: vi.fn(ack) }))
vi.mock('./tools/taskTools', () => ({
  runAuditCodebase: vi.fn(ack),
  runBrowseTask: vi.fn(ack),
  runPublishChanges: vi.fn(ack),
  runValidation: vi.fn(ack)
}))
vi.mock('./tools/historyTools', () => ({
  runRecallHistory: vi.fn(ack),
  runRequestTools: vi.fn(ack)
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
import { AGENT_TOOLS, isKnownToolName, selectAgentToolProfile, toolGroupNames } from './agentTools'
import { CODEX_BROWSER_TOOL_NAMES } from './codex/dynamicBrowserTools'
import { CURSOR_MCP_TOOL_NAMES } from './claudeCode/browserTools'

// request_tools is added to every profile via withEscalation rather than living
// in AGENT_TOOLS, so it must be checked explicitly alongside the registry.
const DISPATCHABLE_NAMES = [...AGENT_TOOLS.map((tool) => tool.name), 'request_tools']

describe('tool surface coverage', () => {
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

  it('keeps every registered tool reachable from a cold start (conversation profile + group escalation)', () => {
    // The lean cold-start profile when no folder/browser/research intent is detected.
    const coldStart = new Set(selectAgentToolProfile('hello there').tools.map((tool) => tool.name))
    const viaGroups = new Set([
      ...toolGroupNames('filesystem'),
      ...toolGroupNames('browser'),
      ...toolGroupNames('research')
    ])

    const unreachable = DISPATCHABLE_NAMES.filter((name) => !coldStart.has(name) && !viaGroups.has(name))
    expect(
      unreachable,
      `these tools are in no cold-start profile and no requestable group, so a fresh turn can only reach them by guessing the exact name: ${unreachable.join(', ')}`
    ).toEqual([])
  })

  it('exposes only real tools through the requestable groups', () => {
    for (const group of ['filesystem', 'browser', 'research'] as const) {
      for (const name of toolGroupNames(group)) {
        expect(isKnownToolName(name), `group "${group}" references unknown tool "${name}"`).toBe(true)
      }
    }
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
    // (browser, search, repo-intel, memory notebook, recall_history) should be
    // identical. Divergence here means one runtime is silently missing a
    // capability its own instruction prose may already promise.
    const codex = [...CODEX_BROWSER_TOOL_NAMES].sort()
    const cursor = [...CURSOR_MCP_TOOL_NAMES].sort()
    expect(codex).toEqual(cursor)

    // And both must exclude raw FS/shell (those belong to the native CLI).
    const nativeOnly = ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'run_command', 'run_validation', 'publish_changes', 'launch_web_dev_server']
    for (const name of nativeOnly) {
      expect(CODEX_BROWSER_TOOL_NAMES.has(name), `Codex surface should not attach native tool "${name}"`).toBe(false)
      expect(CURSOR_MCP_TOOL_NAMES.has(name), `Cursor surface should not attach native tool "${name}"`).toBe(false)
    }
  })
})
