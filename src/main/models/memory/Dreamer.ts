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
  DreamProgressEvent,
  DreamRunRequest,
  DreamRunResult,
  DreamScope,
  DreamStage,
  DreamStatus,
  KeyStatus,
  ModelOption
} from '../../../../shared/types'
import { loadMemoryFile, saveMemoryFile } from '../memoryStore'
import { type MemoryFileV2, MEMORY_FILE_VERSION } from './types'
import { sampleTranscripts } from './transcriptSampler'
import { pickDreamModel } from './pickDreamModel'
import { runExtractStage } from './extractStage'
import { runReconcileStage } from './reconcileStage'
import { runLlmReconcileReview } from './llmReconcileStage'
import { runHygieneStage, type HygieneDecision } from './hygieneStage'
import { runVerifyStage } from './verifyStage'
import { composeDreamDiff, evaluateDreamAdoption } from './diff'

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
  /**
   * Stage-by-stage progress sink. Optional so unit tests (and any caller that
   * doesn't care) can stay quiet. The Dreamer never assumes delivery: if the
   * sink throws or the renderer has closed, the run completes anyway.
   */
  emitProgress?: (event: DreamProgressEvent) => void
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

    const runId = `drm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

    this.inFlight.set(req.workspaceRoot, {
      startedAt: Date.now(),
      scope: req.scope,
      modelId: model.id
    })

    this.emit({
      type: 'started',
      runId,
      workspaceRoot: req.workspaceRoot,
      scope: req.scope,
      modelId: model.id,
      modelProvider: model.provider
    })

    try {
      const result = await this.runPipeline(req, model, runId)
      this.emit({
        type: 'done',
        runId,
        workspaceRoot: req.workspaceRoot,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error })
      })
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'done', runId, workspaceRoot: req.workspaceRoot, ok: false, error })
      throw err
    } finally {
      this.inFlight.delete(req.workspaceRoot)
    }
  }

  private emit(event: DreamProgressEvent): void {
    if (!this.deps.emitProgress) return
    try {
      this.deps.emitProgress(event)
    } catch (err) {
      // Never let a UI subscriber's failure break the dream.
      console.warn('[dream] progress sink threw:', err)
    }
  }

  private emitStage(runId: string, workspaceRoot: string, stage: DreamStage, detail?: string): void {
    this.emit({ type: 'stage', runId, workspaceRoot, stage, ...(detail ? { detail } : {}) })
  }

  private async runPipeline(
    req: DreamRunRequest,
    model: ModelOption,
    runId: string
  ): Promise<DreamRunResult> {
    const workspaceRoot = req.workspaceRoot
    this.emitStage(runId, workspaceRoot, 'sampling')
    const live = await loadMemoryFile(workspaceRoot)
    const sample = sampleTranscripts(this.deps.chats, req.scope)
    if (sample.conversationIds.length === 0) {
      return {
        ok: false,
        error: `No conversations found in scope "${req.scope}". Try a wider scope.`
      }
    }
    this.emitStage(
      runId,
      workspaceRoot,
      'sampling',
      `${sample.conversationIds.length} session${sample.conversationIds.length === 1 ? '' : 's'}, ${sample.chars.toLocaleString()} chars${sample.truncated ? ' (truncated)' : ''}`
    )

    this.emitStage(runId, workspaceRoot, 'extracting')
    const extract = await runExtractStage(
      { complete: this.deps.complete },
      {
        modelId: model.id,
        transcripts: sample.text,
        existingEntries: live.entries,
        instructions: req.instructions
      }
    )
    this.emitStage(
      runId,
      workspaceRoot,
      'extracting',
      extract.parseFailed
        ? 'parse failed'
        : `${extract.candidates.length} candidate${extract.candidates.length === 1 ? '' : 's'}`
    )

    this.emitStage(runId, workspaceRoot, 'reconciling')
    const reconcile = runReconcileStage({
      existingEntries: live.entries,
      candidates: extract.candidates,
      workspaceRoot
    })
    this.emitStage(
      runId,
      workspaceRoot,
      'reconciling',
      summarizeReconcile(reconcile.decisions)
    )

    // Stage 3 — model reviews the deterministic decisions. Falls back to the
    // deterministic result on any failure (model error, bad JSON, empty
    // overrides). Tracks `decisions` and `resultEntries` post-review so the
    // verify stage operates on the refined state.
    let decisions = reconcile.decisions
    let resultEntries = reconcile.resultEntries
    if (extract.candidates.length > 0) {
      this.emitStage(runId, workspaceRoot, 'reviewing')
      const review = await runLlmReconcileReview(
        { complete: this.deps.complete },
        {
          modelId: model.id,
          workspaceRoot,
          existingEntries: live.entries,
          candidates: extract.candidates,
          baselineDecisions: reconcile.decisions
        }
      )
      decisions = review.decisions
      resultEntries = review.resultEntries
      this.emitStage(
        runId,
        workspaceRoot,
        'reviewing',
        review.skipped
          ? 'no overrides (deterministic kept)'
          : review.overrideCount === 0
            ? 'reviewed, no overrides'
            : `${review.overrideCount} override${review.overrideCount === 1 ? '' : 's'} → ${summarizeReconcile(decisions)}`
      )
    }

    // Stage 4 — hygiene / curation. Operates on EXISTING entries (post-review
    // working set), not on candidates. The stage picks the stalest entries
    // deterministically, then a single model call triages them into
    // archive / demote / reinforce / keep. Skips entirely when the store is
    // too small for triage to be worthwhile. Like the review stage, every
    // failure path silently keeps the unmodified working set.
    this.emitStage(runId, workspaceRoot, 'curating')
    const hygiene = await runHygieneStage(
      { complete: this.deps.complete },
      {
        modelId: model.id,
        workspaceRoot,
        entries: resultEntries
      }
    )
    const hygieneDecisions: HygieneDecision[] = hygiene.decisions
    resultEntries = hygiene.resultEntries
    this.emitStage(
      runId,
      workspaceRoot,
      'curating',
      hygiene.skipped
        ? hygiene.triagedCount === 0
          ? 'store too small to curate'
          : `triaged ${hygiene.triagedCount}, no changes`
        : `${summarizeHygiene(hygieneDecisions)} (from ${hygiene.triagedCount} triaged)`
    )

    this.emitStage(runId, workspaceRoot, 'verifying')
    const verify = await runVerifyStage(
      { complete: this.deps.complete },
      {
        modelId: model.id,
        decisions,
        resultEntries
      }
    )
    this.emitStage(
      runId,
      workspaceRoot,
      'verifying',
      verify.skipped ? 'skipped (nothing to verify)' : `${verify.verifications.length} sampled`
    )

    this.emitStage(runId, workspaceRoot, 'persisting')
    const candidateFile: MemoryFileV2 = {
      version: MEMORY_FILE_VERSION,
      workspace: { root: workspaceRoot, updatedAt: new Date().toISOString() },
      entries: resultEntries,
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
      id: runId,
      createdAt: Date.now(),
      modelId: model.id,
      modelProvider: model.provider,
      scope: req.scope,
      workspaceRoot,
      existingEntries: live.entries,
      resultEntries,
      decisions,
      verifications: verify.verifications,
      hygiene: hygieneDecisions,
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
    const diffPath = join(dir, DIFF_FILE)
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

    const adoption = await readAdoptionPolicy(diffPath)
    if (!adoption.ok) {
      return { ok: false, error: adoption.error }
    }
    if (adoption.policy.blocked) {
      const first = adoption.policy.issues[0]
      const rest = adoption.policy.issues.length - 1
      return {
        ok: false,
        error: `Dream adoption is blocked by review policy: ${first.message}${rest > 0 ? ` (${rest} more issue${rest === 1 ? '' : 's'})` : ''}`
      }
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

function summarizeReconcile(decisions: ReadonlyArray<{ action: string }>): string {
  const counts = { add: 0, merge: 0, replace: 0, reject: 0 }
  for (const d of decisions) {
    if (d.action === 'add') counts.add++
    else if (d.action === 'merge') counts.merge++
    else if (d.action === 'replace') counts.replace++
    else if (d.action === 'reject') counts.reject++
  }
  const parts: string[] = []
  if (counts.add) parts.push(`${counts.add} new`)
  if (counts.merge) parts.push(`${counts.merge} merged`)
  if (counts.replace) parts.push(`${counts.replace} replaced`)
  if (counts.reject) parts.push(`${counts.reject} rejected`)
  return parts.length === 0 ? 'no changes' : parts.join(', ')
}

function summarizeHygiene(decisions: ReadonlyArray<HygieneDecision>): string {
  const counts = { archive: 0, demote: 0, reinforce: 0, keep: 0 }
  for (const d of decisions) {
    if (d.action === 'archive') counts.archive++
    else if (d.action === 'demote') counts.demote++
    else if (d.action === 'reinforce') counts.reinforce++
    else if (d.action === 'keep') counts.keep++
  }
  const parts: string[] = []
  if (counts.archive) parts.push(`${counts.archive} archived`)
  if (counts.demote) parts.push(`${counts.demote} demoted`)
  if (counts.reinforce) parts.push(`${counts.reinforce} reinforced`)
  if (counts.keep) parts.push(`${counts.keep} reworded`)
  return parts.length === 0 ? 'no changes' : parts.join(', ')
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

async function readAdoptionPolicy(
  diffPath: string
): Promise<{ ok: true; policy: DreamDiff['adoption'] } | { ok: false; error: string }> {
  let raw: string
  try {
    raw = await readFile(diffPath, 'utf8')
  } catch {
    return {
      ok: false,
      error: 'Dream adoption requires review metadata. Run a new dream or discard this candidate.'
    }
  }

  let diff: DreamDiff
  try {
    diff = JSON.parse(raw) as DreamDiff
  } catch (err) {
    return { ok: false, error: `Dream review metadata is unreadable: ${(err as Error).message}` }
  }

  return {
    ok: true,
    policy: diff.adoption ?? evaluateDreamAdoption(diff.entries ?? [], diff.verifications ?? [])
  }
}

// Surfacing helpers used in tests; production callers go through the class.
export const __test = {
  CANDIDATE_FILE,
  DIFF_FILE
}
