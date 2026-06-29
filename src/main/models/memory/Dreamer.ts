/**
 * Dreamer — the orchestrator. Owns the run lifecycle (extract → reconcile →
 * verify → write candidate file → return diff), and the adopt/discard/load-last
 * surface the UI consumes. One Dreamer instance per process; concurrency is
 * gated by a per-workspace in-flight flag so a user cannot start two dreams
 * against the same memory at once.
 */

import { readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChatStore } from '../ChatStore'
import type { KeyStore } from '../KeyStore'
import type {
  DreamAdoptResult,
  DreamDiff,
  DreamDiscardResult,
  DreamRunRequest,
  DreamRunResult,
  DreamScope,
  DreamStatus,
  KeyStatus,
  ModelOption
} from '../../../../shared/types'
import { loadMemoryFile, saveMemoryFile } from '../memoryStore'
import {
  type MemoryFileV2,
  type MemoryEntry,
  MEMORY_FILE_VERSION
} from './types'
import { sampleTranscripts } from './transcriptSampler'
import { pickDreamModel } from './pickDreamModel'
import { runExtractStage } from './extractStage'
import { runReconcileStage } from './reconcileStage'
import { runVerifyStage } from './verifyStage'
import { composeDreamDiff } from './diff'

const CANDIDATE_FILE = 'memory.next.json'
const DIFF_FILE = 'memory.next.diff.json'

export interface DreamerDeps {
  chats: ChatStore
  /** Provider-agnostic completion call (already proven cross-provider in ChatService). */
  complete: (modelId: string, system: string, user: string) => Promise<string>
  /** Resolves which providers are configured (API keys + Codex CLI auth). */
  getKeyStatus: () => Promise<KeyStatus> | KeyStatus
  /** Live Codex catalog from the app-server. Falls back to MODELS when empty. */
  getDynamicCodexModels?: () => Promise<ModelOption[]> | ModelOption[]
}

export class Dreamer {
  private inFlight = new Map<string, { startedAt: number; scope: DreamScope; modelId: string }>()

  constructor(private readonly deps: DreamerDeps) {}

  status(workspaceRoot: string): DreamStatus {
    const job = this.inFlight.get(workspaceRoot)
    if (!job) return { inFlight: false }
    return {
      inFlight: true,
      startedAt: job.startedAt,
      scope: job.scope,
      modelId: job.modelId
    }
  }

  async run(req: DreamRunRequest): Promise<DreamRunResult> {
    if (!req.workspaceRoot) {
      return { ok: false, error: 'dream:run requires a workspace folder.' }
    }
    if (this.inFlight.has(req.workspaceRoot)) {
      return { ok: false, error: 'A dream is already running for this workspace.' }
    }

    const keyStatus = await this.deps.getKeyStatus()
    const dynamicCodex = (await this.deps.getDynamicCodexModels?.()) ?? []
    const model = pickDreamModel(keyStatus, {
      modelId: req.modelId,
      preferenceOrder: req.preferenceOrder ?? 'cheapest',
      dynamicCodexModels: dynamicCodex
    })
    if (!model) {
      return {
        ok: false,
        error:
          req.modelId
            ? `Model "${req.modelId}" is not available for this provider configuration.`
            : 'No configured provider can run a dream. Configure an API key or sign in to Codex.'
      }
    }

    this.inFlight.set(req.workspaceRoot, {
      startedAt: Date.now(),
      scope: req.scope,
      modelId: model.id
    })

    try {
      return await this.runPipeline(req, model)
    } finally {
      this.inFlight.delete(req.workspaceRoot)
    }
  }

