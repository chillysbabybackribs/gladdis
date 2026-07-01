import Anthropic from '@anthropic-ai/sdk'
import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import type { LlmComplete } from '../llm'
import type { BrowserTools, ToolContext, ToolDef } from '../browserTools'
import {
  continueAfterToolCalls,
  createToolValidationState,
  type SupervisorTransition,
} from './toolValidation'
import { executeProviderToolCall, handleProviderTurnWithoutToolCalls } from './loopCore'
import { withDateContext } from './dateContext'
import { estimatePromptInputChars } from './promptAuditCache'
import { toAnthropicTools } from './toolPromptCache'

type FinishUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
type ActiveAuditCall = {
  addOutput: (chunk: unknown) => void
  finish: (result?: { output?: unknown; status?: 'ok' | 'error'; error?: unknown; usage?: FinishUsage }) => void
}
type ModelAudit = {
  begin: (call: {
    requestId?: string
    conversationId?: string | null
    provider: 'anthropic'
    modelId: string
    stage: string
    input: unknown
    inputChars?: number
  }) => ActiveAuditCall
}

// Stub prefix for old tool results
const STUB_PREFIX = '[trimmed]'

// Note: VERBATIM_TOOL_RESULTS in providerRouting.ts controls how many results stay verbatim.
// Consider increasing from 4 to 8 for better model context on long tasks.

export function textFromAnthropicContent(content: any[]): string {
  return (content ?? []).map((b) => (b?.type === 'text' ? b.text : '')).join('')
}

export function usageFromAnthropic(usage: any): FinishUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.inputTokens === 'number'
        ? usage.inputTokens
        : undefined
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.outputTokens === 'number'
        ? usage.outputTokens
        : undefined
  // Cached input = tokens read from the prompt cache plus tokens written to it
  // this turn (both are part of the input the model processed).
  const cacheRead =
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? undefined
  const cacheCreation =
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? undefined
  const cachedInputTokens =
    typeof cacheRead === 'number' || typeof cacheCreation === 'number'
      ? (cacheRead ?? 0) + (cacheCreation ?? 0)
      : undefined
  return inputTokens == null && outputTokens == null && cachedInputTokens == null
    ? undefined
    : { inputTokens, outputTokens, cachedInputTokens }
}

