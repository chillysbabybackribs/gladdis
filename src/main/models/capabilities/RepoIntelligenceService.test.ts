import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { RepoIndexService } from './RepoIndexService'
import { RepoIntelligenceService } from './RepoIntelligenceService'

describe('RepoIntelligenceService', () => {
  it('builds a compact repo overview from common workspace files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-intel-'))
    await fs.mkdir(path.join(workspace, 'src', 'main'), { recursive: true })
    await fs.mkdir(path.join(workspace, 'src', 'renderer'), { recursive: true })
    await fs.mkdir(path.join(workspace, 'shared'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'demo-workspace',
        scripts: {
          dev: 'vite',
          test: 'vitest'
        }
      })
    )
    await fs.writeFile(path.join(workspace, 'tsconfig.json'), '{}')
    await fs.writeFile(path.join(workspace, 'src', 'main', 'index.ts'), 'console.log("main")')
    await fs.writeFile(path.join(workspace, 'src', 'renderer', 'main.tsx'), 'console.log("renderer")')

    const service = new RepoIntelligenceService()
    const result = await service.repoOverview({
      workspaceRoot: workspace,
      focus: 'chat service'
    })

    expect(result.summary).toContain(`Workspace: ${workspace}`)
    expect(result.summary).toContain('Package: demo-workspace')
    expect(result.summary).toContain('Scripts: dev, test')
    expect(result.summary).toContain('Entrypoints: src/main/index.ts, src/renderer/main.tsx')
    expect(result.summary).toContain('Focus: chat service')
    expect(result.structuredPayload.packageName).toBe('demo-workspace')
    expect(result.structuredPayload.scripts).toEqual(['dev', 'test'])
    expect(result.structuredPayload.entryPoints).toEqual([
      'src/main/index.ts',
      'src/renderer/main.tsx'
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('searches repo content and returns compact hit summaries', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-search-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'alpha.ts'), 'export const chatService = true\n')
    await fs.writeFile(path.join(workspace, 'src', 'beta.ts'), 'export const chatBroker = true\n')

    const service = new RepoIntelligenceService()
    const result = await service.searchRepo({
      workspaceRoot: workspace,
      query: 'chat',
      glob: '*.ts',
      maxResults: 5
    })

    expect(result.summary).toContain('Search query: chat')
    expect(result.summary).toContain('Suggested next read_spans call:')
    expect(result.structuredPayload.totalHits).toBeGreaterThan(0)
    expect(result.structuredPayload.hits.some((hit) => hit.path === 'src/alpha.ts')).toBe(true)
    expect(result.structuredPayload.suggestedSpans.length).toBeGreaterThan(0)

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('uses a warm local repo index for symbol-oriented search hits', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-indexed-search-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'indexed.ts'),
      [
        "import { helper } from './helper'",
        'export class IndexedSearchTarget {',
        '  run() { return helper() }',
        '}'
      ].join('\n')
    )
    const index = new RepoIndexService()
    await index.refresh(workspace)

    const service = new RepoIntelligenceService(index)
    const result = await service.searchRepo({
      workspaceRoot: workspace,
      query: 'IndexedSearchTarget',
      glob: '*.ts',
      maxResults: 5
    })

    expect(result.summary).toContain('Index hits:')
    expect(result.summary).toContain('src/indexed.ts:2 - class IndexedSearchTarget')
    expect(result.structuredPayload.hits).toEqual([
      expect.objectContaining({
        path: 'src/indexed.ts',
        kind: 'symbol',
        line: 2
      }),
      expect.objectContaining({
        path: 'src/indexed.ts',
        kind: 'export',
        line: 2
      })
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('scopes repo search to the provided relative path', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-search-scope-'))
    await fs.mkdir(path.join(workspace, 'src', 'main'), { recursive: true })
    await fs.mkdir(path.join(workspace, 'src', 'renderer'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'main', 'focus.ts'), 'export const scopedNeedle = true\n')
    await fs.writeFile(path.join(workspace, 'src', 'renderer', 'outside.ts'), 'export const scopedNeedle = true\n')

    const service = new RepoIntelligenceService()
    const result = await service.searchRepo({
      workspaceRoot: workspace,
      query: 'scopedNeedle',
      path: 'src/main',
      glob: '*.ts',
      maxResults: 5
    })

    expect(result.summary).toContain('Path: src/main')
    expect(result.structuredPayload.path).toBe('src/main')
    expect(result.structuredPayload.hits).toEqual([
      expect.objectContaining({ path: 'src/main/focus.ts' })
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('reads bounded file spans for targeted repo inspection', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-read-spans-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'example.ts'),
      ['line 1', 'line 2', 'target line 3', 'line 4', 'line 5'].join('\n')
    )

    const service = new RepoIntelligenceService()
    const result = await service.readSpans({
      workspaceRoot: workspace,
      items: [{ path: 'src/example.ts', startLine: 2, endLine: 4 }]
    })

    expect(result.summary).toContain('=== src/example.ts (lines 2-4 of 5) ===')
    expect(result.summary).toContain('target line 3')
    expect(result.structuredPayload.items).toEqual([
      expect.objectContaining({
        path: 'src/example.ts',
        startLine: 2,
        endLine: 4,
        totalLines: 5
      })
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('uses index-selected windows for related spans', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-related-spans-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { targetHelper as helperAlias } from './helper'",
        'export function runService() {',
        '  return helperAlias()',
        '}'
      ].join('\n')
    )
    await fs.writeFile(
      path.join(workspace, 'src', 'helper.ts'),
      [
        ...Array.from({ length: 19 }, (_, index) => `const filler${index + 1} = ${index + 1}`),
        'export function targetHelper() {',
        '  return true',
        '}'
      ].join('\n')
    )

    const index = new RepoIndexService()
    await index.refresh(workspace)
    const service = new RepoIntelligenceService(index)
    const related = await service.relatedSpans({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'helperAlias',
      maxResults: 1
    })

    expect(related).toEqual([
      {
        path: 'src/helper.ts',
        startLine: 12,
        endLine: 38
      }
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })
})
