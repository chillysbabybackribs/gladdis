/**
 * Working-memory storage. Public API matches the v1 surface (the `memory_*`
 * tool calls), so the LLM sees no schema change; underneath we now keep typed
 * `MemoryEntry` records in a v2 file. A v1 file on disk is migrated lazily on
 * first read, with the original bytes preserved as `.gladdis/memory.v1.backup.json`.
 *
 * The dreamer (Phase 1+) reads the same file directly through `loadMemoryFile`
 * and produces a candidate `memory.next.json`; it does not go through these
 * tool-shaped functions.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { ToolOutcome } from './browserTools'
import {
  emptyMemoryFile,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryFileV2,
  type MemoryScope
} from './memory/types'
import { isV1MemoryFile, isV2MemoryFile, migrateV1ToV2 } from './memory/migrationV1'

const MEMORY_DIR = '.gladdis'
const MEMORY_FILE = 'memory.json'
const MEMORY_V1_BACKUP = 'memory.v1.backup.json'
const MEMORY_UNKNOWN_BACKUP = 'memory.unknown.backup.json'

async function ensureMemoryDir(workspaceRoot: string): Promise<string> {
  const dir = join(workspaceRoot, MEMORY_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Load the live memory file, transparently migrating v1 to v2 on first read.
 * Exported so the eventual Dreamer can read entries directly without going
 * through the tool-shaped wrappers below.
 */
export async function loadMemoryFile(workspaceRoot: string): Promise<MemoryFileV2> {
  const dir = await ensureMemoryDir(workspaceRoot)
  const filePath = join(dir, MEMORY_FILE)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return emptyMemoryFile(workspaceRoot)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await safeBackup(dir, MEMORY_UNKNOWN_BACKUP, raw)
    return emptyMemoryFile(workspaceRoot)
  }
  if (isV2MemoryFile(parsed)) {
    // Sanity-fix: persisted workspace.root may be stale if the project moved.
    if (parsed.workspace.root !== workspaceRoot) parsed.workspace.root = workspaceRoot
    return parsed
  }
  if (isV1MemoryFile(parsed)) {
    const { file, backupBytes } = migrateV1ToV2(parsed, workspaceRoot)
    await safeBackup(dir, MEMORY_V1_BACKUP, backupBytes)
    await saveMemoryFile(workspaceRoot, file)
    return file
  }
  await safeBackup(dir, MEMORY_UNKNOWN_BACKUP, raw)
  return emptyMemoryFile(workspaceRoot)
}

export async function saveMemoryFile(workspaceRoot: string, memory: MemoryFileV2): Promise<void> {
  const dir = await ensureMemoryDir(workspaceRoot)
  const filePath = join(dir, MEMORY_FILE)
  memory.workspace.root = workspaceRoot
  memory.workspace.updatedAt = new Date().toISOString()
  await writeFile(filePath, JSON.stringify(memory, null, 2), 'utf8')
}

async function safeBackup(dir: string, name: string, bytes: string): Promise<void> {
  try {
    await writeFile(join(dir, name), bytes, 'utf8')
  } catch (err) {
    console.warn(`[memory] failed to write ${name}:`, err)
  }
}

// ── tool-shaped API (1:1 with the v1 surface) ─────────────────────────────────

export interface MemoryWriteArgs {
  scope?: string
  task_id?: string
  key?: string
  value?: unknown
  /** Optional provenance, used when the dispatcher knows the current chat. */
  conversationId?: string
}