export async function titleAnthropic(args: {
  client: Anthropic
  audit: ModelAudit
  modelId: string
  prompt: string
}): Promise<string> {
  const call = args.audit.begin({
    provider: 'anthropic',
    modelId: args.modelId,
    stage: 'title',
    input: args.prompt
  })
  try {
    const res = await args.client.messages.create({
      model: args.modelId,
      max_tokens: 24,
      messages: [{ role: 'user', content: args.prompt }]
    })
    const text = textFromAnthropicContent(res.content)
    call.finish({ output: text, usage: usageFromAnthropic(res.usage) })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function completeAnthropic(args: {
  client: Anthropic
  audit: ModelAudit
  modelId: string
  system: string
  user: string
  maxOutputTokens: number
  stage: string
}): Promise<string> {
  const call = args.audit.begin({
    provider: 'anthropic',
    modelId: args.modelId,
    stage: args.stage,
    input: { system: args.system, user: args.user }
  })
  try {
    const res = await args.client.messages.create({
      model: args.modelId,
      max_tokens: args.maxOutputTokens,
      system: args.system,
      messages: [{ role: 'user', content: args.user }]
    })
    const text = textFromAnthropicContent(res.content)
    call.finish({ output: text, usage: usageFromAnthropic(res.usage) })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

/**
 * Place Anthropic prompt-cache breakpoints for a growing multi-turn tool loop.
 *
 * The naive approach — strip every `cache_control` and drop a single marker on
 * the new last message each turn — moves the breakpoint forward every iteration.
 * A breakpoint only walks back 20 content blocks to find a prior cache entry, so
 * in a tool loop that appends an assistant turn + a user turn of tool_results per
 * iteration, the marker routinely lands >20 blocks past the previous one and
 * silently misses — re-billing the ENTIRE history at full input price every turn.
 *
 * Instead we keep TWO rolling breakpoints (Anthropic allows 4 total; two sit on
 * the system blocks): a STABLE anchor on the previous turn's tail and a MOVING
 * one on the newest tail. The anchor keeps the just-grown prefix readable while
 * the moving marker extends the cached region, so each turn reads the whole prior
 * conversation at cache-read (~0.1x) rates and only pays full price for the delta.
 * This only works because the history bytes before the anchor never change —
 * `stubOldResults` no longer rewrites already-sent results (see its docstring).
 *
 * `lastUserBreakpointIndex` from the previous call tells us where the anchor
 * should sit this turn; the function returns the new moving-breakpoint index to
 * thread back in.
 */
function markLastBlock(msg: Anthropic.MessageParam): void {
  if (typeof msg.content === 'string') {
    msg.content = [
      { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } } as any
    ]
  } else if (Array.isArray(msg.content)) {
    const lastBlock = msg.content[msg.content.length - 1]
    if (lastBlock && typeof lastBlock === 'object') {
      (lastBlock as any).cache_control = { type: 'ephemeral' }
    }
  }
}

export function applyRollingCache(
  messages: Anthropic.MessageParam[],
  prevBreakpointIndex: number | null
): number | null {
  // Strip existing message-level cache_control so we re-place exactly two markers
  // (the system blocks carry their own, placed once at loop setup).
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'cache_control' in block) {
          delete (block as any).cache_control
        }
      }
    }
  }

  // Moving breakpoint: the current last message.
  const lastIndex = messages.length - 1
  if (lastIndex < 0) return null
  markLastBlock(messages[lastIndex])

  // Stable anchor: the message that was the moving breakpoint last turn. Keeping
  // it marked lets this turn's request read the prefix the previous turn cached,
  // even when the new tail is >20 blocks further along.
  if (
    prevBreakpointIndex != null &&
    prevBreakpointIndex < lastIndex &&
    prevBreakpointIndex >= 0 &&
    messages[prevBreakpointIndex]
  ) {
    markLastBlock(messages[prevBreakpointIndex])
  }

  return lastIndex
}

