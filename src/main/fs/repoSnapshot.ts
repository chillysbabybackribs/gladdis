import * as fs from 'fs/promises'
import * as path from 'path'

const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
  '.pnpm-store',
  '.svelte-kit',
  '.nuxt',
  '.docusaurus',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock'
])

export interface RepoSnapshotOptions {
  maxDepth?: number
  maxEntries?: number
  maxEntriesPerDirectory?: number
  ignoredNames?: Iterable<string>
}

interface SnapshotState {
  remaining: number
}

/**
 * Build a bounded, workspace-relative tree snapshot that stays stable across
 * callers. This keeps our fallback filesystem context cheap and consistent
 * when brokered repo intelligence is unavailable.
 */
export async function snapshotDirectoryTree(
  workspaceRoot: string,
  targetRoot = workspaceRoot,
  options: RepoSnapshotOptions = {}
): Promise<string[]> {
  const baseRoot = path.resolve(workspaceRoot)
  const startRoot = path.resolve(targetRoot)
  const maxEntries = Math.max(1, options.maxEntries ?? Number.POSITIVE_INFINITY)
  const state: SnapshotState = { remaining: maxEntries }
  const ignoredNames = new Set(options.ignoredNames ?? DEFAULT_IGNORED_NAMES)
  return walkSnapshot(baseRoot, startRoot, 0, options.maxDepth ?? 6, options.maxEntriesPerDirectory, ignoredNames, state)
}

async function walkSnapshot(
  baseRoot: string,
  currentRoot: string,
  depth: number,
  maxDepth: number,
  maxEntriesPerDirectory: number | undefined,
  ignoredNames: Set<string>,
  state: SnapshotState
): Promise<string[]> {
  if (depth > maxDepth || state.remaining <= 0) return []

  try {
    const rawEntries = await fs.readdir(currentRoot, { withFileTypes: true })
    const entries = rawEntries
      .filter((entry) => !ignoredNames.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxEntriesPerDirectory == null ? undefined : Math.max(1, maxEntriesPerDirectory))

    const lines: string[] = []
    for (const entry of entries) {
      if (state.remaining <= 0) break
      const fullPath = path.join(currentRoot, entry.name)
      const relPath = path.relative(baseRoot, fullPath).replace(/\\/g, '/')
      if (!relPath) continue

      if (entry.isDirectory()) {
        lines.push(`${relPath}/`)
        state.remaining -= 1
        const nested = await walkSnapshot(
          baseRoot,
          fullPath,
          depth + 1,
          maxDepth,
          maxEntriesPerDirectory,
          ignoredNames,
          state
        )
        lines.push(...nested)
        continue
      }

      lines.push(relPath)
      state.remaining -= 1
    }
    return lines
  } catch {
    return []
  }
}
