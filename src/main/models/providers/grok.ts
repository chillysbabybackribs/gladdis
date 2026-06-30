import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import type { LlmComplete } from '../../pipeline/Planner'
import type { BrowserTools, ToolContext, ToolDef } from '../browserTools'
import { resolveTurnTools } from '../agentTools'
import {
  continueAfterToolCalls,
  createToolValidationState,
  noteToolOutcome,
  type SupervisorTransition,
} from './toolValidation'
import { executeProviderToolCall, handleProviderTurnWithoutToolCalls } from './loopCore'
import { withDateContext } from './dateContext'
import { fetchWithRetry } from './retry'
import { approxInputChars } from '../ModelCallLedger'
import { summarizeTrimmedToolResult } from './toolResultSummary'

// xAI exposes an OpenAI-compatible Chat Completions API. We talk to it with
// plain fetch + SSE — no SDK — matching the repo's existing OpenAI-compatible
// call in tts.ts and keeping package.json dependency-free for this provider.
const GROK_BASE_URL = process.env.XAI_BASE_URL || 'https://api.x.ai/v1'
const CHAT_COMPLETIONS_URL = `${GROK_BASE_URL}/chat/completions`

type GrokReasoningEffort = 'none' | 'low' | 'medium' | 'high'
type FinishUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}
type ActiveAuditCall = {
  addOutput: (chunk: unknown) => void
  finish: (result?: { output?: unknown; status?: 'ok' | 'error'; error?: unknown; usage?: FinishUsage }) => void
}
type ModelAudit = {
  begin: (call: {
    requestId?: string
    conversationId?: string | null
    provider: 'grok'
    modelId: string
    stage: string
    input: unknown
    inputChars?: number
  }) => ActiveAuditCall
}

const STUB_PREFIX = '[trimmed]'

/**
 * Context compaction optimization (per xAI official docs).
 * For long conversations / agent loops, we produce compact reusable summaries
 * instead of shipping the full history. This mirrors the "opaque compaction"
 * feature and helps maximize cachedInputTokens + stay under context limits.
 * See: https://docs.x.ai/developers/advanced-api-usage/context-compaction
 */
export interface HistoryCompactionOptions {
  maxMessages?: number
  keepTail?: number
  maxChars?: number
}

function compactHistoryForGrok(messages: OpenAiMessage[], opts: HistoryCompactionOptions = {}): OpenAiMessage[] {
  const maxChars = opts.maxChars ?? 24_000
  if (messages.length <= 6) return messages // short convos need no compaction

  const totalLen = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0)
  if (totalLen <= maxChars) return messages

  // Keep system + most recent 3 turns; replace earlier user/assistant pairs with a single compacted marker
  const system = messages.find(m => m.role === 'system')
  const recent = messages.slice(-6)
  const compacted = {
    role: 'user' as const,
    content: `${STUB_PREFIX} Earlier conversation compacted into reusable summary (see recall_history).`
  }
  return system ? [system, compacted, ...recent] : [compacted, ...recent]
}

/* ----------------------------- OpenAI wire types ----------------------------- */
// Only the fields we send/read. The API returns more; we ignore the rest.

interface OpenAiTextPart {
  type: 'text'
  text: string
}
interface OpenAiImagePart {
  type: 'image_url'
  image_url: { url: string }
}
type OpenAiContent = string | (OpenAiTextPart | OpenAiImagePart)[]

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: OpenAiContent | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

/* ------------------------------- usage helper -------------------------------- */

export function usageFromGrok(usage: any): FinishUsage | undefined {
  if (!usage) return undefined
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const cachedInputTokens =
    typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : typeof usage.input_tokens_details?.cached_tokens === 'number'
        ? usage.input_tokens_details.cached_tokens
        : undefined
  const reasoningOutputTokens =
    typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
      ? usage.completion_tokens_details.reasoning_tokens
      : typeof usage.output_tokens_details?.reasoning_tokens === 'number'
        ? usage.output_tokens_details.reasoning_tokens
        : undefined
  return inputTokens == null &&
    outputTokens == null &&
    cachedInputTokens == null &&
    reasoningOutputTokens == null
    ? undefined
    : { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens }
}

