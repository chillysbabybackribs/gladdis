/**
 * Typed memory schema (v2) — foundation for the cross-provider Dreaming
 * pipeline. The live read/write surface today is the `memory_*` tools which
 * still speak in (scope, key, value); those calls land here as `MemoryEntry`
 * records with `key`/`value` preserved for round-trip, so the tool API stays
 * unchanged in Phase 0. The dreamer (Phase 1+) treats `kind` + `text` +
 * `evidence` as canonical and may rewrite `key`/`value` away over time.
 */

/**
 * Categorization the dreamer reasons about. Migrated v1 entries use `legacy`
 * until they're reconciled into a real kind; everything written via the
 * existing memory tools defaults to `project-fact` (workspace) or `playbook`
 * (task) when no better signal is available.
 */
export type MemoryEntryKind =
  | 'preference'    // long-lived user/team preference (e.g. "prefer TS over JS")
  | 'project-fact'  // medium-lived project state (e.g. "build = electron-vite 5")
  | 'decision'      // an explicit choice made in conversation
  | 'playbook'      // procedural knowledge — "to do X, do A then B"
  | 'caveat'        // a known pitfall or anti-pattern
  | 'pattern'       // recurring observation across multiple sessions
  | 'legacy'        // migrated from v1 with no clean classification

export type MemoryScope = 'workspace' | 'task'

export interface MemoryEvidence {
  conversationId: string
  messageIndex?: number
  turnExcerpt?: string
  toolCallId?: string
}

export interface MemoryFreshness {
  createdAt: string
  lastReinforcedAt: string
  lastReferencedAt?: string
  contradictsId?: string
  /**
   * Set by the dreamer's hygiene stage when an entry is retired. The entry
   * stays in the file (for audit / "show retired" tooling) but is hidden from
   * `memory_read` by default. Adopting a dream is the only way an entry gets
   * archived; never set by the live `memory_*` tools.
   */
  archivedAt?: string
  /** Short reason captured at archive time, surfaced in the diff UI. */
  archivedReason?: string
}

export interface MemoryEntry {
  id: string
  kind: MemoryEntryKind
  scope: MemoryScope
  workspaceRoot: string
  taskId?: string
  /**
   * Backward-compat with the v1 `memory_*` tool surface. The model writes
   * `memory_write({ scope, key, value })`; we keep both fields so reads
   * issued via the existing tools can return the original payload verbatim,
   * while the dreamer reasons over the canonical `text` form.
   */
  key?: string
  value?: unknown
  /** Canonical one-sentence statement. Phase 0 derives this from `key`/`value`. */
  text: string
  /**
   * Provenance pointers. Required (min length 1) for entries created by the
   * dreamer; allowed to be empty for migrated v1 entries and for direct
   * model writes that lack a conversation context (with `tags` recording why).
   */
  evidence: MemoryEvidence[]
  /** 0..1. Migrated entries land at 0.4; explicit model writes at 0.7. */
  confidence: number
  freshness: MemoryFreshness
  tags: string[]
}

export interface MemoryTaskRecord {
  id: string
  label?: string
  createdAt: string
  updatedAt: string
}

export interface MemoryFileV2 {
  version: 2
  workspace: {
    root: string
    updatedAt: string
  }
  entries: MemoryEntry[]
  tasks: Record<string, MemoryTaskRecord>
  /**
   * Audit trail of what the v1 → v2 migration discarded. Useful for surfacing
   * "we dropped N stale notes" in the eventual dream UI, and for debugging
   * complaints about missing data after the first migration.
   */
  legacyDropped?: Array<{ key: string; reason: string }>
}

export const MEMORY_FILE_VERSION = 2 as const

export function emptyMemoryFile(workspaceRoot: string): MemoryFileV2 {
  return {
    version: MEMORY_FILE_VERSION,
    workspace: { root: workspaceRoot, updatedAt: new Date().toISOString() },
    entries: [],
    tasks: {}
  }
}