export async function streamAnthropicPlain(args: {
  client: Anthropic
  audit: ModelAudit
  emit: (e: ChatStreamEvent) => void
  req: ChatRequest
  modelId: string
  signal: AbortSignal
  system: string
  maxTokens: number
}): Promise<void> {
  const messages = toAnthropicMessages(args.req)
  applyRollingCache(messages, null)

  const systemParam: Anthropic.MessageCreateParams['system'] = [
    { type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }
  ]

  const call = args.audit.begin({
    requestId: args.req.requestId,
    conversationId: args.req.conversationId,
    provider: 'anthropic',
    modelId: args.modelId,
    stage: 'chat:plain',
    input: { system: args.system, messages }
  })
  try {
    const stream = args.client.messages.stream(
      {
        model: args.modelId,
        max_tokens: args.maxTokens,
        system: systemParam,
        messages
      },
      { signal: args.signal }
    )
    stream.on('text', (text) => {
      call.addOutput(text)
      args.emit({ requestId: args.req.requestId, type: 'delta', text })
    })
    const final = await stream.finalMessage()
    call.finish({
      output: textFromAnthropicContent(final.content),
      usage: usageFromAnthropic(final.usage)
    })
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function runAnthropicToolLoop(args: {
  client: Anthropic
  audit: ModelAudit
  emit: (e: ChatStreamEvent) => void
  req: ChatRequest
  modelId: string
  signal: AbortSignal
  browserLlm?: LlmComplete
  tools: BrowserTools
  ctx: ToolContext
  toolDefs: ToolDef[]
  agentSystem: string
  workspaceBlock: string | null
  maxTokens: number
  keepResults: number
  supervisor?: {
    iterationStarted: (iteration: number) => void
    transition: (iteration: number, transition: SupervisorTransition) => void
  }
  /** Holds the loop at the iteration boundary while the user has paused the turn. */
  waitWhilePaused?: (signal: AbortSignal) => Promise<void>
  /** Returns one queued user note to apply before the next model step. */
  getQueuedContext?: () => string | null
}): Promise<void> {
  const system: Anthropic.MessageCreateParams['system'] = [
    { type: 'text', text: args.agentSystem, cache_control: { type: 'ephemeral' } }
  ]
  if (args.workspaceBlock) {
    system.push({ type: 'text', text: args.workspaceBlock, cache_control: { type: 'ephemeral' } })
  }

  // The full tool surface is fixed for the whole turn (no profile escalation),
  // so the tool list is built once. The cache_control marker sits on the last
  // tool, so the prompt cache stays stable across the turn.
  const anthropicTools = toAnthropicTools(args.toolDefs) as Anthropic.MessageCreateParams['tools']

  const messages = toAnthropicMessages(args.req)
  const resultBlocks: Anthropic.ToolResultBlockParam[] = []
  const validation = createToolValidationState()
  // Index of last turn's cache breakpoint, so this turn can keep it as a stable
  // anchor (see applyRollingCache). null on the first iteration.
  let prevBreakpointIndex: number | null = null

  for (let turn = 0; !args.signal.aborted; turn++) {
    // Pause is honored at the iteration boundary so the model state stays
    // coherent — pausing mid-stream would drop tokens and look like a stop.
    if (args.waitWhilePaused) await args.waitWhilePaused(args.signal)
    if (args.signal.aborted) return
    const queuedContext = args.getQueuedContext?.()
    if (queuedContext) messages.push({ role: 'user', content: queuedContext })
    args.ctx.iteration = turn + 1
    args.supervisor?.iterationStarted(turn + 1)
    prevBreakpointIndex = applyRollingCache(messages, prevBreakpointIndex)
    const inputChars = estimatePromptInputChars({
      system: args.agentSystem,
      tools: anthropicTools,
      dynamic: messages
    })
    // Rough tokens ≈ chars / 4; used only to decide when context pressure is high
    // enough to justify stubbing (which trades a cache hit for a smaller prompt).
    const estimatedInputTokens = Math.ceil(inputChars / 4)
    const call = args.audit.begin({
      requestId: args.req.requestId,
      conversationId: args.req.conversationId,
      provider: 'anthropic',
      modelId: args.modelId,
      stage: `chat:browser:${turn}`,
      input: { system: args.agentSystem, tools: anthropicTools, messages },
      inputChars
    })
    let final: any
    try {
      const stream = args.client.messages.stream(
        {
          model: args.modelId,
          max_tokens: args.maxTokens,
          system,
          tools: anthropicTools,
          messages
        },
        { signal: args.signal }
      )
      stream.on('text', (text) => {
        call.addOutput(text)
        args.emit({ requestId: args.req.requestId, type: 'delta', text })
      })
      final = await stream.finalMessage()
      call.finish({
        output: textFromAnthropicContent(final.content),
        usage: usageFromAnthropic(final.usage)
      })
    } catch (err) {
      call.finish({ status: 'error', error: err })
      throw err
    }

    messages.push({ role: 'assistant', content: final.content })

    const toolUses = final.content.filter(
      (b: any): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )
    if (toolUses.length === 0) {
      const result = await handleProviderTurnWithoutToolCalls({
        state: validation,
        toolDefs: args.toolDefs,
        turn,
        requestId: args.req.requestId,
        runTool: (name, toolArgs) => args.tools.run(name, toolArgs, args.ctx),
        emitToolCall: args.emit,
        emitToolResult: args.emit,
        rememberFullResult: (callId, text) => args.ctx.fullResults!.set(callId, text),
        transition: (iteration, transition) => args.supervisor?.transition(iteration, transition),
        appendRetryPrompt: (prompt) => messages.push({ role: 'user', content: prompt }),
        emitWarningDelta: (warningDelta) =>
          args.emit({ requestId: args.req.requestId, type: 'delta', text: warningDelta })
      })
      if (result === 'continue') continue
      return
    }

    // Stub old tool results ONLY under real context pressure — not every turn.
    // Stubbing rewrites already-sent bytes, which invalidates the prompt cache
    // from that point forward; doing it each iteration (the old behavior) meant
    // the growing history never cached. Left verbatim, those results ride along
    // at cache-read (~0.1x) rates instead. When we do approach the window, stub
    // oldest-first as a backstop; recall_history still recovers the full text.
    maybeStubUnderContextPressure(resultBlocks, args.keepResults, estimatedInputTokens)

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      if (args.signal.aborted) return
      const { outcome } = await executeProviderToolCall({
        requestId: args.req.requestId,
        callId: tu.id,
        name: tu.name,
        toolArgs: (tu.input ?? {}) as Record<string, any>,
        runTool: (toolName, toolArgs) => args.tools.run(toolName, toolArgs, args.ctx),
        emitToolCall: args.emit,
        emitToolResult: args.emit,
        rememberFullResult: (toolCallId, text) => args.ctx.fullResults!.set(toolCallId, text),
        validationState: validation
      })

      const content: Anthropic.ToolResultBlockParam['content'] = outcome.imageBase64
        ? [
            { type: 'text', text: outcome.text },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: outcome.imageBase64 }
            }
          ]
        : outcome.text
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: tu.id,
        content,
        is_error: !outcome.ok
      }
      results.push(block)
      resultBlocks.push(block)
    }
    messages.push({ role: 'user', content: results })
    args.supervisor?.transition(turn + 1, continueAfterToolCalls(toolUses.length))
  }
}

