import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { RepoIndexService } from './RepoIndexService'

describe('RepoIndexService', () => {
  it('persists a compact symbol/import index for a workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'alpha.ts'),
      [
        "import { betaValue } from './beta'",
        'export interface AlphaOptions { enabled: boolean }',
        'export function createAlpha(options: AlphaOptions) {',
        '  return betaValue && options.enabled',
        '}'
      ].join('\n')
    )

    const index = new RepoIndexService()
    const snapshot = await index.refresh(workspace)
    const persisted = await fs.readFile(path.join(workspace, '.gladdis', 'repo-intel', 'index-v1.json'), 'utf8')

    expect(snapshot.files).toEqual([
      expect.objectContaining({
        path: 'src/alpha.ts',
        imports: ['./beta'],
        exports: ['AlphaOptions', 'createAlpha']
      })
    ])
    expect(JSON.parse(persisted).files[0].symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'AlphaOptions', kind: 'interface', line: 2 }),
        expect.objectContaining({ name: 'createAlpha', kind: 'function', line: 3 })
      ])
    )

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('loads a persisted index for later searches without rebuilding first', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-search-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'service.ts'), 'export class HiddenSearchService {}\n')

    await new RepoIndexService().refresh(workspace)
    const hits = await new RepoIndexService().search({
      workspaceRoot: workspace,
      query: 'HiddenSearchService',
      maxResults: 5
    })

    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'src/service.ts',
        kind: 'symbol',
        line: 1,
        text: 'class HiddenSearchService'
      })
    ]))

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('returns local import neighbors for indexed files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-related-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      ["import { helper } from './helper'", 'export class SearchService {', '  value = helper()', '}'].join('\n')
    )
    await fs.writeFile(path.join(workspace, 'src', 'helper.ts'), 'export function helper() { return true }\n')
    await fs.writeFile(path.join(workspace, 'src', 'consumer.ts'), "import { SearchService } from './service'\n")

    const index = new RepoIndexService()
    await index.refresh(workspace)
    const related = await index.relatedFiles({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      maxResults: 5
    })

    expect(related).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/helper.ts', reason: 'imported by src/service.ts' }),
      expect.objectContaining({ path: 'src/consumer.ts', reason: 'imports src/service.ts' })
    ]))

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('ranks related files that match the query ahead of import order', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-related-rank-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { alphaValue } from './alpha'",
        "import { helperValue } from './helper'",
        'export class SearchService {',
        '  value = helperValue || alphaValue',
        '}'
      ].join('\n')
    )
    await fs.writeFile(path.join(workspace, 'src', 'alpha.ts'), 'export const alphaValue = false\n')
    await fs.writeFile(path.join(workspace, 'src', 'helper.ts'), 'export const helperValue = true\n')

    const index = new RepoIndexService()
    await index.refresh(workspace)
    const related = await index.relatedFiles({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'helperValue',
      maxResults: 2
    })

    expect(related.map((file) => file.path)).toEqual(['src/helper.ts', 'src/alpha.ts'])

    await fs.rm(workspace, { recursive: true, force: true })
  })
})
