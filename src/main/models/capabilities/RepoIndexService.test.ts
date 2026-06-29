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
        importBindings: [{ specifier: './beta', bindings: ['betaValue'] }],
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

  it('uses imported binding names to rank related files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-import-bindings-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { alphaValue } from './alpha'",
        "import { internalValue as foo } from './helper'",
        'export class SearchService {',
        '  value = foo || alphaValue',
        '}'
      ].join('\n')
    )
    await fs.writeFile(path.join(workspace, 'src', 'alpha.ts'), 'export const alphaValue = false\n')
    await fs.writeFile(path.join(workspace, 'src', 'helper.ts'), 'export const internalValue = true\n')

    const index = new RepoIndexService()
    const snapshot = await index.refresh(workspace)
    const serviceFile = snapshot.files.find((file) => file.path === 'src/service.ts')

    expect(serviceFile?.importBindings).toEqual([
      { specifier: './alpha', bindings: ['alphaValue'] },
      { specifier: './helper', bindings: ['foo', 'internalValue'] }
    ])

    const hits = await index.search({
      workspaceRoot: workspace,
      query: 'foo',
      maxResults: 3
    })
    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'src/service.ts',
        kind: 'import',
        text: 'import foo from ./helper'
      })
    ]))

    const related = await index.relatedFiles({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'foo',
      maxResults: 2
    })

    expect(related.map((file) => file.path)).toEqual(['src/helper.ts', 'src/alpha.ts'])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('returns focused related spans near symbols matched through import aliases', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-related-spans-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { internalValue as foo } from './helper'",
        'export function runService() {',
        '  return foo()',
        '}'
      ].join('\n')
    )
    await fs.writeFile(
      path.join(workspace, 'src', 'helper.ts'),
      [
        ...Array.from({ length: 34 }, (_, index) => `const filler${index + 1} = ${index + 1}`),
        'export function internalValue() {',
        '  return true',
        '}'
      ].join('\n')
    )

    const index = new RepoIndexService()
    await index.refresh(workspace)
    const related = await index.relatedFiles({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'foo',
      maxResults: 1
    })

    expect(related).toEqual([
      expect.objectContaining({
        path: 'src/helper.ts',
        startLine: 27,
        endLine: 53
      })
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('follows barrel re-exports to the file that owns the imported symbol', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-reexport-owner-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { targetHelper as helperAlias } from './index'",
        'export function runService() {',
        '  return helperAlias()',
        '}'
      ].join('\n')
    )
    await fs.writeFile(
      path.join(workspace, 'src', 'index.ts'),
      "export { targetHelper } from './helper'\n"
    )
    await fs.writeFile(
      path.join(workspace, 'src', 'helper.ts'),
      [
        ...Array.from({ length: 24 }, (_, index) => `const filler${index + 1} = ${index + 1}`),
        'export function targetHelper() {',
        '  return true',
        '}'
      ].join('\n')
    )

    const index = new RepoIndexService()
    const snapshot = await index.refresh(workspace)
    const barrel = snapshot.files.find((file) => file.path === 'src/index.ts')

    expect(barrel).toEqual(expect.objectContaining({
      exports: ['targetHelper'],
      reExports: [{ specifier: './helper', exports: ['targetHelper'] }]
    }))

    const related = await index.relatedFiles({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'helperAlias',
      maxResults: 2
    })

    expect(related).toEqual([
      expect.objectContaining({
        path: 'src/helper.ts',
        reason: 're-exported through src/index.ts',
        startLine: 17,
        endLine: 43
      }),
      expect.objectContaining({
        path: 'src/index.ts',
        reason: 'imported by src/service.ts'
      })
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('follows wildcard barrel re-exports using the imported binding name', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-repo-index-reexport-wildcard-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { targetHelper } from './index'",
        'export function runService() {',
        '  return targetHelper()',
        '}'
      ].join('\n')
    )
    await fs.writeFile(path.join(workspace, 'src', 'index.ts'), "export * from './helper'\n")
    await fs.writeFile(path.join(workspace, 'src', 'helper.ts'), 'export function targetHelper() { return true }\n')

    const index = new RepoIndexService()
    const snapshot = await index.refresh(workspace)
    const barrel = snapshot.files.find((file) => file.path === 'src/index.ts')

    expect(barrel).toEqual(expect.objectContaining({
      reExports: [{ specifier: './helper', exports: ['*'] }]
    }))

    const related = await index.relatedFiles({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'targetHelper',
      maxResults: 2
    })

    expect(related[0]).toEqual(expect.objectContaining({
      path: 'src/helper.ts',
      reason: 're-exported through src/index.ts',
      startLine: 1,
      endLine: 17
    }))

    await fs.rm(workspace, { recursive: true, force: true })
  })
})
