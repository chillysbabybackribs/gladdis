import { describe, expect, it } from 'vitest'
import { migrateV1ToV2, type V1MemoryFile } from './migrationV1'
import type { MemoryEntry } from './types'

const WORKSPACE = '/tmp/gladdis-test-workspace'
const NOW = new Date('2026-06-29T12:00:00.000Z')

function find(entries: MemoryEntry[], key: string): MemoryEntry | undefined {
  return entries.find((e) => e.key === key)
}

describe('migrateV1ToV2', () => {
  it('drops ephemeral timestamp notes and stale reviews, keeps current facts', () => {
    const v1: V1MemoryFile = {
      version: 1,
      workspace: {
        updatedAt: '2026-06-23T01:41:44.374Z',
        notes: {
          projectName: { value: 'Gladdis' },
          lastTest: { value: '2026-06-21T21:05:33.104Z' },
          optimization_review: {
            review_completed: true,
            timestamp: '2025-01-14',
            issues_found: 12
          },
          added_openai_models: {
            models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-4o mini', 'gpt-4.1 mini']
          },
          grok_optimization_plan: {
            review: 'Grok provider uses raw /chat/completions.',
            optimizations: ['Add context compaction', 'Tighten caps on tool results']
          }
        }
      },
      tasks: {
        'task-old': { label: 'old', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
        'task-recent': { label: 'recent', createdAt: '2026-06-23T01:41:44.374Z', updatedAt: '2026-06-23T01:41:44.374Z' }
      }
    }

    const { file, backupBytes } = migrateV1ToV2(v1, WORKSPACE, NOW)

    expect(file.version).toBe(2)
    expect(file.workspace.root).toBe(WORKSPACE)
    expect(backupBytes).toContain('"version": 1')

    const droppedKeys = (file.legacyDropped ?? []).map((d) => d.key)
    expect(droppedKeys).toContain('notes.lastTest')
    expect(droppedKeys).toContain('notes.optimization_review')
    expect(droppedKeys).toContain('tasks.task-old')

    expect(file.tasks['task-recent']).toBeDefined()
    expect(file.tasks['task-old']).toBeUndefined()

    const projectName = find(file.entries, 'projectName')
    expect(projectName?.kind).toBe('project-fact')
    expect(projectName?.value).toBe('Gladdis')
    expect(projectName?.workspaceRoot).toBe(WORKSPACE)
    expect(projectName?.tags).toContain('migrated-from-v1')
    expect(projectName?.confidence).toBe(0.4)
    expect(projectName?.evidence).toEqual([])

    const models = find(file.entries, 'added_openai_models')
    expect(models).toBeDefined()
    const dedupedModels = (models?.value as { models: string[] }).models
    // "gpt-4o mini" collapses into "gpt-4o-mini" (dash/space equivalence),
    // but "gpt-4.1 mini" is a distinct model and stays.
    expect(dedupedModels).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-4.1 mini'])

    const plan = find(file.entries, 'grok_optimization_plan')
    expect(plan?.kind).toBe('playbook')
  })

  it('promotes non-metadata task fields to legacy entries scoped to the task', () => {
    const v1: V1MemoryFile = {
      version: 1,
      workspace: { updatedAt: '2026-06-23T01:41:44.374Z' },
      tasks: {
        'task-active': {
          label: 'review-auth',
          createdAt: '2026-06-23T01:41:44.374Z',
          updatedAt: '2026-06-23T01:41:44.374Z',
          findings: { failing: 2 },
          plan: ['inspect', 'patch']
        }
      }
    }

    const { file } = migrateV1ToV2(v1, WORKSPACE, NOW)
    const taskEntries = file.entries.filter((e) => e.scope === 'task')
    expect(taskEntries).toHaveLength(2)
    expect(taskEntries.every((e) => e.taskId === 'task-active')).toBe(true)
    expect(taskEntries.every((e) => e.kind === 'legacy')).toBe(true)
    expect(taskEntries.every((e) => e.tags.includes('task:task-active'))).toBe(true)
  })

  it('produces no legacyDropped audit when nothing is rejected', () => {
    const v1: V1MemoryFile = {
      version: 1,
      workspace: {
        updatedAt: '2026-06-23T01:41:44.374Z',
        notes: { projectName: { value: 'Gladdis' } }
      },
      tasks: {}
    }
    const { file } = migrateV1ToV2(v1, WORKSPACE, NOW)
    expect(file.legacyDropped).toBeUndefined()
  })

  it('handles facts and preferences sections with their semantic kinds', () => {
    const v1: V1MemoryFile = {
      version: 1,
      workspace: {
        updatedAt: NOW.toISOString(),
        facts: { stack: 'electron-vite 5' },
        preferences: { editor: 'vim' }
      }
    }
    const { file } = migrateV1ToV2(v1, WORKSPACE, NOW)
    const stack = find(file.entries, 'stack')
    const editor = find(file.entries, 'editor')
    expect(stack?.kind).toBe('project-fact')
    expect(editor?.kind).toBe('preference')
  })

  it('is deterministic: same input + same `now` yields identical entry ids', () => {
    const v1: V1MemoryFile = {
      version: 1,
      workspace: { updatedAt: NOW.toISOString(), notes: { a: 1, b: 2 } }
    }
    const r1 = migrateV1ToV2(v1, WORKSPACE, NOW)
    const r2 = migrateV1ToV2(v1, WORKSPACE, NOW)
    expect(r1.file.entries.map((e) => e.id)).toEqual(r2.file.entries.map((e) => e.id))
  })
})
