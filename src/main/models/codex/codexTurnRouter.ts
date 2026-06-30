import type { ChatStreamEvent } from '../../../../shared/types'
import type { CodexAppServer } from './CodexAppServer'
import type { ThreadCompactor } from './ThreadCompactor'
import type {
  AgentMessageDeltaParams,
  ErrorParams,
  ItemLifecycleParams,
  JsonValue,
  ServerNotification,
  ServerRequest,
  ThreadItem,
  ThreadTokenUsage,
  TurnLifecycleParams
} from './protocol'
import { TOOL_ITEM_TYPES, codexToolName, isGladdisDynamicToolCall, toolArgs, toolOk, toolPreview } from './toolItems'
import { findCodexToolPolicyViolation } from './toolPolicy'
import { respondToCodexBrowserToolCall } from './dynamicBrowserTools'
import type { BrowserTools } from '../browserTools'

/** Mutable per-request turn state owned by CodexClient. */
export interface ActiveTurn {
  requestId: string
  conversationId: string | null
  /** The Codex model driving this turn — also used to plan any browse_task it invokes. */
  modelId: string
  threadId: string | null
  turnId: string | null
  done: () => void
  aborted: boolean
  /**
   * True when the user paused this turn via the composer's pause button.
   * Distinct from `aborted`: paused turns finish their app-server side
   * (via turn/interrupt) but the gladdis-side send() then waits on
   * `resumeResolver` instead of returning, so the conversation stays open
   * and the renderer keeps the assistant bubble live.
   */
  paused: boolean
  /** Context notes sent by the user while this Codex turn was running. */
  queuedUserContext: string[]
  /** One-click pause+apply should interrupt, attach context, then continue. */
  autoResumeAfterPause: boolean
  /**
   * Resolver wired up by CodexClient.send while it sits in the paused state.
   * Invoked by `resumeRequest` to wake the send() loop, which then kicks
   * off a fresh `turn/start` with a continuation prompt on the same thread.
   * Null whenever the turn is not waiting on a resume.
   */
  resumeResolver: (() => void) | null
  text: string
  silent: boolean
  error: Error | null
  toolItems: Map<string, { tool: string }>
  blockedItems: Set<string>
}

export interface NotificationContext {
  emit: (e: ChatStreamEvent) => void
  compactor: ThreadCompactor
  /** Resolves the live turn for a given threadId. */
  turnForThread: (threadId: string | undefined) => ActiveTurn | undefined
  /** Live server reference (so policy-blocks can interrupt the turn). */
  server: () => CodexAppServer | null
  /** Wall-clock (ms) of the previous tool-item end. Updated only when the
   *  GLADDIS_CODEX_DEBUG flag is on, so we can attribute reasoning gaps. */
  lastToolEndAt: { value: number }
}

export interface ServerRequestContext {
  emit: (e: ChatStreamEvent) => void
  server: () => CodexAppServer | null
  turnForThread: (threadId: string | undefined) => ActiveTurn | undefined
  browserTools: BrowserTools
  /** Re-runs a Codex turn with the active turn's model — used for browse_task planning. */
  completeWithModel: (modelId: string, system: string, user: string) => Promise<string>
}

/**
 * Translate one app-server notification into UI events on the active turn.
 * Pure dispatcher; mutates turn-local state but never reaches into the
 * client's other private fields.
 */