/**
 * Context-window backstop: only stub old tool results once the estimated prompt
 * is large enough that carrying them verbatim risks the context limit. Below the
 * threshold we leave everything in place so the prompt cache keeps hitting.
 *
 * Opus/Sonnet expose a 1M-token window; we start relieving pressure well before
 * that so a marathon browser session can't overflow. `stubOldResults` is a no-op
 * on already-stubbed blocks, so once a block is stubbed it stays byte-stable.
 */
const CONTEXT_STUB_THRESHOLD_TOKENS = 300_000  // Lowered from 700k for more aggressive stubbing

export function maybeStubUnderContextPressure(
  blocks: Anthropic.ToolResultBlockParam[],
  keep: number,
  estimatedInputTokens: number
): void {
  if (estimatedInputTokens < CONTEXT_STUB_THRESHOLD_TOKENS) return
  stubOldResults(blocks, keep)
}

/**
 * Collapse all but the last `keep` Anthropic tool_result blocks to a short
 * stub, in place. The full result stays retrievable via recall_history using
 * the block's tool_use_id, so trimming the live window doesn't lose anything.
 * Idempotent: an already-stubbed block is skipped, keeping its bytes stable.
 */
export function stubOldResults(blocks: Anthropic.ToolResultBlockParam[], keep: number): void {
  const cutoff = blocks.length - keep
  for (let i = 0; i < cutoff; i++) {
    const b = blocks[i]
    if (typeof b.content === 'string' && b.content.startsWith(STUB_PREFIX)) continue
    b.content = `${STUB_PREFIX} (id ${b.tool_use_id}) — earlier result trimmed to save tokens. Call recall_history with tool_call_id "${b.tool_use_id}" to read it in full.`
  }
}

function toAnthropicMessages(req: ChatRequest): Anthropic.MessageParam[] {
  const messages = withDateContext(req.messages)
  const IMAGE_HISTORY_RETENTION = 2  // Keep images from last N turns only

  return messages.map((m, idx) => {
    // Only keep images in recent messages; strip from older turns to save context
    const isRecentMessage = (messages.length - idx) <= IMAGE_HISTORY_RETENTION

    if (m.images && m.images.length > 0 && !isRecentMessage) {
      // Strip images from old messages, but keep the text content
      return { role: m.role, content: m.content || '(screenshot from earlier turn; text preserved)' }
    }

    if (m.images && m.images.length > 0) {
      const content: Anthropic.ContentBlockParam[] = [
        { type: 'text', text: m.content || 'Attached screenshot:' }
      ]
      for (const img of m.images) {
        const match = img.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          const [, media_type, data] = match
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: media_type as any,
              data
            }
          })
        } else {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: img
            }
          })
        }
      }
      return { role: m.role, content }
    }
    return { role: m.role, content: m.content }
  })
}
