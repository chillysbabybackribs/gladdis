/**
 * Lossy one-shot migration from the v1 free-form memory file to the v2 typed
 * schema. Rules:
 *
 *   • workspace.notes / facts / preferences:
 *       - value is a single ISO timestamp           → drop (ephemeral)
 *       - object with a `timestamp` field > 90 days → drop (stale review)
 *       - object whose key/structure suggests a procedure → kind: playbook
 *       - otherwise                                  → kind: project-fact
 *       (facts → project-fact, preferences → preference, regardless of shape)
 *   • tasks: drop entries whose updatedAt is > 30 days old. Keep label/created/
 *     updated as a task record; promote any other field to a `legacy` entry
 *     tagged with the task id.
 *   • Arrays of strings inside object values are deduplicated (whitespace +
 *     casing normalized) so things like `["gpt-4o mini", "gpt-4o-mini"]`
 *     collapse to one canonical item.
 *
 * The original v1 bytes are returned alongside the v2 file so the caller can
 * write a backup before atomic-replacing the live file.
 */

import {
  MEMORY_FILE_VERSION,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryFileV2,
  type MemoryTaskRecord
} from './types'

const STALE_REVIEW_DAYS = 90
const STALE_TASK_DAYS = 30

export interface V1WorkspaceMemory {
  updatedAt?: string
  notes?: Record<string, unknown>
  facts?: Record<string, unknown>
  preferences?: Record<string, unknown>
}

export interface V1TaskMemory {
  label?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface V1MemoryFile {
  version: 1
  workspace?: V1WorkspaceMemory
  tasks?: Record<string, V1TaskMemory>
}

export interface MigrationResult {
  file: MemoryFileV2
  backupBytes: string
}

export function isV1MemoryFile(raw: unknown): raw is V1MemoryFile {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).version === 1
}

export function isV2MemoryFile(raw: unknown): raw is MemoryFileV2 {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).version === MEMORY_FILE_VERSION
}