/* --------------------------------- requests ---------------------------------- */

interface GrokFetchArgs {
  apiKey: string
  body: Record<string, unknown>
  signal?: AbortSignal
  conversationId?: string | null
}

function grokHeaders(apiKey: string, conversationId?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
  if (conversationId) headers['x-grok-conv-id'] = conversationId
  return headers
}

function grokBody(args: {
  modelId: string
  stage: string
  body: Record<string, unknown>
}): Record<string, unknown> {
  const effort = grokReasoningEffort(args.modelId, args.stage)
  return effort ? { ...args.body, reasoning_effort: effort } : args.body
}

function grokReasoningEffort(modelId: string, stage: string): GrokReasoningEffort | undefined {
  if (!/^grok-4\.3(?:$|-|_)/.test(modelId) && modelId !== 'grok-4.3-latest' && modelId !== 'grok-latest') return undefined
  // Hardest reasoning in the system — planning and re-planning a multi-step task.
  // Let Grok use its native high tier here instead of pinning it to medium.
  if (/\b(plan|planner|replan|debug|review|refactor|code|coding)\b/i.test(stage)) return 'high'
  // Agentic execution and final synthesis: real work, but not the deep planning step.
  if (stage.startsWith('chat:browser') || stage === 'complete' || stage === 'pipeline:final') return 'medium'
  // Lightweight turns: plain chat, titles, anything else.
  return 'low'
}

/** One non-streaming chat completion. Throws on a non-2xx response. */
async function grokFetchJson(args: GrokFetchArgs): Promise<any> {
  const res = await fetchWithRetry(
    CHAT_COMPLETIONS_URL,
    {
      method: 'POST',
      headers: grokHeaders(args.apiKey, args.conversationId),
      body: JSON.stringify({ ...args.body, stream: false }),
      signal: args.signal
    },
    { signal: args.signal }
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`xAI request failed (${res.status}): ${detail.slice(0, 500)}`)
  }
  return res.json()
}

