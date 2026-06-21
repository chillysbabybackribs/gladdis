import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Workspace } from '../../../shared/types'

/**
 * The folder gladdis works from — the root that relative file paths resolve
 * against for the agent's filesystem tools. Persisted on disk under userData
 * so the choice survives restarts. `folder === null` means no root is pinned,
 * and paths resolve against the process cwd (full-filesystem scope), matching
 * the prior behaviour.
 *
 * GLADDIS_WORKSPACE env var takes precedence and is not persisted, for headless
 * / scripted launches.
 */
export class WorkspaceStore {
  private file = join(app.getPath('userData'), 'gladdis-workspace.json')
  private folder: string | null = null

  constructor() {
    this.load()
    const env = process.env.GLADDIS_WORKSPACE?.trim()
    if (env) this.folder = env
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { folder?: string | null }
      this.folder = raw.folder || null
    } catch (e) {
      console.warn('[workspace] failed to load:', e)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ folder: this.folder }), { mode: 0o600 })
    } catch (e) {
      console.warn('[workspace] failed to persist:', e)
    }
  }

  get(): Workspace {
    return { folder: this.folder }
  }

  setFolder(folder: string | null): Workspace {
    this.folder = folder?.trim() || null
    this.persist()
    return this.get()
  }
}
