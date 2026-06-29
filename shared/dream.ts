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
  /** True iff a memory.next.json exists on disk awaiting adoption. */
  awaitingAdopt: boolean
  /** Absolute path of the candidate file. UI uses this for display only. */
  candidateFilePath?: string
  /** Conversations the dream sampled (count only — full ids aren't surfaced). */
  sampledSessionCount: number
}

export type DreamRunResult =
  | { ok: true; diff: DreamDiff }
  | { ok: false; error: string; partial?: DreamDiff }

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