export async function memoryWrite(args: MemoryWriteArgs, workspaceRoot: string): Promise<ToolOutcome> {
  const scope = args.scope as MemoryScope | undefined
  const { task_id, key, value, conversationId } = args
  if (!scope || !key || value === undefined) {
    return { ok: false, text: 'memory_write requires scope, key, and value' }
  }
  if (scope !== 'workspace' && scope !== 'task') {
    return { ok: false, text: `Invalid scope: ${scope}` }
  }
  if (scope === 'task' && !task_id) {
    return { ok: false, text: 'task_id is required when scope is "task"' }
  }

  const memory = await loadMemoryFile(workspaceRoot)
  const now = new Date().toISOString()
  const existing = findEntry(memory, scope, task_id, key)

  if (existing) {
    existing.value = value
    existing.text = formatAsText(key, value)
    existing.freshness.lastReinforcedAt = now
    // Re-writes are reinforcements: floor at 0.7, gently approach 0.95.
    existing.confidence = Math.min(0.95, Math.max(existing.confidence + 0.05, 0.7))
    if (typeof conversationId === 'string' && conversationId) {
      existing.evidence.push({ conversationId })
    }
  } else {
    const entry: MemoryEntry = {
      id: generateEntryId(),
      kind: inferKind(scope),
      scope,
      workspaceRoot,
      ...(scope === 'task' && task_id ? { taskId: task_id } : {}),
      key,
      value,
      text: formatAsText(key, value),
      evidence: typeof conversationId === 'string' && conversationId ? [{ conversationId }] : [],
      confidence: 0.7,
      freshness: { createdAt: now, lastReinforcedAt: now },
      tags: []
    }
    memory.entries.push(entry)
  }

  if (scope === 'task' && task_id) {
    const existingTask = memory.tasks[task_id]
    if (existingTask) {
      existingTask.updatedAt = now
    } else {
      memory.tasks[task_id] = { id: task_id, createdAt: now, updatedAt: now }
    }
  }

  await saveMemoryFile(workspaceRoot, memory)
  return { ok: true, text: `Written to ${scope}${task_id ? `:${task_id}` : ''} → ${key}` }
}

export interface MemoryReadArgs {
  scope?: string
  task_id?: string
  keys?: string[]
}

export async function memoryRead(args: MemoryReadArgs, workspaceRoot: string): Promise<ToolOutcome> {
  const scope = args.scope as MemoryScope | undefined
  const { task_id, keys } = args
  if (!scope) return { ok: false, text: 'memory_read requires scope' }
  if (scope !== 'workspace' && scope !== 'task') return { ok: false, text: `Invalid scope: ${scope}` }
  if (scope === 'task' && !task_id) return { ok: false, text: 'task_id is required when scope is "task"' }

  const memory = await loadMemoryFile(workspaceRoot)
  const matched = collectEntries(memory, scope, task_id, keys)

  if (matched.length > 0) {
    const now = new Date().toISOString()
    for (const entry of matched) entry.freshness.lastReferencedAt = now
    await saveMemoryFile(workspaceRoot, memory)
  } else if (scope === 'task' && task_id && !memory.tasks[task_id]) {
    return { ok: false, text: `Task not found: ${task_id}` }
  }

  if (scope === 'workspace') {
    const payload: Record<string, unknown> = { updatedAt: memory.workspace.updatedAt }
    if (keys?.length) {
      for (const k of keys) {
        const e = matched.find((m) => m.key === k)
        payload[k] = e ? e.value : undefined
      }
    } else {
      for (const e of matched) if (e.key) payload[e.key] = e.value
    }
    return { ok: true, text: JSON.stringify(payload, null, 2) }
  }

  const task = memory.tasks[task_id!]
  const payload: Record<string, unknown> = {
    label: task?.label,
    createdAt: task?.createdAt,
    updatedAt: task?.updatedAt
  }
  if (keys?.length) {
    for (const k of keys) {
      const e = matched.find((m) => m.key === k)
      payload[k] = e ? e.value : undefined
    }
  } else {
    for (const e of matched) if (e.key) payload[e.key] = e.value
  }
  return { ok: true, text: JSON.stringify(payload, null, 2) }
}

export interface MemoryListArgs {
  scope?: string
  task_id?: string
}

