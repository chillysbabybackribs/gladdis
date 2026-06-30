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
import { CapabilityBroker } from './capabilities/CapabilityBroker'
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService'

const execFileAsync = promisify(execFile)

describe('BrowserTools', () => {
  it('routes repo_overview through the capability broker for workspace summaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-repo-overview-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'repo-tool-test', scripts: { test: 'vitest' } }))
    await writeFile(join(dir, 'tsconfig.json'), '{}')
    const emitted: any[] = []

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    tools.setCapabilityBroker(new CapabilityBroker(new RepoIntelligenceService(), (event) => emitted.push(event)))

    const result = await tools.run(
      'repo_overview',
      { focus: 'chat service' },
      { tabId: 'tab-1', requestId: 'req-1', conversationId: 'conv-1', taskId: 'task-1' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Package: repo-tool-test')
    expect(result.text).toContain('Focus: chat service')
    expect(emitted.map((event) => event.event)).toEqual([
      'capability_requested',
      'capability_started',
      'capability_completed'
    ])
  })

  it('routes search_repo through the capability broker and returns workspace hits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-repo-tool-'))
    await writeFile(join(dir, 'SearchThing.ts'), 'export const searchRepoNeedle = true\n')

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    tools.setCapabilityBroker(new CapabilityBroker(new RepoIntelligenceService(), () => {}))

    const result = await tools.run(
      'search_repo',
      { query: 'searchRepoNeedle', glob: '*.ts', max_results: 5 },
      { tabId: 'tab-1', requestId: 'req-2', conversationId: 'conv-2', taskId: 'task-2' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Search query: searchRepoNeedle')
    expect(result.text).toContain('SearchThing.ts:1')
  })

  it('scopes search_repo to the selected folder path when provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-search-repo-scope-tool-'))
    await writeFile(join(dir, 'inside.ts'), 'export const scopedSearchRepoNeedle = true\n')
    await writeFile(join(dir, 'outside.ts'), 'export const scopedSearchRepoNeedle = true\n')
    await execFileAsync('mkdir', ['-p', join(dir, 'nested')])
    await execFileAsync('mv', [join(dir, 'inside.ts'), join(dir, 'nested', 'inside.ts')])

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    tools.setCapabilityBroker(new CapabilityBroker(new RepoIntelligenceService(), () => {}))

    const result = await tools.run(
      'search_repo',
      { query: 'scopedSearchRepoNeedle', path: 'nested', glob: '*.ts', max_results: 5 },
      { tabId: 'tab-1', requestId: 'req-2b', conversationId: 'conv-2b', taskId: 'task-2b' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Path: nested')
    expect(result.text).toContain('nested/inside.ts:1')
    expect(result.text).not.toContain('outside.ts:1')
  })

  it('routes read_spans through the capability broker and returns bounded code windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-read-spans-tool-'))
    await writeFile(join(dir, 'example.ts'), ['alpha', 'beta', 'gamma', 'delta'].join('\n'))

    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    tools.setCapabilityBroker(new CapabilityBroker(new RepoIntelligenceService(), () => {}))

    const result = await tools.run(
      'read_spans',
      { path: 'example.ts', start_line: 2, end_line: 3 },
      { tabId: 'tab-1', requestId: 'req-3', conversationId: 'conv-3', taskId: 'task-3' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('=== example.ts (lines 2-3 of 4) ===')
    expect(result.text).toContain('beta')
    expect(result.text).toContain('gamma')
  })

  it('routes research_dossier through the capability broker and returns synthesized guidance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-research-dossier-tool-'))
    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    tools.setCapabilityBroker(
      new CapabilityBroker(
        {
          repoOverview: async () => ({
            summary: 'unused',
            structuredPayload: {
              workspaceRoot: dir,
              packageManager: null,
              packageName: null,
              scripts: [],
              keyFiles: [],
              topDirectories: [],
              entryPoints: []
            }
          }),
          searchRepo: async () => ({
            summary: 'unused',
            structuredPayload: { workspaceRoot: dir, query: 'unused', totalHits: 0, hits: [], suggestedSpans: [], context: { chars: 0, estimatedTokens: 0, hitCount: 0, suggestedSpanCount: 0 } }
          }),
          readSpans: async () => ({ summary: 'unused', structuredPayload: {} }),
          researchDossier: async () => ({
            summary: '## Dossier\nInvestigate `src/main/models/ChatService.ts` first.',
            structuredPayload: {
              workspaceRoot: dir,
              query: 'chat service architecture',
              searchedFiles: ['src/main/models/ChatService.ts'],
              suggestedSpans: [],
              context: {
                promptChars: 0,
                estimatedPromptTokens: 0,
                searchSummaryChars: 0,
                readSpanChars: 0,
                estimatedReadSpanTokens: 0,
                suggestedSpanCount: 0,
                selectedFileBytes: 0,
                estimatedFullFileTokens: 0,
                estimatedTokensSavedBySpans: 0
              }
            }
          })
        },
        () => {}
      )
    )

    const result = await tools.run(
      'research_dossier',
      { query: 'chat service architecture' },
      { tabId: 'tab-1', requestId: 'req-4', conversationId: 'conv-4', taskId: 'task-4' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('## Dossier')
    expect(result.text).toContain('ChatService.ts')
  })

  it('routes verify_change through the capability broker and returns validation output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gladdis-verify-change-tool-'))
    const tools = new BrowserTools({} as any, {} as any, {} as any)
    tools.setWorkspaceRoot(dir)
    tools.setCapabilityBroker(
      new CapabilityBroker(
        {
          repoOverview: async () => ({
            summary: 'unused',
            structuredPayload: {
              workspaceRoot: dir,
              packageManager: null,
              packageName: null,
              scripts: [],
              keyFiles: [],
              topDirectories: [],
              entryPoints: []
            }
          }),
          searchRepo: async () => ({
            summary: 'unused',
            structuredPayload: { workspaceRoot: dir, query: 'unused', totalHits: 0, hits: [], suggestedSpans: [], context: { chars: 0, estimatedTokens: 0, hitCount: 0, suggestedSpanCount: 0 } }
          }),
          readSpans: async () => ({ summary: 'unused', structuredPayload: {} }),
          verifyChange: async () => ({
            ok: true,
            status: 'pass',
            summary: 'typecheck: pass\n(no output)',
            language: 'node',
            structuredPayload: {
              workspaceRoot: dir,
              language: 'node',
              checks: [{ check: 'typecheck', ok: true, output: '(no output)' }]
            }
          })
        },
        () => {}
      )
    )

    const result = await tools.run(
      'verify_change',
      { check: 'typecheck' },
      { tabId: 'tab-1', requestId: 'req-5', conversationId: 'conv-5', taskId: 'task-5' }
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('typecheck: pass')
  })

  it('formats undefined execute_in_browser results without failing the tool call', async () => {
    const tools = new BrowserTools({
      executeJavaScript: vi.fn(async () => ({ success: true, result: undefined }))
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

  it('routes grep_page through the capability broker and returns hybrid results', async () => {
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
      { query: 'Upgrade', type: 'auto' },
      { tabId: 'tab-1' }
    )

    expect(executeJavaScript).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Hybrid Grep/CDP search completed on page')
    expect(result.text).toContain('div#root > button.btn-pricing')
    expect(result.text).toContain('Upgrade Now')
    expect(result.text).toContain('Save 50% on annual billing.')
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
    const tools = new BrowserTools({ executeJavaScript, cdpSend } as any, {} as any, {} as any)

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
    const tools = new BrowserTools({ executeJavaScript, cdpSend } as any, {} as any, {} as any)

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