export function routeNotification(msg: ServerNotification, ctx: NotificationContext): void {
  const method = msg.method
  const params = msg.params as any
  if (method === 'thread/tokenUsage/updated' && params?.threadId && params?.tokenUsage) {
    ctx.compactor.record(params.threadId, params.tokenUsage as ThreadTokenUsage)
    return
  }
  if (method === 'thread/compacted' || method === 'turn/completed') {
    ctx.compactor.finish(params?.threadId)
  }
  const turn = ctx.turnForThread(params?.threadId)
  if (!turn) return

  switch (method) {
    case 'turn/started': {
      const p = params as TurnLifecycleParams
      turn.turnId = p.turn?.id ?? turn.turnId
      break
    }
    case 'item/agentMessage/delta': {
      const p = params as AgentMessageDeltaParams
      if (p.delta) {
        turn.text += p.delta
        if (!turn.silent) ctx.emit({ requestId: turn.requestId, type: 'delta', text: p.delta })
      }
      break
    }
    case 'item/started': {
      onItemStarted(turn, (params as ItemLifecycleParams).item, ctx)
      break
    }
    case 'item/completed': {
      onItemCompleted(turn, (params as ItemLifecycleParams).item, ctx)
      break
    }
    case 'turn/completed': {
      turn.done()
      break
    }
    case 'error': {
      const p = params as ErrorParams
      // The app-server sometimes sends an error notification with no top-level
      // `message`, only structured fields (code/type/data). Collapsing that to a
      // bare "Codex error" throws away the real cause, so fall back to whatever
      // detail the payload carries and always log the raw params for recovery.
      const detail = codexErrorDetail(p)
      console.error('[codex] error notification:', JSON.stringify(p))
      // Suppress error surfacing when the user intentionally aborted or paused
      // the turn — the app-server's "turn was interrupted" notification is a
      // benign side effect of our own turn/interrupt, not a real failure the
      // user needs to see. We also clear turn.error on pause so the send()
      // loop doesn't treat the next iteration as starting in an error state.
      if (turn.aborted || turn.paused) {
        turn.done()
        break
      }
      turn.error = new Error(detail)
      if (!turn.silent) {
        ctx.emit({
          requestId: turn.requestId,
          type: 'error',
          message: turn.error.message
        })
      }
      turn.done()
      break
    }
    default:
      break // ignore the many notifications gladdis doesn't surface
  }
}

/**
 * Best human-readable detail from a Codex error notification. Prefers an
 * explicit message, then common alternate fields, then a compact dump of the
 * remaining payload — anything but a bare "Codex error" that hides the cause.
 */
function codexErrorDetail(p: ErrorParams): string {
  const direct = firstString(p.message, p.error, p.reason, p.detail, p.description)
  if (direct) return direct
  const code = firstString(p.code, p.type)
  const rest = JSON.stringify(p)
  if (code) return rest !== '{}' ? `Codex error (${code}): ${rest}` : `Codex error (${code})`
  return rest !== '{}' ? `Codex error: ${rest}` : 'Codex error'
}

