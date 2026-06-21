import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

import { BrowserTools } from './browserTools'

const execFileAsync = promisify(execFile)

describe('BrowserTools', () => {
  it('formats undefined execute_in_browser results without failing the tool call', async () => {
    const tools = new BrowserTools({
      executeJavaScript: vi.fn(async () => ({ success: true, result: undefined }))
    } as any, {} as any, {} as any)

    const result = await tools.run('execute_in_browser', { code: '"test"' }, { tabId: 'tab-1' })

    expect(result).toEqual({ ok: true, text: 'undefined' })
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
    expect(result.text).toContain('Use search_files to locate relevant symbols')
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

  it('rejects unknown validation checks before running a command', async () => {
    const tools = new BrowserTools({} as any, {} as any, {} as any)
    const result = await tools.run('run_validation', { check: 'rm -rf nope' }, { tabId: 'tab-1' })

    expect(result.ok).toBe(false)
    expect(result.text).toContain('must be one of typecheck, test, build, or check')
  })

  it('commits and pushes local changes with publish_changes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gladdis-publish-'))
    const remote = join(base, 'remote.git')
    const worktree = join(base, 'worktree')
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['init', '-b', 'main', worktree])
    await execFileAsync('git', ['config', 'user.email', 'gladdis@example.test'], { cwd: worktree })
    await execFileAsync('git', ['config', 'user.name', 'Gladdis Test'], { cwd: worktree })
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: worktree })
    await writeFile(join(worktree, 'source.txt'), 'automated publish\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(worktree)
    const result = await tools.run(
      'publish_changes',
      { message: 'Automate GitHub publishing' },
      { tabId: 'tab-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Published')
    expect(result.text).toContain('Automate GitHub publishing')
    expect((await execFileAsync('git', ['status', '--short'], { cwd: worktree })).stdout.trim()).toBe('')
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', '--verify', 'main'])).stdout.trim()).toMatch(/[a-f0-9]{40}/)
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
})
