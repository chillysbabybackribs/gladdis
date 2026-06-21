import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { ToolOutcome } from './browserTools'

export interface WorkspaceMemory {
  updatedAt: string
  notes?: Record<string, unknown>
  facts?: Record<string, unknown>
  preferences?: Record<string, unknown>
}

export interface TaskMemory {
  label?: string
  createdAt: string
  updatedAt: string
  state?: Record<string, unknown>
  findings?: Record<string, unknown>
  plan?: unknown[]
  [key: string]: unknown
}

export interface MemoryFile {
  version: 1
  workspace: WorkspaceMemory
  tasks: Record<string, TaskMemory>
}

const DEFAULT_MEMORY: MemoryFile = {
  version: 1,
  workspace: { updatedAt: new Date().toISOString() },
  tasks: {}
}

async function ensureMemoryDir(workspaceRoot: string): Promise<string> {
  const dir = join(workspaceRoot, '.gladdis')
  await mkdir(dir, { recursive: true })
  return dir
}

async function loadMemory(workspaceRoot: string): Promise<MemoryFile> {
  const dir = await ensureMemoryDir(workspaceRoot)
  const filePath = join(dir, 'memory.json')
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as MemoryFile
  } catch {
    return { ...DEFAULT_MEMORY }
  }
}

async function saveMemory(workspaceRoot: string, memory: MemoryFile): Promise<void> {
  const dir = await ensureMemoryDir(workspaceRoot)
  const filePath = join(dir, 'memory.json')
  memory.workspace.updatedAt = new Date().toISOString()
  await writeFile(filePath, JSON.stringify(memory, null, 2), 'utf8')
}

function getWorkspaceRoot(): string {
  // For now we use the project root that Gladdis is running in.
  // In a real multi-workspace scenario this would come from TabManager / context.
  return process.cwd()
}

export async function memoryWrite(args: Record<string, any>): Promise<ToolOutcome> {
  const { scope, task_id, key, value } = args
  if (!scope || !key || value === undefined) {
    return { ok: false, text: 'memory_write requires scope, key, and value' }
  }

  const root = getWorkspaceRoot()
  const memory = await loadMemory(root)

  if (scope === 'workspace') {
    if (!memory.workspace.notes) memory.workspace.notes = {}
    memory.workspace.notes[key] = value
  } else if (scope === 'task') {
    if (!task_id) return { ok: false, text: 'task_id is required when scope is "task"' }
    if (!memory.tasks[task_id]) {
      memory.tasks[task_id] = {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
    memory.tasks[task_id][key] = value
    memory.tasks[task_id].updatedAt = new Date().toISOString()
  } else {
    return { ok: false, text: `Invalid scope: ${scope}` }
  }

  await saveMemory(root, memory)
  return { ok: true, text: `Written to ${scope}${task_id ? `:${task_id}` : ''} → ${key}` }
}

export async function memoryRead(args: Record<string, any>): Promise<ToolOutcome> {
  const { scope, task_id, keys } = args
  if (!scope) return { ok: false, text: 'memory_read requires scope' }

  const root = getWorkspaceRoot()
  const memory = await loadMemory(root)

  if (scope === 'workspace') {
    const data = memory.workspace
    const result = keys?.length ? Object.fromEntries(keys.map((k: string) => [k, (data as any)[k]])) : data
    return { ok: true, text: JSON.stringify(result, null, 2) }
  }

  if (scope === 'task') {
    if (!task_id) return { ok: false, text: 'task_id is required when scope is "task"' }
    const task = memory.tasks[task_id]
    if (!task) return { ok: false, text: `Task not found: ${task_id}` }
    const result = keys?.length ? Object.fromEntries(keys.map((k: string) => [k, task[k]])) : task
    return { ok: true, text: JSON.stringify(result, null, 2) }
  }

  return { ok: false, text: `Invalid scope: ${scope}` }
}

export async function memoryList(args: Record<string, any>): Promise<ToolOutcome> {
  const { scope, task_id } = args
  const root = getWorkspaceRoot()
  const memory = await loadMemory(root)

  if (scope === 'workspace') {
    const keys = Object.keys(memory.workspace)
    return { ok: true, text: JSON.stringify({ keys, updatedAt: memory.workspace.updatedAt }, null, 2) }
  }

  if (scope === 'task') {
    if (task_id) {
      const task = memory.tasks[task_id]
      if (!task) return { ok: false, text: `Task not found: ${task_id}` }
      return { ok: true, text: JSON.stringify({ task_id, keys: Object.keys(task) }, null, 2) }
    }
    // List all tasks
    const tasks = Object.entries(memory.tasks).map(([id, t]) => ({
      id,
      label: t.label,
      updatedAt: t.updatedAt
    }))
    return { ok: true, text: JSON.stringify({ tasks }, null, 2) }
  }

  return { ok: false, text: `Invalid scope: ${scope}` }
}

export async function memoryCreateTask(args: Record<string, any>): Promise<ToolOutcome> {
  const label = args.label || 'Untitled task'
  const root = getWorkspaceRoot()
  const memory = await loadMemory(root)

  const taskId = `task-${Date.now().toString(36)}`
  memory.tasks[taskId] = {
    label,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  await saveMemory(root, memory)
  return { ok: true, text: `Created task: ${taskId} (use this as task_id in future calls)` }
}

export async function memoryForget(args: Record<string, any>): Promise<ToolOutcome> {
  const { scope, task_id, keys } = args
  const root = getWorkspaceRoot()
  const memory = await loadMemory(root)

  if (scope === 'workspace') {
    if (keys?.length) {
      keys.forEach((k: string) => delete (memory.workspace as any)[k])
    } else {
      memory.workspace = { updatedAt: new Date().toISOString() }
    }
  } else if (scope === 'task') {
    if (!task_id) return { ok: false, text: 'task_id required for task scope' }
    if (keys?.length) {
      keys.forEach((k: string) => delete memory.tasks[task_id][k])
    } else {
      delete memory.tasks[task_id]
    }
  }

  await saveMemory(root, memory)
  return { ok: true, text: 'Memory updated' }
}
