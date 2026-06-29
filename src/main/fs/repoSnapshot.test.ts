import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { snapshotDirectoryTree } from './repoSnapshot'

describe('snapshotDirectoryTree', () => {
  it('returns stable workspace-relative paths and respects bounds', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-snapshot-'))
    await fs.mkdir(path.join(workspace, 'src', 'main'), { recursive: true })
    await fs.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'main', 'index.ts'), 'console.log("hi")\n')
    await fs.writeFile(path.join(workspace, 'README.md'), '# demo\n')
    await fs.writeFile(path.join(workspace, 'node_modules', 'pkg', 'ignored.js'), 'noop\n')

    const snapshot = await snapshotDirectoryTree(workspace, workspace, {
      maxDepth: 4,
      maxEntries: 3
    })

    expect(snapshot).toEqual(['README.md', 'src/', 'src/main/'])
    await fs.rm(workspace, { recursive: true, force: true })
  })
})
