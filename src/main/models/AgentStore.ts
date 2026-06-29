import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { SaveAgentInput, SavedAgent } from '../../../shared/types'

export class AgentStore {
  private file = join(app.getPath('userData'), 'gladdis-agents.json')
  private agents = new Map<string, SavedAgent>()
  private onUpdated?: (agents: SavedAgent[]) => void

  constructor(onUpdated?: (agents: SavedAgent[]) => void) {
    this.onUpdated = onUpdated
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as SavedAgent[]
      for (const agent of raw) {
        if (
          agent &&
          typeof agent.id === 'string' &&
          typeof agent.name === 'string' &&
          typeof agent.modelId === 'string' &&
          typeof agent.prompt === 'string'
        ) {
          this.agents.set(agent.id, agent)
        }
      }
    } catch (error) {
      console.warn('[agents] failed to load:', error)
    }
  }

  list(): SavedAgent[] {
    return [...this.agents.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async save(input: SaveAgentInput): Promise<SavedAgent> {
    const now = Date.now()
    const normalizeString = (value?: string) => {
      if (!value) return undefined
      const next = value.trim()
      return next.length ? next : undefined
    }
    const normalizeStringArray = (values?: string[]) => {
      if (!Array.isArray(values)) return undefined
      const out = values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
      return out.length ? out : undefined
    }
    const existing = input.id ? this.agents.get(input.id) : null
    const agent: SavedAgent = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name.trim(),
      modelId: input.modelId.trim(),
      prompt: input.prompt.trim(),
      goal: normalizeString(input.goal),
      optimizerModelId: normalizeString(input.optimizerModelId),
      runtimeModelId: normalizeString(input.runtimeModelId),
      taskFamily: normalizeString(input.taskFamily),
      workspaceBound: input.workspaceBound,
      preferredTools: normalizeStringArray(input.preferredTools),
      disallowedTools: normalizeStringArray(input.disallowedTools),
      knownPaths: normalizeStringArray(input.knownPaths),
      knownCommands: normalizeStringArray(input.knownCommands),
      workflowSteps: normalizeStringArray(input.workflowSteps),
      verificationSteps: normalizeStringArray(input.verificationSteps),
      stopConditions: normalizeStringArray(input.stopConditions),
      fallbackRules: normalizeStringArray(input.fallbackRules),
      assumptions: normalizeStringArray(input.assumptions),
      testTasks: normalizeStringArray(input.testTasks),
      optimizationSummary: normalizeString(input.optimizationSummary),
      evidenceNotes: normalizeStringArray(input.evidenceNotes),
      validationNotes: normalizeStringArray(input.validationNotes),
      roughPrompt: input.roughPrompt?.trim() || undefined,
      testTask: input.testTask?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    if (!agent.name) throw new Error('Agent name is required')
    if (!agent.modelId) throw new Error('Agent model is required')
    if (!agent.prompt) throw new Error('Agent prompt is required')

    this.agents.set(agent.id, agent)
    await this.writeNow()
    this.onUpdated?.(this.list())
    return agent
  }

  async delete(id: string): Promise<void> {
    if (!this.agents.delete(id)) return
    await this.writeNow()
    this.onUpdated?.(this.list())
  }

  private async writeNow(): Promise<void> {
    const tmp = this.file + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify(this.list()), { mode: 0o600 })
      await rename(tmp, this.file)
    } catch (error) {
      console.warn('[agents] failed to persist:', error)
      throw error
    }
  }
}
