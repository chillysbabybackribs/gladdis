/**
 * Cross-process contract for the memory "Dreaming" system. The main process
 * owns the pipeline (extract → reconcile → write-ahead → verify); the renderer
 * only triggers runs, displays the resulting diff, and routes adopt/discard.
 *
 * Anthropic-style design: each run produces a candidate file (memory.next.json)
 * that is never auto-promoted. The user reviews the structured diff and
 * decides to adopt (atomic rename onto memory.json) or discard.
 */

import type { Provider } from './models'

/** How far back to sample conversations for the dream. */
export type DreamScope = '24h' | '7d' | '30d' | 'all'

export const DREAM_SCOPES: readonly DreamScope[] = ['24h', '7d', '30d', 'all'] as const

/** Preference policy for picking a dream model when none is explicitly chosen. */
export type DreamPreferenceOrder = 'cheapest' | 'best'

export interface DreamRunRequest {
  /** Absolute path. Memory is per-workspace; cross-workspace dreams aren't supported. */
  workspaceRoot: string
  scope: DreamScope
  /** Override the preference order with a specific model id. */
  modelId?: string
  /** Used only when `modelId` is not set. Defaults to 'cheapest'. */
  preferenceOrder?: DreamPreferenceOrder
  /** Free-form steering hint that goes into stage 1's system prompt. */
  instructions?: string
}

/** Light-weight mirror of MemoryEntryKind so the renderer doesn't import main. */
export type MemoryEntryKindLite =
  | 'preference'
  | 'project-fact'
  | 'decision'
  | 'playbook'
  | 'caveat'
  | 'pattern'
  | 'legacy'

/** What the dreamer decided to do with a single entry. */
export type DreamDiffAction = 'add' | 'merge' | 'replace' | 'reject' | 'unchanged'

export interface DreamDiffEntry {
  action: DreamDiffAction
  entryId: string
  kind: MemoryEntryKindLite
  scope: 'workspace' | 'task'
  taskId?: string
  text: string
  /** Set when action ∈ {merge, replace} — the prior text being supplanted. */
  previousText?: string
  confidence: number
  evidenceCount: number
  /** Short rationale; empty when the action is self-explanatory. */
  reason?: string
}

/** What the hygiene stage decided to do with an existing entry. */
export type DreamHygieneAction = 'archive' | 'demote' | 'reinforce' | 'keep'

export interface DreamHygieneEntry {
  action: DreamHygieneAction
  entryId: string
  kind: MemoryEntryKindLite
  scope: 'workspace' | 'task'
  taskId?: string
  text: string
  /** Tighter wording proposed by hygiene; absent when text is unchanged. */
  previousText?: string
  confidence: number
  /** Set on demote/reinforce; the prior confidence value. */
  previousConfidence?: number
  reason?: string
}

export type DreamVerificationVerdict = 'supported' | 'unsupported' | 'partial'

export interface DreamVerification {
  entryId: string
  verdict: DreamVerificationVerdict
  reason?: string
}

export interface DreamDiffSummary {
  added: number
  merged: number
  replaced: number
  rejected: number
  unchanged: number
  /** Hygiene-stage counters; absent on older dream diffs. */
  archived?: number
  demoted?: number
  reinforced?: number
}

export type DreamAdoptionIssueCode =
  | 'low-confidence'
  | 'thin-evidence'
  | 'unsupported-verification'
  | 'partial-verification'

export interface DreamAdoptionIssue {
  code: DreamAdoptionIssueCode
  entryId: string
  message: string
}

export interface DreamAdoptionPolicy {
  /** False when every promotable row is strong enough to adopt as a batch. */
  blocked: boolean
  issues: DreamAdoptionIssue[]
}

export interface DreamDiff {
  id: string
  createdAt: number
  /** Provider model id (the actual id that ran the pipeline). */
  modelId: string
  modelProvider: Provider
  scope: DreamScope
  workspaceRoot: string
  summary: DreamDiffSummary
  verifications: DreamVerification[]
  entries: DreamDiffEntry[]
  /** Hygiene-stage decisions on EXISTING entries. Absent on older dream diffs. */
  hygiene?: DreamHygieneEntry[]
  adoption: DreamAdoptionPolicy
  /** True iff a memory.next.json exists on disk awaiting adoption. */
  awaitingAdopt: boolean
  /** Absolute path of the candidate file. UI uses this for display only. */
  candidateFilePath?: string
  /** Conversations the dream sampled (count only — full ids aren't surfaced). */
  sampledSessionCount: number
}

/** Who/what initiated the dream. Surfaces in history and progress events. */
export type DreamRunSource = 'manual' | 'auto'

/**
 * Per-row selection for partial adoption. Each array is a list of `entryId`
 * values from the corresponding side of `DreamDiff` (entries / hygiene)
 * that the user accepts. Omitted arrays mean "accept all" — so a missing
 * selection is identical to a full adopt.
 */
export interface DreamAdoptSelection {
  acceptedEntryIds?: readonly string[]
  acceptedHygieneIds?: readonly string[]
}

export type DreamRunResult =
  | {
      ok: true
      diff: DreamDiff
      /** True iff the auto-adopt path applied the candidate without user review. */
      autoAdopted?: boolean
    }
  | { ok: false; error: string; partial?: DreamDiff }