function firstString(...values: Array<JsonValue | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** A new ThreadItem began — surface tool-like ones as a running tool chip. */
function onItemStarted(turn: ActiveTurn, item: ThreadItem, ctx: NotificationContext): void {
  const type = item?.type
  if (!type || !TOOL_ITEM_TYPES.has(type)) return
  // gladdis.* browser tools chip via respondToCodexBrowserToolCall; don't double-chip.
  if (isGladdisDynamicToolCall(item)) return
  const violation = findCodexToolPolicyViolation(item)
  if (violation) {
    blockPolicyViolation(turn, item, violation, ctx)
    return
  }
  // Wall-clock the gap since the previous tool item finished — this is the
  // model-reasoning time *between* calls. Read alongside [codex-bridge] (the
  // gladdis-side per-call cost) to attribute the seconds-per-call lag: a
  // small bridge number + a large gap here means latency is reasoning, not
  // transport. Gated on GLADDIS_CODEX_DEBUG.
  if (process.env.GLADDIS_CODEX_DEBUG) {
    const now = Date.now()
    const since = ctx.lastToolEndAt.value
      ? `${now - ctx.lastToolEndAt.value}ms since prev tool`
      : 'first tool'
    console.log(`[codex-turn] ${codexToolName(item)} starting — ${since} (model reasoning gap)`)
  }
  turn.toolItems.set(item.id, { tool: codexToolName(item) })
  if (!turn.silent) {
    ctx.emit({
      requestId: turn.requestId,
      type: 'tool_call',
      tool: codexToolName(item),
      args: toolArgs(item),
      callId: item.id
    })
  }
}

/** A ThreadItem finished — close its tool chip, or render a final agentMessage. */
function onItemCompleted(turn: ActiveTurn, item: ThreadItem, ctx: NotificationContext): void {
  const type = item?.type
  if (turn.blockedItems.delete(item.id)) {
    turn.toolItems.delete(item.id)
    return
  }
  // gladdis.* browser tools are chipped by respondToCodexBrowserToolCall.
  if (isGladdisDynamicToolCall(item)) return
  if (type && TOOL_ITEM_TYPES.has(type)) {
    const ok = toolOk(item)
    if (!turn.silent) {
      ctx.emit({
        requestId: turn.requestId,
        type: 'tool_result',
        callId: item.id,
        ok,
        preview: toolPreview(item)
      })
    }
    turn.toolItems.delete(item.id)
    if (process.env.GLADDIS_CODEX_DEBUG) ctx.lastToolEndAt.value = Date.now()
  }
  // agentMessage text is already streamed via item/agentMessage/delta — we
  // don't re-emit it here (would duplicate). reasoning items aren't surfaced.
}

/**
 * Codex ran a native browser command we steer away from (per
 * `findCodexToolPolicyViolation`). We do NOT interrupt the turn: under
 * danger-full-access the command already executed by the time item/started
 * fires, so `turn/interrupt` can't un-run it — its only effect would be to
 * abort the user's turn as collateral. Codex sees the command's own (useless)
 * output and the guardrail chip below, then self-corrects to the gladdis
 * dynamic tools on its next step. The turn continues uninterrupted.
 */
function blockPolicyViolation(
  turn: ActiveTurn,
  item: ThreadItem,
  violation: { reason: string; guidance: string },
  ctx: NotificationContext
): void {
  const tool = 'gladdis_browser_guardrail'
  const command = (item as any).command
  turn.toolItems.set(item.id, { tool })
  // Record so onItemCompleted closes this chip instead of re-rendering it as a
  // normal command result.
  turn.blockedItems.add(item.id)
  if (!turn.silent) {
    ctx.emit({
      requestId: turn.requestId,
      type: 'tool_call',
      tool,
      args: { command, reason: violation.reason },
      callId: item.id
    })
    ctx.emit({
      requestId: turn.requestId,
      type: 'tool_result',
      callId: item.id,
      ok: true,
      preview: `Steered to gladdis browser tools. ${violation.reason} ${violation.guidance}`
    })
  }
}

/** Route a server-initiated request (tool calls, approvals) to the right handler. */
export async function routeServerRequest(msg: ServerRequest, ctx: ServerRequestContext): Promise<void> {
  const server = ctx.server()
  if (!server) return
  const method = msg.method
  if (method === 'item/tool/call') {
    await respondToBrowserTool(msg, ctx)
    return
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    server.respond(msg.id, { decision: 'accept' })
    return
  }
  // Unknown server request — respond with an empty object so we don't block the turn.
  server.respond(msg.id, {})
}

async function respondToBrowserTool(msg: ServerRequest, ctx: ServerRequestContext): Promise<void> {
  const server = ctx.server()
  if (!server) return
  const params = msg.params as { threadId?: unknown }
  const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined
  const turn = ctx.turnForThread(threadId)
  await respondToCodexBrowserToolCall({
    msg,
    respond: (id, result) => server.respond(id, result),
    tools: ctx.browserTools,
    // browse_task / pipeline planning runs on the SAME Codex model driving
    // this turn — the user's picked model does the work, no substitution.
    llm: turn ? (system, user) => ctx.completeWithModel(turn.modelId, system, user) : null,
    conversationId: turn?.conversationId ?? null,
    requestId: turn && !turn.silent ? turn.requestId : undefined,
    emit: ctx.emit
  })
}