export async function memoryList(args: MemoryListArgs, workspaceRoot: string): Promise<ToolOutcome> {
  const scope = args.scope as MemoryScope | undefined
  const { task_id } = args
  if (!scope) return { ok: false, text: 'memory_list requires scope' }

  const memory = await loadMemoryFile(workspaceRoot)

  if (scope === 'workspace') {
    const wsEntries = memory.entries.filter((e) => e.scope === 'workspace')
    const keysOut = wsEntries.map((e) => e.key).filter((k): k is string => !!k)
    return {
      ok: true,
      text: JSON.stringify({ keys: keysOut, updatedAt: memory.workspace.updatedAt }, null, 2)
    }
  }

  if (scope === 'task') {
    if (task_id) {
      const task = memory.tasks[task_id]
      if (!task) return { ok: false, text: `Task not found: ${task_id}` }
      const keysOut = memory.entries
        .filter((e) => e.scope === 'task' && e.taskId === task_id && e.key)
        .map((e) => e.key as string)
      return { ok: true, text: JSON.stringify({ task_id, label: task.label, keys: keysOut }, null, 2) }
    }
    const tasks = Object.values(memory.tasks).map((t) => ({
      id: t.id,
      label: t.label,
      updatedAt: t.updatedAt
    }))
    return { ok: true, text: JSON.stringify({ tasks }, null, 2) }
  }

  return { ok: false, text: `Invalid scope: ${scope}` }
}

export interface MemoryCreateTaskArgs {
  label?: string
}

export async function memoryCreateTask(
  args: MemoryCreateTaskArgs,
  workspaceRoot: string
): Promise<ToolOutcome> {
  const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : 'Untitled task'
  const memory = await loadMemoryFile(workspaceRoot)
  const taskId = `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const now = new Date().toISOString()
  memory.tasks[taskId] = { id: taskId, label, createdAt: now, updatedAt: now }
  await saveMemoryFile(workspaceRoot, memory)
  return { ok: true, text: `Created task: ${taskId} (use this as task_id in future calls)` }
}

export interface MemoryForgetArgs {
  scope?: string
  task_id?: string
  keys?: string[]
}

export async function memoryForget(args: MemoryForgetArgs, workspaceRoot: string): Promise<ToolOutcome> {
  const scope = args.scope as MemoryScope | undefined
  const { task_id, keys } = args
  if (!scope) return { ok: false, text: 'memory_forget requires scope' }
  const memory = await loadMemoryFile(workspaceRoot)

  if (scope === 'workspace') {
    if (keys?.length) {
      memory.entries = memory.entries.filter((e) => {
        if (e.scope !== 'workspace') return true
        return !(e.key && keys.includes(e.key))
      })
    } else {
      memory.entries = memory.entries.filter((e) => e.scope !== 'workspace')
    }
  } else if (scope === 'task') {
    if (!task_id) return { ok: false, text: 'task_id required for task scope' }
    if (keys?.length) {
      memory.entries = memory.entries.filter((e) => {
        if (e.scope !== 'task' || e.taskId !== task_id) return true
        return !(e.key && keys.includes(e.key))
      })
    } else {
      memory.entries = memory.entries.filter((e) => !(e.scope === 'task' && e.taskId === task_id))
      delete memory.tasks[task_id]
    }
  } else {
    return { ok: false, text: `Invalid scope: ${scope}` }
  }

  await saveMemoryFile(workspaceRoot, memory)
  return { ok: true, text: 'Memory updated' }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function findEntry(
  memory: MemoryFileV2,
  scope: MemoryScope,
  taskId: string | undefined,
  key: string
): MemoryEntry | undefined {
  return memory.entries.find((e) => {
    if (e.scope !== scope) return false
    if (scope === 'task' && e.taskId !== taskId) return false
    return e.key === key
  })
}

function collectEntries(
  memory: MemoryFileV2,
  scope: MemoryScope,
  taskId: string | undefined,
  keys?: string[]
): MemoryEntry[] {
  return memory.entries.filter((e) => {
    if (e.scope !== scope) return false
    if (scope === 'task' && e.taskId !== taskId) return false
    if (keys?.length && (!e.key || !keys.includes(e.key))) return false
    return true
  })
}

function inferKind(scope: MemoryScope): MemoryEntryKind {
  return scope === 'workspace' ? 'project-fact' : 'playbook'
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

function generateEntryId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export type { MemoryEntry, MemoryFileV2 } from './memory/types'
