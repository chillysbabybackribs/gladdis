import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

import { BrowserTools } from './browserTools'

describe('BrowserTools', () => {
  it('formats undefined execute_in_browser results without failing the tool call', async () => {
    const tools = new BrowserTools({
      executeJavaScript: vi.fn(async () => ({ success: true, result: undefined })),
      runWithPendingNetworkCapture: vi.fn(async (_tabId: string, fn: () => Promise<any>) => ({
        value: await fn(),
        network: null
      }))
    } as any, {} as any, {} as any)

    const result = await tools.run('execute_in_browser', { code: '"test"' }, { tabId: 'tab-1' })

    expect(result).toEqual({
      ok: true,
      text: 'undefined',
      structuredContent: {
        code: '"test"',
        result: null
      }
    })
  })

  it('adds a same-tool recalibration hint when read_a11y fails', async () => {
    const tools = new BrowserTools({ getTabUrl: vi.fn(() => 'https://example.com') } as any, {} as any, {} as any)
    const result = await tools.run(
      'read_a11y',
      {},
      { tabId: 'tab-1', conversationId: 'conv-1', workspaceRoot: '/tmp/ws', iteration: 2 }
    )

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Recalibration hint:')
    expect(result.text).toContain('retry read_a11y first')
    expect(result.text).toContain('viewportOnly')
  })

  it('returns structured content for memory workspace reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-memory-workspace-'))
    const chats = {
      get: vi.fn(),
      list: vi.fn(() => []),
      search: vi.fn(() => []),
      lineage: vi.fn(() => []),
      previousConversation: vi.fn(() => null)
    }
    const tools = new BrowserTools({} as any, {} as any, chats as any)
    tools.setWorkspaceRoot(dir)

    const write = await tools.run(
      'memory_write',
      { scope: 'workspace', key: 'theme', value: { accent: 'orange' } },
      { tabId: 'tab-1', conversationId: 'conv-1' }
    )
    expect(write.ok).toBe(true)
    expect(write.structuredContent).toEqual({
      scope: 'workspace',
      key: 'theme',
      value: { accent: 'orange' },
      conversationId: 'conv-1',
      action: 'written'
    })

    const read = await tools.run(
      'memory_read',
      { scope: 'workspace', keys: ['theme', 'missing'] },
      { tabId: 'tab-1', conversationId: 'conv-1' }
    )
    expect(read.ok).toBe(true)
    expect(read.structuredContent).toEqual({
      scope: 'workspace',
      updatedAt: expect.any(String),
      values: {
        theme: { accent: 'orange' },
        missing: null
      }
    })
  })

  it('returns structured content for recall_history tool-call lookups', async () => {
    const tools = new BrowserTools({} as any, {} as any, {} as any)

    const result = await tools.run(
      'recall_history',
      { tool_call_id: 'tool-123' },
      {
        tabId: 'tab-1',
        fullResults: new Map([['tool-123', 'saved tool output']])
      }
    )

    expect(result).toEqual({
      ok: true,
      text: 'saved tool output',
      structuredContent: {
        mode: 'tool_call_result',
        toolCallId: 'tool-123',
        resultText: 'saved tool output'
      }
    })
  })

  it('returns small files whole by default instead of forcing a second range call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-read-small-file-'))
    const file = join(dir, 'small.txt')
    await writeFile(file, Array.from({ length: 160 }, (_, i) => `line ${i + 1}`).join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run('read_file', { path: file }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('showing lines 1-160 of 160')
    expect(result.text).not.toContain('default window')
    expect(result.text).toContain('line 160')
  })

  it('returns a bounded default read_file window with search-first guidance for large files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-read-file-'))
    const file = join(dir, 'large.txt')
    await writeFile(file, Array.from({ length: 260 }, (_, i) => `line ${i + 1}`).join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run('read_file', { path: file }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('showing lines 1-120 of 260; default window')
    expect(result.text).toContain('Prefer search_files or a narrower read_file window before reading more.')
    expect(result.text).toContain('"start_line":121')
    expect(result.text).toContain('line 120')
    expect(result.text).not.toContain('line 121')
  })

  it('resolves relative file paths from the selected workspace folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-workspace-root-'))
    await writeFile(join(dir, 'picked.txt'), 'from selected folder')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    const result = await tools.run('read_file', { path: 'picked.txt' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain(join(dir, 'picked.txt'))
    expect(result.text).toContain('from selected folder')
  })

  it('turns a missing-file read into an actionable near-match hint', async () => {
    // The exact trace case: model guesses vite.config.ts; the real file is
    // electron.vite.config.ts. The error must point at the near match so the
    // model fixes it in one step instead of needing a separate list_dir.
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-read-miss-'))
    await writeFile(join(dir, 'electron.vite.config.ts'), 'export default {}')
    await writeFile(join(dir, 'package.json'), '{}')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    const result = await tools.run('read_file', { path: 'vite.config.ts' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(false)
    expect(result.text).toContain('does not exist')
    expect(result.text).toContain('electron.vite.config.ts')
    // The raw Node ENOENT text is replaced by guidance.
    expect(result.text).not.toContain('ENOENT')
  })

  it('falls back to a list_dir suggestion when nothing is similar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-read-miss2-'))
    await writeFile(join(dir, 'totally-unrelated.md'), 'x')
    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    const result = await tools.run('read_file', { path: 'zzz.ts' }, { tabId: 'tab-1' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('list_dir')
  })

  it('returns search_files hits with context and a suggested narrow read range', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-files-'))
    const file = join(dir, 'source.ts')
    await writeFile(file, [
      'const first = 1',
      'function targetThing() {',
      '  return first',
      '}',
      'const last = 2'
    ].join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, query: 'targetThing', glob: '*.ts', context_lines: 1, max_results: 5 },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file}:2: function targetThing() {`)
    expect(result.text).toContain(`read_file({"path":"${file}","start_line":1,"end_line":3})`)
    expect(result.text).toContain('1: const first = 1')
    expect(result.text).toContain('3:   return first')
  })

  it('accepts common model aliases for search_files query', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-alias-'))
    const file = join(dir, 'source.ts')
    await writeFile(file, 'export const aliasNeedle = true\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, pattern: 'aliasNeedle', glob: '*.ts' },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file}:1: export const aliasNeedle = true`)
  })

  it('unwraps shell-style wildcard patterns for fixed-string search_files calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-wildcard-'))
    const file = join(dir, 'source.ts')
    await writeFile(file, 'export const wildcardNeedle = true\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, pattern: '*wildcardNeedle*', glob: '*.ts' },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file}:1: export const wildcardNeedle = true`)
  })

  it('treats pipe-separated model search terms as alternatives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-pipe-'))
    const file = join(dir, 'memory.ts')
    await writeFile(file, [
      'export class ChatStore {}',
      'export function recallHistory() {}'
    ].join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, query: 'memory|recall_history|ChatStore', glob: '*.ts' },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file}:1: export class ChatStore {}`)
  })

  it('defaults search_files to the selected workspace folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-workspace-root-'))
    const file = join(dir, 'only-here.ts')
    await writeFile(file, 'export const selectedFolderNeedle = true\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    const result = await tools.run(
      'search_files',
      { query: 'selectedFolderNeedle', glob: '*.ts' },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file}:1: export const selectedFolderNeedle = true`)
  })

  it('supports regex search_files queries for targeted code lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-regex-'))
    const file = join(dir, 'routes.ts')
    await writeFile(file, [
      'export function readFileRoute() {}',
      'export function writeFileRoute() {}'
    ].join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, query: 'read\\w+Route', glob: '*.ts', regex: true, context_lines: 0 },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file}:1: export function readFileRoute() {}`)
    expect(result.text).not.toContain('writeFileRoute')
  })

  it('uses smart-case so uppercase symbol queries stay precise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-smart-case-'))
    const file = join(dir, 'symbols.ts')
    await writeFile(file, [
      'export class ChatStore {}',
      'export const chatstore = "lowercase"',
      'export const chatStore = "mixed"'
    ].join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const exactCase = await tools.run(
      'search_files',
      { path: dir, query: 'ChatStore', glob: '*.ts', context_lines: 0 },
      { tabId: 'tab-1' }
    )
    const broadCase = await tools.run(
      'search_files',
      { path: dir, query: 'chatstore', glob: '*.ts', context_lines: 0 },
      { tabId: 'tab-1' }
    )

    expect(exactCase.ok).toBe(true)
    expect(exactCase.text).toContain(`${file}:1: export class ChatStore {}`)
    expect(exactCase.text).not.toContain('chatstore = "lowercase"')
    expect(exactCase.text).not.toContain('chatStore = "mixed"')
    expect(broadCase.ok).toBe(true)
    expect(broadCase.text).toContain(`${file}:1: export class ChatStore {}`)
    expect(broadCase.text).toContain(`${file}:2: export const chatstore = "lowercase"`)
  })

  it('returns file-path hits for fixed-string searches even when the file body lacks the query', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-path-hit-'))
    const file = join(dir, 'SearchCoordinator.ts')
    await writeFile(file, 'export function planSearch() { return true }\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, query: 'SearchCoordinator', glob: '*.ts', max_results: 5 },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain(`${file} [path hit]`)
    expect(result.text).toContain(`read_file({"path":"${file}"})`)
    expect(result.text).toContain('path match: SearchCoordinator.ts')
  })

  it('ranks exact file-name hits ahead of weaker content-only mentions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-ranked-paths-'))
    const exactFile = join(dir, 'ChatStore.ts')
    const weakContentFile = join(dir, 'notes.ts')
    await writeFile(exactFile, 'export function unrelatedHelper() { return "ok" }\n')
    await writeFile(weakContentFile, 'const label = "ChatStore"\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run(
      'search_files',
      { path: dir, query: 'ChatStore', glob: '*.ts', max_results: 5, context_lines: 0 },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    const pathHitIndex = result.text.indexOf(`${exactFile} [path hit]`)
    const contentHitIndex = result.text.indexOf(`${weakContentFile}:1: const label = "ChatStore"`)
    expect(pathHitIndex).toBeGreaterThanOrEqual(0)
    expect(contentHitIndex).toBeGreaterThanOrEqual(0)
    expect(pathHitIndex).toBeLessThan(contentHitIndex)
  })

  it('recalls linked continuation history as a brief overview across fresh chats', async () => {
    const chats = {
      lineage: vi.fn(() => [
        {
          id: 'child',
          title: 'Fresh chat',
          summary: 'User wants to continue the work.',
          createdAt: 2,
          updatedAt: 2,
          continuesFromId: 'parent',
          messages: [
            { role: 'user', text: 'continue the work' }
          ]
        },
        {
          id: 'parent',
          title: 'Previous chat',
          summary: 'The chosen direction was the blue layout.',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { role: 'user', text: 'we chose the blue layout' },
            { role: 'assistant', text: 'I will carry that forward.' }
          ]
        }
      ])
    }
    const tools = new BrowserTools({} as any, {} as any, chats as any)

    const index = await tools.run('recall_history', {}, { tabId: 'tab-1', conversationId: 'child' })
    const search = await tools.run(
      'recall_history',
      { query: 'blue layout' },
      { tabId: 'tab-1', conversationId: 'child' }
    )

    expect(chats.lineage).toHaveBeenCalledWith('child')
    expect(index.ok).toBe(true)
    expect(index.text).toContain('Brief conversation overview across 2 linked chats')
    expect(index.text).toContain('Current chat')
    expect(index.text).toContain('Previous chat: Previous chat')
    expect(index.text).toContain('User wants to continue the work.')
    expect(index.text).toContain('The chosen direction was the blue layout.')
    expect(search.ok).toBe(true)
    expect(search.text).toContain('1 matching turn')
    expect(search.text).toContain('we chose the blue layout')
  })

  it('falls back to the most recent previous chat when a fresh chat has no explicit lineage', async () => {
    const chats = {
      lineage: vi.fn(() => [
        {
          id: 'fresh',
          title: 'Fresh chat',
          summary: 'User asked to pick up where they left off.',
          createdAt: 2,
          updatedAt: 20,
          continuesFromId: null,
          messages: [
            { role: 'user', text: 'pick up where we left off' }
          ]
        }
      ]),
      previousConversation: vi.fn(() => ({
        id: 'previous',
        title: 'Previous chat',
        summary: 'The important context is the blue layout.',
        createdAt: 1,
        updatedAt: 10,
        messages: [
          { role: 'user', text: 'the important context is the blue layout' },
          { role: 'assistant', text: 'I will remember that direction.' }
        ]
      }))
    }
    const tools = new BrowserTools({} as any, {} as any, chats as any)

    const result = await tools.run('recall_history', {}, { tabId: 'tab-1', conversationId: 'fresh' })

    expect(chats.previousConversation).toHaveBeenCalledWith('fresh')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Previous chat: Previous chat')
    expect(result.text).toContain('The important context is the blue layout.')
  })

  it('searches all saved chats only when recall_history scope is explicitly all', async () => {
    const chats = {
      search: vi.fn(() => [
        {
          conversationId: 'conv-9',
          title: 'Older browser chat',
          summary: 'Browser ownership lived in the main process.',
          createdAt: 1,
          updatedAt: 2,
          continuesFromId: null,
          role: 'user',
          messageIndex: 0,
          excerpt: '…browser ownership lived in the main process…',
          score: 42
        }
      ])
    }
    const tools = new BrowserTools({} as any, {} as any, chats as any)

    const result = await tools.run(
      'recall_history',
      { query: 'browser ownership', scope: 'all' },
      { tabId: 'tab-1' }
    )

    expect(chats.search).toHaveBeenCalledWith('browser ownership', 8)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Found 1 saved chat match')
    expect(result.text).toContain('Older browser chat')
    expect(result.text).toContain('conv-9')
    expect(result.text).toContain('Browser ownership lived in the main process.')
    expect(result.text).toContain('browser ownership lived in the main process')
  })

  it('lists recent saved chats when global recall has no query', async () => {
    const chats = {
      list: vi.fn(() => [
        {
          id: 'conv-new',
          title: 'Newest chat',
          summary: 'We were fixing Gladdis chat history recall.',
          createdAt: 1,
          updatedAt: 20,
          continuesFromId: null
        },
        {
          id: 'conv-old',
          title: 'Older chat',
          summary: 'Earlier work.',
          createdAt: 1,
          updatedAt: 10,
          continuesFromId: null
        }
      ])
    }
    const tools = new BrowserTools({} as any, {} as any, chats as any)

    const result = await tools.run('recall_history', { scope: 'all' }, { tabId: 'tab-1' })

    expect(chats.list).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Recent saved Gladdis conversations')
    expect(result.text).toContain('conv-new')
    expect(result.text).toContain('We were fixing Gladdis chat history recall.')
    expect(result.text).toContain('Use conversation_id to read the full saved chat')
  })

  it('reads a requested saved conversation in full by id', async () => {
    const chats = {
      get: vi.fn(() => ({
        id: 'conv-full',
        title: 'Full chat',
        summary: 'Short summary.',
        createdAt: 1,
        updatedAt: 2,
        messages: [
          { role: 'user', text: 'first exact turn' },
          { role: 'assistant', text: 'second exact turn' }
        ]
      }))
    }
    const tools = new BrowserTools({} as any, {} as any, chats as any)

    const result = await tools.run(
      'recall_history',
      { conversation_id: 'conv-full' },
      { tabId: 'tab-1' }
    )

    expect(chats.get).toHaveBeenCalledWith('conv-full')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('id: conv-full')
    expect(result.text).toContain('#1 user:')
    expect(result.text).toContain('second exact turn')
  })

  it('routes read_a11y through CDP accessibility capture and returns a compact digest', async () => {
    const cdpSend = vi.fn(async (_tabId: string, method: string) => {
      if (method === 'Accessibility.enable' || method === 'Accessibility.disable' || method === 'DOM.enable' || method === 'DOM.disable') {
        return {}
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'main', url: 'https://example.com' },
            childFrames: []
          }
        }
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 42, ignored: false }
          ]
        }
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }
      }
      return {}
    })
    const tabs = {
      list: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com' }],
      getTabUrl: () => 'https://example.com',
      cdpSend
    }
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('read_a11y', { focus: 'sign' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('SOURCE: CDP Accessibility.getFullAXTree')
    expect(result.text).toContain('@a1')
    expect(result.text).toContain('Sign in')
    expect(result.text).toContain('[read_a11y cache]')
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Accessibility.getFullAXTree', { frameId: 'main' })
  })

  it('routes read_page through the extractor and returns an orientation digest', async () => {
    const cap = {
      url: 'https://example.com/pricing',
      title: 'Pricing — Example',
      capturedAt: 0,
      tookMs: 1,
      content: { title: 'Pricing — Example', byline: null, text: 'Upgrade to Pro for more.', markdown: '', headings: [], wordCount: 5 },
      data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
      actions: [{ label: 'Upgrade', selector: 'button.upgrade', kind: 'button', rect: { x: 0, y: 0, w: 10, h: 10 }, ref: 'a1' }],
      dom: { nodeCount: 10, htmlBytes: 100, frameCount: 1 }
    }
    const extractor = { run: vi.fn(async () => cap) }
    const tabs = { getTabUrl: () => 'https://example.com/pricing' }
    const tools = new BrowserTools(tabs as any, extractor as any, {} as any)

    const result = await tools.run('read_page', { focus: 'upgrade' }, { tabId: 'tab-1' })

    expect(extractor.run).toHaveBeenCalledWith('tab-1')
    expect(result.ok).toBe(true)
    expect(result.structuredContent?.pageUrl).toContain('example.com/pricing')
    expect(typeof result.structuredContent?.digest).toBe('string')
    // Cache the result so a second identical read is a hit (cheap-to-repeat contract).
    const second = await tools.run('read_page', { focus: 'upgrade' }, { tabId: 'tab-1' })
    expect(second.ok).toBe(true)
    expect(extractor.run).toHaveBeenCalledTimes(1)
  })

  // ── act: the fused action verb (target spec §2.2) ────────────────────────
  // Distinguishes the grep-resolution payload from the after-state probe by
  // content: grep payloads contain `const query =`, the after-state probe
  // contains `location.href`.
  function makeActTabs(opts: {
    grepMatches?: unknown[]
    afterUrl?: string
    afterTitle?: string
    afterElements?: Array<Record<string, unknown>>
    beforeUrl?: string
  } = {}) {
    const cdp: Array<{ method: string; params?: Record<string, unknown> }> = []
    const cdpSend = vi.fn(async (_id: string, method: string, params?: Record<string, unknown>) => {
      cdp.push({ method, params })
      return {}
    })
    const executeJavaScript = vi.fn(async (_id: string, code: string) => {
      // The navigation-settle probe: `return { u: location.href, r: ... }`.
      // Report the after-url as already settled so the settle loop exits at once.
      if (code.includes('return { u: location.href')) {
        return {
          success: true,
          result: { u: opts.afterUrl ?? 'https://example.com/after', r: 'complete' }
        }
      }
      if (code.includes('location.href')) {
        return {
          success: true,
          result: {
            url: opts.afterUrl ?? 'https://example.com/after',
            title: opts.afterTitle ?? 'After',
            readyState: 'complete',
            bodyTextChars: 1234,
            activeElement: 'input#email',
            elements: opts.afterElements ?? [],
            captured: true
          }
        }
      }
      if (code.includes('const query =')) {
        return { success: true, result: opts.grepMatches ?? [] }
      }
      return { success: true, result: { ok: true, value: 'v', label: 'l' } }
    })
    const tabs = {
      list: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com' }],
      getTabUrl: () => opts.beforeUrl ?? 'https://example.com',
      cdpSend,
      executeJavaScript,
      runWithPendingNetworkCapture: async (_id: string, action: () => Promise<unknown> | unknown) => ({
        value: await action(),
        network: null
      })
    }
    return { tabs, cdpSend, executeJavaScript, cdp }
  }

  const VISIBLE_BUTTON = {
    type: 'selector_match',
    tagName: 'button',
    selector: 'button.submit',
    visible: true,
    coordinates: { x: 200, y: 300, width: 80, height: 30 },
    matchedLine: 'Submit'
  }

  it('act(click) resolves a query target, dispatches a trusted click, and returns fresh after-state', async () => {
    const { tabs, cdpSend } = makeActTabs({ grepMatches: [VISIBLE_BUTTON], afterUrl: 'https://example.com/done' })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'click', query: 'Submit' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 200, y: 300 }))
    // C1: fresh post-action state bundled in the same call.
    expect(result.structuredContent?.after).toMatchObject({ url: 'https://example.com/done', captured: true })
    expect(result.text).toContain('Now at https://example.com/done')
  })

  it('act(click) resolves a read_a11y @ref target', async () => {
    const { tabs } = makeActTabs({ afterUrl: 'https://example.com/ref' })
    // Drive read_a11y first so the @a1 ref exists. Reuse the cdpSend that serves the AX tree.
    const cdpSend = vi.fn(async (_id: string, method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: 'https://example.com' }, childFrames: [] } }
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 42, ignored: false }] }
      }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
      if (method === 'DOM.getBoxModel') return { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }
      return {}
    })
    ;(tabs as any).cdpSend = cdpSend
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    await tools.run('read_a11y', {}, { tabId: 'tab-1' })
    const result = await tools.run('act', { kind: 'click', ref: '@a1' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.structuredContent?.match).toMatchObject({ ref: '@a1', name: 'Sign in' })
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 140, y: 220 }))
  })

  it('act(type) focuses the resolved target and inserts text', async () => {
    const { tabs, cdpSend } = makeActTabs({ grepMatches: [{ ...VISIBLE_BUTTON, tagName: 'input', selector: 'input#email' }] })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'type', query: 'Email', text: 'hi@example.com' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Input.insertText', { text: 'hi@example.com' })
    expect(result.structuredContent).toMatchObject({ kind: 'type', text: 'hi@example.com' })
    expect(result.structuredContent?.after).toMatchObject({ captured: true })
  })

  it('act(key) dispatches a key event with no element target', async () => {
    const { tabs, cdpSend } = makeActTabs({})
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'key', key: 'Enter' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter' }))
    expect(result.structuredContent).toMatchObject({ kind: 'key', key: 'Enter' })
  })

  it('act(select) chooses an option on the resolved <select>', async () => {
    const { tabs } = makeActTabs({ grepMatches: [{ ...VISIBLE_BUTTON, tagName: 'select', selector: 'select#country' }] })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'select', query: 'Country', option: 'Canada' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.structuredContent).toMatchObject({ kind: 'select', option: 'Canada' })
  })

  it('set_field sets an input semantically and returns fresh after-state', async () => {
    const { tabs } = makeActTabs({ grepMatches: [{ ...VISIBLE_BUTTON, tagName: 'input', selector: 'input#email' }] })
    const executeJavaScript = (tabs as any).executeJavaScript as ReturnType<typeof vi.fn>
    executeJavaScript.mockImplementation(async (_id: string, code: string) => {
      if (code.includes('return { u: location.href')) {
        return { success: true, result: { u: 'https://example.com/after', r: 'complete' } }
      }
      if (code.includes('const root = document.elementFromPoint')) {
        return { success: true, result: { ok: true, mode: 'value' } }
      }
      if (code.includes('location.href')) {
        return {
          success: true,
          result: {
            url: 'https://example.com/after',
            title: 'After',
            readyState: 'complete',
            bodyTextChars: 1234,
            activeElement: 'input#email',
            elements: [],
            captured: true
          }
        }
      }
      if (code.includes('const query =')) {
        return { success: true, result: [{ ...VISIBLE_BUTTON, tagName: 'input', selector: 'input#email' }] }
      }
      return { success: true, result: { ok: true } }
    })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('set_field', { query: 'Email', value: 'hi@example.com' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('set_field: set')
    expect(result.structuredContent).toMatchObject({ value: 'hi@example.com', clear: true, mode: 'value' })
    expect(result.structuredContent?.after).toMatchObject({ captured: true })
  })

  it('submit falls back to form submission intent without an explicit target', async () => {
    const { tabs } = makeActTabs({})
    const executeJavaScript = (tabs as any).executeJavaScript as ReturnType<typeof vi.fn>
    executeJavaScript.mockImplementation(async (_id: string, code: string) => {
      if (code.includes('return { u: location.href')) {
        return { success: true, result: { u: 'https://example.com/search?q=reef', r: 'complete' } }
      }
      if (code.includes('labelOf')) {
        return { success: true, result: { ok: true, mode: 'requestSubmit' } }
      }
      if (code.includes('location.href')) {
        return {
          success: true,
          result: {
            url: 'https://example.com/search?q=reef',
            title: 'Results',
            readyState: 'complete',
            bodyTextChars: 1234,
            activeElement: null,
            elements: [],
            captured: true
          }
        }
      }
      return { success: true, result: { ok: true } }
    })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('submit', {}, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('submit: used requestSubmit')
    expect(result.structuredContent?.after).toMatchObject({ url: 'https://example.com/search?q=reef' })
  })

  it('open_result opens the requested indexed match and returns fresh after-state', async () => {
    const secondMatch = {
      ...VISIBLE_BUTTON,
      selector: 'a.result-2',
      coordinates: { x: 260, y: 360, width: 80, height: 30 },
      matchedLine: 'Second story'
    }
    const { tabs, cdpSend } = makeActTabs({ grepMatches: [VISIBLE_BUTTON, secondMatch], afterUrl: 'https://example.com/story-2' })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('open_result', { query: 'story', index: 2 }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 260, y: 360 }))
    expect(result.structuredContent).toMatchObject({ query: 'story', index: 2 })
    expect(result.structuredContent?.after).toMatchObject({ url: 'https://example.com/story-2' })
  })

  it('act fails with a re-orient hint when the query target does not resolve (C6: no act-on-a-guess)', async () => {
    const { tabs, cdpSend } = makeActTabs({ grepMatches: [] })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'click', query: 'Nonexistent' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(false)
    expect(result.text).toContain('no visible element matched')
    expect(result.text).toMatch(/re-orient|read_a11y|grep_page/)
    // It must NOT have clicked anything.
    expect(cdpSend).not.toHaveBeenCalledWith('tab-1', 'Input.dispatchMouseEvent', expect.anything())
  })

  it('act(click) bundles the new page targets when the action navigates (C1 enrichment)', async () => {
    // before-url (getTabUrl) differs from the after-state url → navigation.
    const { tabs } = makeActTabs({
      grepMatches: [VISIBLE_BUTTON],
      beforeUrl: 'https://news.example.com/',
      afterUrl: 'https://news.example.com/item?id=42',
      afterElements: [
        { tag: 'a', role: null, label: '436 comments', x: 120, y: 80 },
        { tag: 'a', role: null, label: 'reply', x: 200, y: 300 }
      ]
    })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'click', query: 'Top story' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.structuredContent?.after).toMatchObject({ navigated: true })
    // The model gets the new page's targets in the same call — no re-read needed.
    const after = result.structuredContent?.after as { elements: Array<{ label: string }> }
    expect(after.elements.map((e) => e.label)).toContain('436 comments')
    expect(result.text).toContain('Page changed — top targets')
    expect(result.text).toContain('436 comments')
  })

  it('act(click) drops the element digest on a same-page action (stays cheap)', async () => {
    // before-url === after-url → no navigation → no element list shipped.
    const { tabs } = makeActTabs({
      grepMatches: [VISIBLE_BUTTON],
      beforeUrl: 'https://example.com/form',
      afterUrl: 'https://example.com/form',
      afterElements: [{ tag: 'button', role: null, label: 'Submit', x: 200, y: 300 }]
    })
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    const result = await tools.run('act', { kind: 'click', query: 'Submit' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.structuredContent?.after).toMatchObject({ navigated: false })
    expect(result.structuredContent?.after).not.toHaveProperty('elements')
    expect(result.text).not.toContain('Page changed')
  })

  it('navigate builds a DOM-order wireframe from the extractor and saves the page to disk', async () => {
    const tabs = {
      getTabUrl: () => 'https://news.example.com/',
      navigate: vi.fn(async () => {}),
      takeArmedNetworkCapture: () => null,
      async executeJavaScript(_id: string, code: string) {
        if (code.includes('location.href')) {
          return { success: true, result: { u: 'https://news.example.com/', r: 'complete', n: 5000 } }
        }
        return { success: true, result: null }
      },
      runWithPendingNetworkCapture: async (_id: string, action: () => Promise<unknown> | unknown) => ({ value: await action(), network: null })
    }
    // The extractor returns a cleaned PageCapture in DOCUMENT ORDER: top story
    // first (with its comments link), then repeated boilerplate, then footer.
    const extractor = {
      run: vi.fn(async () => ({
        url: 'https://news.example.com/',
        title: 'Hacker News',
        capturedAt: 1,
        tookMs: 1,
        content: { title: 'Hacker News', byline: null, text: 'body', markdown: '# HN\nbody', headings: [{ level: 1, text: 'HN' }], wordCount: 2 },
        data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
        actions: [
          { idx: 1, role: 'link', name: 'Claude Sonnet 5', tag: 'a', value: 'https://anthropic.com', selector: 's1', rect: { x: 0, y: 0, w: 10, h: 10 }, inViewport: true },
          { idx: 2, role: 'link', name: '482 comments', tag: 'a', value: 'item?id=1', selector: 's2', rect: { x: 0, y: 10, w: 10, h: 10 }, inViewport: true },
          ...Array.from({ length: 6 }, (_, k) => ({ idx: k + 3, role: 'link', name: `${k + 1} hours ago`, tag: 'a', value: `t${k}`, selector: `s${k + 3}`, rect: { x: 0, y: 20 + k * 10, w: 10, h: 10 }, inViewport: true })),
          { idx: 9, role: 'link', name: 'Guidelines', tag: 'a', value: 'guidelines', selector: 's9', rect: { x: 0, y: 90, w: 10, h: 10 }, inViewport: true }
        ],
        dom: { nodeCount: 10, htmlBytes: 100, frameCount: 1 }
      }))
    }
    const base = await mkdtemp(join(tmpdir(), 'gladdis-nav-pages-'))
    const tools = new BrowserTools(tabs as any, extractor as any, {} as any)
    tools.setPageStoreBaseDir(base)

    const result = await tools.run('navigate', { url: 'https://news.example.com/' }, { tabId: 'tab-1', conversationId: 'conv-nav' })

    expect(result.ok).toBe(true)
    expect(extractor.run).toHaveBeenCalledWith('tab-1')
    // Brief.
    expect(result.structuredContent).toMatchObject({ url: 'https://news.example.com/', readyState: 'complete', redirected: false })
    // Wireframe in DOCUMENT ORDER: top story first, comments link next, repeats collapse, footer last.
    const wireframe = result.structuredContent?.wireframe as { lines: Array<any> }
    expect(wireframe.lines[0]).toMatchObject({ kind: 'action', name: 'Claude Sonnet 5', href: 'https://anthropic.com' })
    expect(wireframe.lines[1]).toMatchObject({ kind: 'action', name: '482 comments' })
    expect(wireframe.lines[2]).toMatchObject({ kind: 'group', count: 6 })
    expect(wireframe.lines[3]).toMatchObject({ kind: 'action', name: 'Guidelines' })
    expect(result.text).toContain('document order')
    // The whole page was saved to disk; the paths are returned.
    expect(typeof result.structuredContent?.savedMarkdownPath).toBe('string')
    const md = await readFile(result.structuredContent!.savedMarkdownPath as string, 'utf8')
    expect(md).toContain('# Hacker News')
    expect(result.text).toContain('Saved full page:')
  })

  it('routes grep_click through read_a11y refs', async () => {
    const cdpSend = vi.fn(async (_tabId: string, method: string, params?: Record<string, unknown>) => {
      if (method.startsWith('Input.')) return {}
      if (method === 'Accessibility.enable' || method === 'Accessibility.disable' || method === 'DOM.enable' || method === 'DOM.disable') {
        return {}
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main', url: 'https://example.com' }, childFrames: [] } }
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 42, ignored: false }
          ]
        }
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }
      }
      return {}
    })
    const tabs = {
      list: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com' }],
      getTabUrl: () => 'https://example.com',
      cdpSend,
      runWithPendingNetworkCapture: async (_id: string, action: () => Promise<unknown> | unknown) => ({
        value: await action(),
        network: null
      })
    }
    const tools = new BrowserTools(tabs as any, {} as any, {} as any)

    await tools.run('read_a11y', {}, { tabId: 'tab-1' })
    const result = await tools.run('grep_click', { query: '@a1' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('@a1')
    expect(cdpSend).toHaveBeenCalledWith('tab-1', 'Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 140, y: 220 }))
  })

  it('routes grep_page through the capability broker and returns grep results', async () => {
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: [
        {
          type: 'selector_match',
          tagName: 'button',
          selector: 'div#root > button.btn-pricing',
          visible: true,
          coordinates: { x: 150, y: 350, width: 100, height: 40 },
          outerHTML: '<button class="btn-pricing">Upgrade Now</button>',
          innerText: 'Upgrade Now'
        },
        {
          type: 'text_match',
          matchedLine: 'Save 50% on annual billing.',
          lineIndex: 42,
          context: 'Special winter promo!\nSave 50% on annual billing.\nOffer ends soon.',
          selector: 'div#root > p.promo-text',
          coordinates: { x: 150, y: 400 },
          visible: true,
          tagName: 'p'
        }
      ]
    }))
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run(
      'grep_page',
      { query: 'Upgrade', type: 'text' },
      { tabId: 'tab-1' }
    )

    expect(executeJavaScript).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Hybrid Grep/CDP search completed on page')
    expect(result.text).toContain('div#root > button.btn-pricing')
    expect(result.text).toContain('Upgrade Now')
    expect(result.text).toContain('Save 50% on annual billing.')
  })

  it('defaults grep_page to text search when no type is provided', async () => {
    const executeJavaScript = vi.fn(async (..._args: any[]) => ({
      success: true,
      result: { matches: [], totalMatches: 0 }
    }))
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    await tools.run('grep_page', { query: 'pricing details' }, { tabId: 'tab-1' })

    const jsPayload = executeJavaScript.mock.calls[0][1]
    expect(jsPayload).toContain('const type = "text";')
  })

  it('surfaces qualified leads when no exact text match exists', async () => {
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: {
        matches: [],
        totalMatches: 0,
        qualifiedLeads: [
          {
            type: 'text_lead',
            matchedLine: 'The tower is 330 metres (1,083 ft) tall.',
            lineIndex: 17,
            context: 'The tower is 330 metres (1,083 ft) tall.',
            selector: 'p:nth-of-type(3)',
            coordinates: { x: 120, y: 240 },
            visible: true,
            tagName: 'p',
            leadScore: 0.667,
            overlapTerms: ['height', 'metre']
          }
        ]
      }
    }))
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run('grep_page', { query: 'Height 300 meters', type: 'text' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('No exact matches found')
    expect(result.text).toContain('qualified lead')
    expect(result.text).toContain('Overlapping terms: height, metre')
    expect(result.structuredContent).toMatchObject({
      totalMatches: 0,
      matches: [],
      qualifiedLeads: [
        expect.objectContaining({
          type: 'text_lead',
          overlapTerms: ['height', 'metre']
        })
      ]
    })
  })

  it('rejects unclear grep_page search modes', async () => {
    const executeJavaScript = vi.fn()
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run('grep_page', { query: 'Upgrade', type: 'auto' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(false)
    expect(result.text).toContain('type must be "text", "regex", or "selector"')
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('steers off a single broad word when a text grep floods and truncates', async () => {
    // Emulate the in-page payload: 50 returned text matches out of 137 total.
    const flood = Array.from({ length: 50 }, (_, i) => ({
      type: 'text_match',
      matchedLine: `…Germany context ${i}…`,
      lineIndex: i + 1,
      context: `…Germany context ${i}…`,
      selector: `p:nth-of-type(${i + 1})`,
      coordinates: { x: 1, y: i },
      visible: true,
      tagName: 'p'
    }))
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: { matches: flood, totalMatches: 137 }
    }))
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run('grep_page', { query: 'Germany', type: 'text' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(true)
    // The banner names the bad query shape and tells the model what to do instead.
    expect(result.text).toContain('Broad query')
    expect(result.text).toContain("Extract the subject from the user's request")
    expect(result.text).toContain('137')
    // Machine-readable signal is present too.
    expect(result.structuredContent).toMatchObject({ totalMatches: 137, truncated: true })
  })

  it('does not steer when a phrase query returns a clean handful of matches', async () => {
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: {
        matches: [
          {
            type: 'text_match',
            matchedLine: 'Germany surrendered on 8 May 1945.',
            lineIndex: 12,
            context: '…Germany surrendered on 8 May 1945.…',
            selector: 'p:nth-of-type(5)',
            coordinates: { x: 1, y: 1 },
            visible: true,
            tagName: 'p'
          }
        ],
        totalMatches: 1
      }
    }))
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run(
      'grep_page',
      { query: 'Germany surrendered on 8 May 1945', type: 'text' },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).not.toContain('Broad query')
    expect(result.text).not.toContain('SAMPLE')
    expect(result.structuredContent).toMatchObject({ totalMatches: 1, truncated: false })
  })

  it('extracts repeated structured records from the live page', async () => {
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: {
        records: [
          { author: 'alice', summary: 'First comment', link: '/item?id=1' },
          { author: 'bob', summary: 'Second comment', link: '/item?id=2' }
        ],
        totalMatches: 3
      }
    }))
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run(
      'extract_structured',
      {
        item_selector: 'tr.athing.comtr',
        fields: {
          author: { selector: '.hnuser', mode: 'text' },
          summary: { selector: '.commtext', mode: 'text' },
          link: { selector: '.age a', mode: 'attr', attr: 'href' }
        },
        limit: 2
      },
      { tabId: 'tab-1' }
    )

    expect(executeJavaScript).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Structured extraction completed')
    expect(result.text).toContain('alice')
    expect(result.structuredContent).toMatchObject({
      itemSelector: 'tr.athing.comtr',
      totalMatches: 3,
      returned: 2,
      truncated: true,
      records: [
        { author: 'alice', summary: 'First comment', link: '/item?id=1' },
        { author: 'bob', summary: 'Second comment', link: '/item?id=2' }
      ]
    })
  })

  it('validates extract_structured attr fields before executing page JS', async () => {
    const executeJavaScript = vi.fn()
    const tools = new BrowserTools({ executeJavaScript } as any, {} as any, {} as any)

    const result = await tools.run(
      'extract_structured',
      {
        item_selector: '.story',
        fields: {
          href: { selector: 'a', mode: 'attr' }
        }
      },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(false)
    expect(result.text).toContain('mode "attr" must include a non-empty attr')
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('routes grep_click through the capability broker and triggers click events on coordinates of the best match', async () => {
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: [
        {
          type: 'selector_match',
          tagName: 'button',
          selector: 'div#root > button.btn-pricing',
          visible: true,
          coordinates: { x: 150, y: 350, width: 100, height: 40 },
          outerHTML: '<button class="btn-pricing">Upgrade Now</button>',
          innerText: 'Upgrade Now'
        }
      ]
    }))
    const cdpSend = vi.fn(async () => ({}))
    const runWithPendingNetworkCapture = vi.fn(async (_tabId: string, fn: () => Promise<any>) => {
      await fn()
      return { network: null }
    })
    const tools = new BrowserTools({ executeJavaScript, cdpSend, runWithPendingNetworkCapture } as any, {} as any, {} as any)

    const result = await tools.run(
      'grep_click',
      { query: 'Upgrade' },
      { tabId: 'tab-1' }
    )

    expect(executeJavaScript).toHaveBeenCalled()
    expect(cdpSend).toHaveBeenCalledTimes(3) // mouseMoved, mousePressed, mouseReleased
    expect(cdpSend).toHaveBeenNthCalledWith(1, 'tab-1', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 350 })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('grep_click successful. Found and clicked element.')
    expect(result.text).toContain('div#root > button.btn-pricing')
    expect(result.text).toContain('(150, 350)')
  })

  it('routes grep_type through the capability broker, focuses element, and types text via CDP', async () => {
    const executeJavaScript = vi.fn(async () => ({
      success: true,
      result: [
        {
          type: 'selector_match',
          tagName: 'input',
          selector: 'input#username',
          visible: true,
          coordinates: { x: 200, y: 400, width: 150, height: 30 },
          outerHTML: '<input id="username" />',
          innerText: ''
        }
      ]
    }))
    const cdpSend = vi.fn(async () => ({}))
    const runWithPendingNetworkCapture = vi.fn(async (_tabId: string, fn: () => Promise<any>) => {
      await fn()
      return { network: null }
    })
    const tools = new BrowserTools({ executeJavaScript, cdpSend, runWithPendingNetworkCapture } as any, {} as any, {} as any)

    const result = await tools.run(
      'grep_type',
      { query: 'username', text: 'myusername' },
      { tabId: 'tab-1' }
    )

    expect(executeJavaScript).toHaveBeenCalled()
    // 3 calls for click (move, press, release), 1 call for insertText
    expect(cdpSend).toHaveBeenCalledTimes(4)
    expect(cdpSend).toHaveBeenNthCalledWith(4, 'tab-1', 'Input.insertText', { text: 'myusername' })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('grep_type successful. Focused element and typed text.')
    expect(result.text).toContain('input#username')
    expect(result.text).toContain('(200, 400)')
  })
})