export async function titleGrok(args: {
  apiKey: string
  audit: ModelAudit
  modelId: string
  prompt: string
}): Promise<string> {
  const call = args.audit.begin({
    provider: 'grok',
    modelId: args.modelId,
    stage: 'title',
    input: args.prompt
  })
  try {
    const json = await grokFetchJson({
      apiKey: args.apiKey,
      body: {
        model: args.modelId,
        max_tokens: 24,
        messages: [{ role: 'user', content: args.prompt }]
      }
    })
    const text = json.choices?.[0]?.message?.content ?? ''
    call.finish({ output: text, usage: usageFromGrok(json.usage) })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function completeGrok(args: {
  apiKey: string
  audit: ModelAudit
  modelId: string
  system: string
  user: string
  maxOutputTokens: number
  stage: string
  conversationId?: string | null
}): Promise<string> {
  const call = args.audit.begin({
    provider: 'grok',
    modelId: args.modelId,
    stage: args.stage,
    input: { system: args.system, user: args.user }
  })
  try {
    const json = await grokFetchJson({
      apiKey: args.apiKey,
      conversationId: args.conversationId,
      body: {
        ...grokBody({
          modelId: args.modelId,
          stage: args.stage,
          body: {
            model: args.modelId,
            max_tokens: args.maxOutputTokens,
            messages: [
              { role: 'system', content: args.system },
              { role: 'user', content: args.user }
            ]
          }
        })
      }
    })
    const text = json.choices?.[0]?.message?.content ?? ''
    call.finish({ output: text, usage: usageFromGrok(json.usage) })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

/* --------------------------------- streaming --------------------------------- */

/** Accumulated streamed assistant message: text deltas + tool-call deltas. */
interface StreamedTurn {
  text: string
  toolCalls: OpenAiToolCall[]
  usage?: FinishUsage
}

/**
 * Stream a chat completion over SSE, calling onText for each text delta. Returns
 * the assembled assistant turn (text + any tool calls). OpenAI streams tool calls
 * as fragments keyed by `index`, so we reassemble name + arguments by index.
 */
async function streamGrokChat(args: {
  apiKey: string
  body: Record<string, unknown>
  signal: AbortSignal
  onText: (text: string) => void
  conversationId?: string | null
}): Promise<StreamedTurn> {
  const res = await fetchWithRetry(
    CHAT_COMPLETIONS_URL,
    {
      method: 'POST',
      headers: grokHeaders(args.apiKey, args.conversationId),
      body: JSON.stringify({ ...args.body, stream: true, stream_options: { include_usage: true } }),
      signal: args.signal
    },
    { signal: args.signal }
  )
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`xAI stream failed (${res.status}): ${detail.slice(0, 500)}`)
  }

  const turn: StreamedTurn = { text: '', toolCalls: [] }
  const toolByIndex = new Map<number, OpenAiToolCall>()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (args.signal.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; each line is `data: <json>`.
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let evt: any
        try {
          evt = JSON.parse(payload)
        } catch {
          continue
        }
        if (evt.usage) turn.usage = usageFromGrok(evt.usage)
        const delta = evt.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.content === 'string' && delta.content) {
          turn.text += delta.content
          args.onText(delta.content)
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0
          let acc = toolByIndex.get(idx)
          if (!acc) {
            acc = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } }
            toolByIndex.set(idx, acc)
          }
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.function.name += tc.function.name
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  turn.toolCalls = [...toolByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  return turn
}

export async function streamGrokPlain(args: {
  apiKey: string
  audit: ModelAudit
  emit: (e: ChatStreamEvent) => void
  req: ChatRequest
  modelId: string
  signal: AbortSignal
  system: string
  maxTokens: number
}): Promise<void> {
  let messages: OpenAiMessage[] = [
    { role: 'system', content: args.system },
    ...toGrokMessages(args.req)
  ]
  messages = compactHistoryForGrok(messages)
  const call = args.audit.begin({
    requestId: args.req.requestId,
    conversationId: args.req.conversationId,
    provider: 'grok',
    modelId: args.modelId,
    stage: 'chat:plain',
    input: { system: args.system, messages }
  })
  try {
    const turn = await streamGrokChat({
      apiKey: args.apiKey,
      signal: args.signal,
      conversationId: args.req.conversationId,
      body: grokBody({
        modelId: args.modelId,
        stage: 'chat:plain',
        body: { model: args.modelId, max_tokens: args.maxTokens, messages }
      }),
      onText: (text) => {
        call.addOutput(text)
        args.emit({ requestId: args.req.requestId, type: 'delta', text })
      }
    })
    call.finish({ output: turn.text, usage: turn.usage })
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function runGrokToolLoop(args: {
  apiKey: string
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
  // OpenAI tools take a JSON Schema directly, which is exactly what ToolDef.parameters
  // already is — no per-field type mapping needed (unlike the Gemini adapter).
  // Rebuilt each step because request_tools can grow the granted set mid-turn.
  const buildTools = () =>
    resolveTurnTools(args.toolDefs, args.ctx.grantedTools).map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  let tools = buildTools()

  const systemText = args.workspaceBlock
    ? `${args.agentSystem}\n\n${args.workspaceBlock}`
    : args.agentSystem
  let messages: OpenAiMessage[] = [{ role: 'system', content: systemText }, ...toGrokMessages(args.req)]
  messages = compactHistoryForGrok(messages)
  // Tool result messages, tracked so old ones can be stubbed to save tokens.
  const resultMsgs: OpenAiMessage[] = []
  const validation = createToolValidationState()

  for (let turn = 0; !args.signal.aborted; turn++) {
    // Pause is honored at the iteration boundary so the model state stays
    // coherent — pausing mid-stream would drop tokens and look like a stop.
    if (args.waitWhilePaused) await args.waitWhilePaused(args.signal)
    if (args.signal.aborted) return
    const queuedContext = args.getQueuedContext?.()
    if (queuedContext) messages.push({ role: 'user', content: queuedContext })
    args.ctx.iteration = turn + 1
    args.supervisor?.iterationStarted(turn + 1)
    tools = buildTools() // pick up any tools granted via request_tools last step
    const call = args.audit.begin({
      requestId: args.req.requestId,
      conversationId: args.req.conversationId,
      provider: 'grok',
      modelId: args.modelId,
      stage: `chat:browser:${turn}`,
      input: { system: systemText, tools, messages },
      inputChars: approxInputChars({ system: systemText, tools, messages })
    })
    let assistant: StreamedTurn
    try {
      assistant = await streamGrokChat({
        apiKey: args.apiKey,
        signal: args.signal,
        conversationId: args.req.conversationId,
        body: grokBody({
          modelId: args.modelId,
          stage: `chat:browser:${turn}`,
          body: { model: args.modelId, max_tokens: args.maxTokens, messages, tools }
        }),
        onText: (text) => {
          call.addOutput(text)
          args.emit({ requestId: args.req.requestId, type: 'delta', text })
        }
      })
      call.finish({ output: assistant.text, usage: assistant.usage })
    } catch (err) {
      call.finish({ status: 'error', error: err })
      throw err
    }

    messages.push({
      role: 'assistant',
      content: assistant.text || null,
      ...(assistant.toolCalls.length ? { tool_calls: assistant.toolCalls } : {})
    })

    if (assistant.toolCalls.length === 0) {
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

    stubOldGrokResults(resultMsgs, args.keepResults)

    const toolPromises = assistant.toolCalls.map(async (tc) => {
      if (args.signal.aborted) return null
      const name = tc.function.name
      const callId = tc.id
      let parsedArgs: Record<string, any> = {}
      try {
        parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
      } catch {
        parsedArgs = {}
      }
      const { outcome } = await executeProviderToolCall({
        requestId: args.req.requestId,
        callId,
        name,
        toolArgs: parsedArgs,
        runTool: (toolName, toolArgs) => args.tools.run(toolName, toolArgs, args.ctx),
        emitToolCall: args.emit,
        emitToolResult: args.emit,
        rememberFullResult: (toolCallId, text) => args.ctx.fullResults!.set(toolCallId, text),
        noteValidationOutcome: false
      })

      const toolMsg: OpenAiMessage = { role: 'tool', tool_call_id: callId, content: outcome.text }
      if (outcome.imageBase64) {
        return {
          name,
          outcome,
          toolMsg,
          extra: {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: `Screenshot from tool ${name}:` },
              { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${outcome.imageBase64}` } }
            ]
          }
        }
      }
      return { name, outcome, toolMsg }
    })

    const results = await Promise.all(toolPromises)
    for (const r of results) {
      if (!r) continue
      noteToolOutcome(validation, r.name, r.outcome)
      messages.push(r.toolMsg)
      resultMsgs.push(r.toolMsg)
      if (r.extra) messages.push(r.extra)
    }
    args.supervisor?.transition(turn + 1, continueAfterToolCalls(assistant.toolCalls.length))
  }
}

/**
 * Collapse all but the last `keep` tool result messages to a short stub, in
 * place. The full result stays retrievable via recall_history using the
 * tool_call_id, so trimming the live window loses nothing.
 */
export function stubOldGrokResults(msgs: OpenAiMessage[], keep: number): void {
  const cutoff = msgs.length - keep
  for (let i = 0; i < cutoff; i++) {
    const m = msgs[i]
    if (typeof m.content === 'string' && m.content.startsWith(STUB_PREFIX)) continue
    const summary = typeof m.content === 'string' ? summarizeTrimmedToolResult(m.content) : ''
    m.content =
      `${STUB_PREFIX} (id ${m.tool_call_id}) — earlier tool result summarized to save tokens:\n` +
      `${summary}\n` +
      `Call recall_history with tool_call_id "${m.tool_call_id}" to read it in full.`
  }
}

function toGrokMessages(req: ChatRequest): OpenAiMessage[] {
  return withDateContext(req.messages).map((m) => {
    if (m.images && m.images.length > 0) {
      const content: (OpenAiTextPart | OpenAiImagePart)[] = [
        { type: 'text', text: m.content || 'Attached screenshot:' }
      ]
      for (const img of m.images) {
        const url = img.startsWith('data:') ? img : `data:image/png;base64,${img}`
        content.push({ type: 'image_url', image_url: { url } })
      }
      return { role: m.role, content }
    }
    return { role: m.role, content: m.content }
  })
}