  private async runPipeline(req: DreamRunRequest, model: ModelOption): Promise<DreamRunResult> {
    const workspaceRoot = req.workspaceRoot
    const live = await loadMemoryFile(workspaceRoot)
    const sample = sampleTranscripts(this.deps.chats, req.scope)
    if (sample.conversationIds.length === 0) {
      return {
        ok: false,
        error: `No conversations found in scope "${req.scope}". Try a wider scope.`
      }
    }

    const extract = await runExtractStage(
      { complete: this.deps.complete },
      {
        modelId: model.id,
        transcripts: sample.text,
        existingEntries: live.entries,
        instructions: req.instructions
      }
    )

    const reconcile = runReconcileStage({
      existingEntries: live.entries,
      candidates: extract.candidates,
      workspaceRoot
    })

    const verify = await runVerifyStage(
      { complete: this.deps.complete },
      {
        modelId: model.id,
        decisions: reconcile.decisions,
        resultEntries: reconcile.resultEntries
      }
    )

    const candidateFile: MemoryFileV2 = {
      version: MEMORY_FILE_VERSION,
      workspace: { root: workspaceRoot, updatedAt: new Date().toISOString() },
      entries: reconcile.resultEntries,
      tasks: { ...live.tasks }
    }
    const candidatePath = join(workspaceRoot, '.gladdis', CANDIDATE_FILE)
    const diffPath = join(workspaceRoot, '.gladdis', DIFF_FILE)

    try {
      await writeFile(candidatePath, JSON.stringify(candidateFile, null, 2), 'utf8')
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write candidate file: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const diff = composeDreamDiff({
      id: `drm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      modelId: model.id,
      modelProvider: model.provider,
      scope: req.scope,
      workspaceRoot,
      existingEntries: live.entries,
      resultEntries: reconcile.resultEntries,
      decisions: reconcile.decisions,
      verifications: verify.verifications,
      candidateFilePath: candidatePath,
      sampledSessionCount: sample.conversationIds.length
    })

    try {
      await writeFile(diffPath, JSON.stringify(diff, null, 2), 'utf8')
    } catch (err) {
      console.warn('[dream] failed to persist diff metadata:', err)
    }

    if (extract.parseFailed && extract.candidates.length === 0) {
      return {
        ok: false,
        error: 'Extract stage returned unparseable JSON; nothing to dream over.',
        partial: diff
      }
    }

    return { ok: true, diff }
  }

  async loadLast(workspaceRoot: string): Promise<DreamDiff | null> {
    const diffPath = join(workspaceRoot, '.gladdis', DIFF_FILE)
    let raw: string
    try {
      raw = await readFile(diffPath, 'utf8')
    } catch {
      return null
    }
    let parsed: DreamDiff
    try {
      parsed = JSON.parse(raw) as DreamDiff
    } catch {
      return null
    }
    parsed.awaitingAdopt = await fileExists(join(workspaceRoot, '.gladdis', CANDIDATE_FILE))
    return parsed
  }

  async adopt(workspaceRoot: string): Promise<DreamAdoptResult> {
    const dir = join(workspaceRoot, '.gladdis')
    const candidatePath = join(dir, CANDIDATE_FILE)
    let raw: string
    try {
      raw = await readFile(candidatePath, 'utf8')
    } catch {
      return { ok: false, error: 'No candidate dream file is awaiting adoption.' }
    }
    let candidate: MemoryFileV2
    try {
      candidate = JSON.parse(raw) as MemoryFileV2
    } catch (err) {
      return { ok: false, error: `Candidate file is unreadable: ${(err as Error).message}` }
    }
    if (candidate.version !== MEMORY_FILE_VERSION) {
      return { ok: false, error: `Candidate file has wrong version ${candidate.version}.` }
    }
    // Defensive: re-bind to the current workspace root in case the project moved.
    candidate.workspace.root = workspaceRoot
    candidate.workspace.updatedAt = new Date().toISOString()

    try {
      await saveMemoryFile(workspaceRoot, candidate)
    } catch (err) {
      return { ok: false, error: `Failed to write memory.json: ${(err as Error).message}` }
    }
    // Remove the candidate after a successful adopt; keep the diff for "View last dream".
    await unlinkSafe(candidatePath)
    return { ok: true, entryCount: candidate.entries.length }
  }

  async discard(workspaceRoot: string): Promise<DreamDiscardResult> {
    const dir = join(workspaceRoot, '.gladdis')
    await unlinkSafe(join(dir, CANDIDATE_FILE))
    await unlinkSafe(join(dir, DIFF_FILE))
    return { ok: true }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

async function unlinkSafe(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* swallow: discarding a non-existent file is fine */
  }
}

// Surfacing helpers used in tests; production callers go through the class.
export const __test = {
  CANDIDATE_FILE,
  DIFF_FILE
}