/**
 * Per-workspace knobs for automated dreaming. Defaults match Anthropic's
 * Auto Dream calibration (24h + 5 sessions, with a 10-minute scan throttle
 * and a "not during active chat" gate). Persisted to the workspace's
 * `.gladdis/dream-auto.json`.
 */
export interface DreamAutoConfig {
  /** Master switch. When false the scheduler is dormant. */
  enabled: boolean
  /** Minimum elapsed time since the last successful dream. */
  minHours: number
  /** Minimum number of new/updated conversations since the last dream. */
  minSessions: number
  /** Don't trigger if a user message arrived in the last N seconds. */
  activityCooldownSeconds: number
  /** Hard ceiling on automatic runs per UTC day. Manual runs don't count. */
  dailyRunCap: number
  /** "cheapest" or "best" — used when no explicit modelId is forced. */
  preferenceOrder: DreamPreferenceOrder
  /**
   * Adoption strictness for auto-runs:
   *   • strict     — auto-adopt only when the diff has no replace/reject rows
   *                  AND no unsupported/partial verifications AND policy is
   *                  not blocked (the safest case).
   *   • permissive — auto-adopt whenever `adoption.blocked === false`.
   *   • off        — never auto-adopt; always surface for manual review.
   * Hygiene-only changes (archive/demote/reinforce) always auto-adopt when
   * the strictness is anything other than 'off', because they're reversible
   * and bounded.
   */
  autoAdopt: 'strict' | 'permissive' | 'off'
}

export const DEFAULT_DREAM_AUTO_CONFIG: DreamAutoConfig = {
  enabled: false, // opt-in: never run without explicit consent
  minHours: 24,
  minSessions: 5,
  activityCooldownSeconds: 120,
  dailyRunCap: 4,
  preferenceOrder: 'cheapest',
  autoAdopt: 'strict'
}

/** Persisted shape of `.gladdis/dream-history.json`. */
export interface DreamHistoryFile {
  version: 1
  entries: DreamHistoryEntry[]
}

/**
 * One row in the rolling dream-history log. The history is append-only on
 * the writer side, capped to a fixed length, and written to
 * `.gladdis/dream-history.json` so the UI can surface a timeline without
 * the renderer having to re-parse old diff files.
 */
export interface DreamHistoryEntry {
  /** Same id as the corresponding DreamDiff. */
  id: string
  /** Epoch ms when the dream completed (or failed). */
  completedAt: number
  source: DreamRunSource
  scope: DreamScope
  modelId: string
  modelProvider: Provider
  ok: boolean
  /** Present when ok=false. */
  error?: string
  /** Present when ok=true. */
  summary?: DreamDiffSummary
  /** True iff the run auto-adopted (manual runs are always false here). */
  autoAdopted: boolean
  /** True iff the run produced a candidate currently awaiting user review. */
  awaitingReview: boolean
}

/** What auto-runs publish to the renderer as a one-shot notification. */
export interface DreamAutoNotification {
  runId: string
  workspaceRoot: string
  completedAt: number
  ok: boolean
  autoAdopted: boolean
  awaitingReview: boolean
  /** Lightweight one-line summary the UI can show as a toast. */
  message: string
  error?: string
}

/** Per-workspace counters the scheduler keeps; useful for the UI to render. */
export interface DreamAutoStatus {
  enabled: boolean
  config: DreamAutoConfig
  /** Last successful auto-dream timestamp (ms), if any. */
  lastDreamAt?: number
  /** Last failure timestamp (ms), if any. */
  lastFailureAt?: number
  /** Auto-runs initiated today (UTC day). */
  runsToday: number
  /** Sessions counted since last dream — derived from ChatStore.list(). */
  sessionsSinceLastDream: number
  /** Wallclock until the next gate clears (ms epoch), undefined if blocked. */
  nextEligibleAt?: number
  /** Reason the scheduler last skipped a check (debugging UI). */
  lastSkipReason?: string
}

export interface DreamAdoptResult {
  ok: boolean
  error?: string
  entryCount?: number
}

export interface DreamDiscardResult {
  ok: boolean
  error?: string
}

export interface DreamStatus {
  inFlight: boolean
  startedAt?: number
  scope?: DreamScope
  modelId?: string
}

/** Linear stages the user sees while a dream is in flight. */
export type DreamStage =
  | 'sampling'
  | 'extracting'
  | 'reconciling'
  | 'reviewing'
  | 'curating'
  | 'verifying'
  | 'persisting'

export const DREAM_STAGES: readonly DreamStage[] = [
  'sampling',
  'extracting',
  'reconciling',
  'reviewing',
  'curating',
  'verifying',
  'persisting'
] as const

/** Streamed main → renderer progress event. One conversation = one runId. */
export type DreamProgressEvent =
  | {
      type: 'started'
      runId: string
      workspaceRoot: string
      scope: DreamScope
      modelId: string
      modelProvider: Provider
    }
  | {
      type: 'stage'
      runId: string
      workspaceRoot: string
      stage: DreamStage
      /** Optional human-readable detail (e.g. "12 candidates → 9 add, 3 merge"). */
      detail?: string
    }
  | {
      type: 'done'
      runId: string
      workspaceRoot: string
      ok: boolean
      error?: string
    }
