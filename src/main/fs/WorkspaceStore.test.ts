import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), 'gladdis-workspace-store-vitest')

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import { WorkspaceStore } from './WorkspaceStore'

describe('WorkspaceStore', () => {
  beforeEach(async () => {
    delete process.env.GLADDIS_WORKSPACE
    await rm(userData, { recursive: true, force: true })
    await mkdir(userData, { recursive: true })
  })

  it('persists folder changes before setFolder returns', async () => {
    const store = new WorkspaceStore()

    store.setFolder('/tmp/selected-project')

    const raw = await readFile(join(userData, 'gladdis-workspace.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ folder: '/tmp/selected-project' })
  })

  it('loads the persisted folder on a new store instance', () => {
    const first = new WorkspaceStore()
    first.setFolder('/tmp/restarted-project')

    const second = new WorkspaceStore()

    expect(second.get()).toEqual({ folder: '/tmp/restarted-project' })
  })
})
