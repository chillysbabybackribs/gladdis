/**
 * Rolling on-disk log of past dream runs.
 *
 * Each run — manual or automatic, successful or failed — is appended to
 * `.gladdis/dream-history.json` so the UI can render a timeline without
 * having to scrape old `memory.next.diff.json` files. The log is capped to
 * a fixed length (default 50) and rolls oldest-first; corruption falls
 * back to an empty log so a bad write never breaks the dream pipeline.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { DreamHistoryEntry, DreamHistoryFile } from '../../../../shared/dream'

const HISTORY_FILE = 'dream-history.json'
const MEMORY_DIR = '.gladdis'
const DEFAULT_CAP = 50

export type { DreamHistoryFile } from '../../../../shared/dream'

export async function loadDreamHistory(workspaceRoot: string): Promise<DreamHistoryFile> {
  const path = join(workspaceRoot, MEMORY_DIR, HISTORY_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return emptyHistory()
  }
  try {
    const parsed = JSON.parse(raw) as DreamHistoryFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return emptyHistory()
    }
    // Defensive: drop malformed rows rather than throw.
    parsed.entries = parsed.entries.filter(isValidEntry)
    return parsed
  } catch {
    return emptyHistory()
  }
}

export async function appendDreamHistory(
  workspaceRoot: string,
  entry: DreamHistoryEntry,
  cap: number = DEFAULT_CAP
): Promise<void> {
  const dir = join(workspaceRoot, MEMORY_DIR)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const current = await loadDreamHistory(workspaceRoot)
  // Newest first, then trim. Newest-first ordering matches what the UI
  // wants to render and keeps the JSON readable when inspecting on disk.
  const updated: DreamHistoryFile = {
    version: 1,
    entries: [entry, ...current.entries].slice(0, cap)
  }
  const path = join(dir, HISTORY_FILE)
  await writeFile(path, JSON.stringify(updated, null, 2), 'utf8')
}

/** Patch a single entry by id (used to flip `awaitingReview` after adoption). */
export async function patchDreamHistory(
  workspaceRoot: string,
  id: string,
  patch: Partial<DreamHistoryEntry>
): Promise<void> {
  const current = await loadDreamHistory(workspaceRoot)
  let changed = false
  const next = current.entries.map((e) => {
    if (e.id !== id) return e
    changed = true
    return { ...e, ...patch }
  })
  if (!changed) return
  const path = join(workspaceRoot, MEMORY_DIR, HISTORY_FILE)
  await writeFile(
    path,
    JSON.stringify({ version: 1, entries: next } satisfies DreamHistoryFile, null, 2),
    'utf8'
  )
}

function emptyHistory(): DreamHistoryFile {
  return { version: 1, entries: [] }
}

function isValidEntry(e: unknown): e is DreamHistoryEntry {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.completedAt === 'number' &&
    (o.source === 'manual' || o.source === 'auto') &&
    typeof o.modelId === 'string' &&
    typeof o.modelProvider === 'string' &&
    typeof o.ok === 'boolean' &&
    typeof o.autoAdopted === 'boolean' &&
    typeof o.awaitingReview === 'boolean'
  )
}

export const __test = { HISTORY_FILE, MEMORY_DIR, DEFAULT_CAP }