export function migrateV1ToV2(
  v1: V1MemoryFile,
  workspaceRoot: string,
  now: Date = new Date()
): MigrationResult {
  const dropped: Array<{ key: string; reason: string }> = []
  const idCounter = { n: 0 }

  const notesEntries = migrateSection(v1.workspace?.notes, 'inferred', workspaceRoot, now, dropped, idCounter, 'notes')
  const factsEntries = migrateSection(v1.workspace?.facts, 'project-fact', workspaceRoot, now, dropped, idCounter, 'facts')
  const prefEntries = migrateSection(v1.workspace?.preferences, 'preference', workspaceRoot, now, dropped, idCounter, 'preferences')
  const { tasks, entries: taskEntries } = migrateTasks(v1.tasks, workspaceRoot, now, dropped, idCounter)

  const file: MemoryFileV2 = {
    version: MEMORY_FILE_VERSION,
    workspace: {
      root: workspaceRoot,
      updatedAt: now.toISOString()
    },
    entries: [...notesEntries, ...factsEntries, ...prefEntries, ...taskEntries],
    tasks,
    ...(dropped.length > 0 ? { legacyDropped: dropped } : {})
  }

  return {
    file,
    backupBytes: JSON.stringify(v1, null, 2)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function migrateSection(
  section: Record<string, unknown> | undefined,
  defaultKind: MemoryEntryKind | 'inferred',
  workspaceRoot: string,
  now: Date,
  dropped: Array<{ key: string; reason: string }>,
  idCounter: { n: number },
  sectionLabel: string
): MemoryEntry[] {
  if (!section) return []
  const entries: MemoryEntry[] = []
  for (const [key, rawValue] of Object.entries(section)) {
    const value = unwrapValueWrapper(rawValue)

    if (typeof value === 'string') {
      const iso = tryParseIso(value)
      if (iso) {
        dropped.push({ key: `${sectionLabel}.${key}`, reason: 'ephemeral-timestamp' })
        continue
      }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const stamp = (value as Record<string, unknown>).timestamp
      const stampDate = typeof stamp === 'string' ? tryParseIso(stamp) : null
      if (stampDate && daysBetween(now, stampDate) > STALE_REVIEW_DAYS) {
        dropped.push({ key: `${sectionLabel}.${key}`, reason: 'stale-review' })
        continue
      }
    }

    const normalized = normalizeListValues(value)
    const kind: MemoryEntryKind =
      defaultKind === 'inferred'
        ? (normalized && typeof normalized === 'object' && !Array.isArray(normalized) && looksLikePlaybook(key, normalized)
            ? 'playbook'
            : 'project-fact')
        : defaultKind

    entries.push({
      id: makeId(now, idCounter),
      kind,
      scope: 'workspace',
      workspaceRoot,
      key,
      value: normalized,
      text: formatAsText(key, normalized),
      evidence: [],
      confidence: 0.4,
      freshness: {
        createdAt: now.toISOString(),
        lastReinforcedAt: now.toISOString()
      },
      tags: ['migrated-from-v1', `section:${sectionLabel}`]
    })
  }
  return entries
}

function migrateTasks(
  tasks: V1MemoryFile['tasks'],
  workspaceRoot: string,
  now: Date,
  dropped: Array<{ key: string; reason: string }>,
  idCounter: { n: number }
): { tasks: Record<string, MemoryTaskRecord>; entries: MemoryEntry[] } {
  const outTasks: Record<string, MemoryTaskRecord> = {}
  const entries: MemoryEntry[] = []
  if (!tasks) return { tasks: outTasks, entries }

  for (const [taskId, task] of Object.entries(tasks)) {
    const updatedAtIso = task.updatedAt ?? task.createdAt
    const updatedAt = typeof updatedAtIso === 'string' ? tryParseIso(updatedAtIso) : null
    if (updatedAt && daysBetween(now, updatedAt) > STALE_TASK_DAYS) {
      dropped.push({ key: `tasks.${taskId}`, reason: 'stale-task' })
      continue
    }

    const createdAt = typeof task.createdAt === 'string' ? task.createdAt : now.toISOString()
    const updatedAtStr = typeof task.updatedAt === 'string' ? task.updatedAt : createdAt
    outTasks[taskId] = {
      id: taskId,
      ...(typeof task.label === 'string' ? { label: task.label } : {}),
      createdAt,
      updatedAt: updatedAtStr
    }

    for (const [k, v] of Object.entries(task)) {
      if (k === 'label' || k === 'createdAt' || k === 'updatedAt') continue
      entries.push({
        id: makeId(now, idCounter),
        kind: 'legacy',
        scope: 'task',
        workspaceRoot,
        taskId,
        key: k,
        value: v,
        text: formatAsText(k, v),
        evidence: [],
        confidence: 0.4,
        freshness: {
          createdAt,
          lastReinforcedAt: updatedAtStr
        },
        tags: ['migrated-from-v1', `task:${taskId}`]
      })
    }
  }
  return { tasks: outTasks, entries }
}

// ── helpers ────────────────────────────────────────────────────────────────

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}([T ]|$)/

function tryParseIso(s: unknown): Date | null {
  if (typeof s !== 'string') return null
  if (!ISO_PREFIX.test(s)) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs((a.getTime() - b.getTime()) / 86_400_000)
}

function unwrapValueWrapper(raw: unknown): unknown {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.keys(raw as object).length === 1 &&
    Object.prototype.hasOwnProperty.call(raw, 'value')
  ) {
    return (raw as Record<string, unknown>).value
  }
  return raw
}

const PLAYBOOK_HINTS = ['plan', 'playbook', 'review', 'optimization', 'steps', 'process', 'checklist']

function looksLikePlaybook(key: string, value: object): boolean {
  const k = key.toLowerCase()
  if (PLAYBOOK_HINTS.some((h) => k.includes(h))) return true
  const valueKeys = Object.keys(value).map((vk) => vk.toLowerCase())
  return valueKeys.some((vk) => PLAYBOOK_HINTS.some((h) => vk.includes(h)))
}

function normalizeListValues(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = Array.isArray(v) && v.every((x) => typeof x === 'string') ? dedupStrings(v as string[]) : v
  }
  return out
}

function dedupStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const norm = item.toLowerCase().replace(/[\s-]+/g, ' ').trim()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(item)
  }
  return out
}

function formatAsText(key: string, value: unknown): string {
  if (typeof value === 'string') return `${key}: ${value}`
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`
  if (value == null) return `${key}: (null)`
  try {
    return `${key}: ${JSON.stringify(value)}`
  } catch {
    return `${key}: (unserializable)`
  }
}

function makeId(now: Date, counter: { n: number }): string {
  counter.n += 1
  return `mem_${now.getTime().toString(36)}_${counter.n.toString(36)}`
}
