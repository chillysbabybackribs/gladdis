import type { ContractTrace } from '../../../shared/types'

export interface ToolActivity {
  callId: string
  tool: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  startedAt?: number
  endedAt?: number
  durationMs?: number
  preview?: string
}

/**
 * One ordered fragment of an assistant turn. The agent loop interleaves prose
 * and tool calls, so a turn is stored as a sequence of parts in arrival order.
 */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolActivity }
  | { kind: 'contract'; trace: ContractTrace }

export interface Message {
  /** Stable id for routing live stream events to the assistant turn they belong to. */
  id?: string
  role: 'user' | 'assistant'
  /** Flattened text of the turn, kept in sync with `parts` for persistence. */
  text: string
  /** Optional context line shown under a user message (the attached page). */
  meta?: string
  /** Ordered prose/tool fragments for an assistant turn (live + new saves). */
  parts?: Part[]
  /** Legacy: tool calls of a turn, used to render pre-`parts` saved chats. */
  tools?: ToolActivity[]
  images?: string[]
}
