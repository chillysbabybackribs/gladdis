import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import type { LlmComplete } from '../../pipeline/Planner'
import type { BrowserTools, ToolContext, ToolDef } from '../browserTools'
import { resolveTurnTools } from '../agentTools'
import {
  continueAfterToolCalls,
  createToolValidationState,
  noteToolOutcome,
  type SupervisorTransition
} from './toolValidation'
import { executeProviderToolCall, handleProviderTurnWithoutToolCalls } from './loopCore'

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
    provider: 'openai'
    modelId: string
    stage: string
    input: unknown
  }) => ActiveAuditCall
}

const STUB_PREFIX = '[trimmed]'

/* ----------------------------- OpenAI wire types ----------------------------- */

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
  role: 'developer' | 'system' | 'user' | 'assistant' | 'tool'
  content?: OpenAiContent | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
  name?: string
}

type StreamedTurn = {
  text: string
  toolCalls: OpenAiToolCall[]
  usage?: FinishUsage
}

type OpenAiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

/* ----------------------------- Helpers ----------------------------- */

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

/** Internal gladdis ids may use hyphens where OpenAI model names use dots. */
const OPENAI_MODEL_ALIASES: Record<string, string> = {
  'gpt-4-1-mini': 'gpt-4.1-mini'
}

function openAiApiModelId(modelId: string): string {
  const cleanId = modelId.replace(/^openai-/, '')
  return OPENAI_MODEL_ALIASES[cleanId] ?? cleanId
}

/** Max completion tokens accepted by /v1/chat/completions for each model family. */
function openAiMaxCompletionTokens(apiModelId: string): number {
  if (apiModelId.startsWith('gpt-5.5') || apiModelId.startsWith('gpt-5.4')) {
    return 32_000
  }
  if (apiModelId.startsWith('gpt-4.1')) {
    return 32_768
  }
  return 16_384
}

function openAiHeaders(apiKey: string, _conversationId?: string | null): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
}

function openAiReasoningEffort(modelId: string, stage: string): OpenAiReasoningEffort | undefined {
  const apiModelId = openAiApiModelId(modelId)
  if (!apiModelId.startsWith('gpt-5.5') && !apiModelId.startsWith('gpt-5.4')) {
    return undefined
  }
  if (/\b(plan|planner|replan|debug|review|refactor|code|coding)\b/i.test(stage)) {
    return 'high'
  }
  if (stage.startsWith('chat:browser') || stage === 'complete' || stage === 'pipeline:final') {
    return 'medium'
  }
  return 'low'
}

export function usageFromOpenAi(usage: any): FinishUsage | undefined {
  if (!usage) return undefined
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const reasoningOutputTokens =
    typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
      ? usage.completion_tokens_details.reasoning_tokens
      : undefined
  return { inputTokens, outputTokens, reasoningOutputTokens }
}

export function toOpenAiMessages(req: ChatRequest): OpenAiMessage[] {
  return req.messages.map((m) => {
    return { role: m.role, content: m.content }
  })
}

async function openAiFetchJson(args: {
  apiKey: string
  body: Record<string, any>
  conversationId?: string | null
}): Promise<any> {
  const res = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: openAiHeaders(args.apiKey, args.conversationId),
    body: JSON.stringify(args.body)
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI request failed (${res.status}): ${detail.slice(0, 500)}`)
  }
  return res.json()
}

function openAiBody(args: {
  modelId: string
  messages: OpenAiMessage[]
  temp?: number
  maxTokens?: number
  tools?: any[]
  stage: string
}): Record<string, any> {
  const apiModelId = openAiApiModelId(args.modelId)
  const body: Record<string, any> = {
    model: apiModelId,
    messages: args.messages
  }

  const isReasoning = apiModelId.startsWith('gpt-5.5') || apiModelId.startsWith('gpt-5.4')
  // OpenAI's /v1/chat/completions rejects `reasoning_effort` when function
  // tools are also present for the entire gpt-5.4 family (base, -pro, -mini,
  // -nano) and for gpt-5.5 -mini / -nano:
  //   "Function tools with reasoning_effort are not supported for gpt-5.4 in
  //    /v1/chat/completions. Please use /v1/responses instead."
  // Only the full-size gpt-5.5 still accepts the combo on this endpoint, so
  // omit `reasoning_effort` for everything else when tools are attached.
  const reasoningEffortIncompatibleWithTools =
    apiModelId.startsWith('gpt-5.4') || /^gpt-5\.5-(mini|nano)\b/.test(apiModelId)
  const hasTools = !!(args.tools && args.tools.length)
  const reasoningEffortBlocked = reasoningEffortIncompatibleWithTools && hasTools
  const maxTokens = args.maxTokens
    ? Math.min(args.maxTokens, openAiMaxCompletionTokens(apiModelId))
    : undefined
  if (isReasoning) {
    if (maxTokens) {
      body.max_completion_tokens = maxTokens
    }
    if (!reasoningEffortBlocked) {
      const effort = openAiReasoningEffort(apiModelId, args.stage)
      if (effort) {
        // Chat Completions takes a top-level string (`reasoning_effort: "low"`).
        // The nested `{ reasoning: { effort } }` shape is the Responses API; the
        // /v1/chat/completions endpoint rejects it as `unknown_parameter`.
        body.reasoning_effort = effort
      }
    }
  } else {
    if (maxTokens) {
      body.max_tokens = maxTokens
    }
    if (args.temp !== undefined) {
      body.temperature = args.temp
    }
  }

  if (args.tools) {
    body.tools = args.tools
  }

  return body
}

/** Test-only surface — do not import outside of *.test.ts */
export const __testInternals = { openAiBody, openAiApiModelId, openAiMaxCompletionTokens }

/* ----------------------------- Exported endpoints ----------------------------- */

export async function titleOpenAi(args: {
  apiKey: string
  audit: ModelAudit
  modelId: string
  prompt: string
}): Promise<string> {
  const messages: OpenAiMessage[] = [{ role: 'user', content: args.prompt }]
  const body = openAiBody({
    modelId: args.modelId,
    messages,
    maxTokens: 50,
    stage: 'title'
  })

  const call = args.audit.begin({
    provider: 'openai',
    modelId: args.modelId,
    stage: 'title',
    input: body
  })

  try {
    const data = await openAiFetchJson({ apiKey: args.apiKey, body })
    const text = (data.choices?.[0]?.message?.content ?? '').trim()
    const usage = usageFromOpenAi(data.usage)
    call.finish({ output: text, usage })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function completeOpenAi(args: {
  apiKey: string
  audit: ModelAudit
  modelId: string
  system: string
  user: string
  maxOutputTokens?: number
  stage?: string
  conversationId?: string | null
}): Promise<string> {
  const stage = args.stage ?? 'complete'
  const messages: OpenAiMessage[] = [
    { role: 'developer', content: args.system },
    { role: 'user', content: args.user }
  ]

  const body = openAiBody({
    modelId: args.modelId,
    messages,
    maxTokens: args.maxOutputTokens,
    stage
  })

  const call = args.audit.begin({
    conversationId: args.conversationId,
    provider: 'openai',
    modelId: args.modelId,
    stage,
    input: body
  })

  try {
    const data = await openAiFetchJson({ apiKey: args.apiKey, body, conversationId: args.conversationId })
    const text = data.choices?.[0]?.message?.content ?? ''
    const usage = usageFromOpenAi(data.usage)
    call.finish({ output: text, usage })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

async function streamOpenAiChat(args: {
  apiKey: string
  body: Record<string, any>
  signal: AbortSignal
  onText: (text: string) => void
  conversationId?: string | null
}): Promise<StreamedTurn> {
  const res = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: openAiHeaders(args.apiKey, args.conversationId),
    body: JSON.stringify({ ...args.body, stream: true, stream_options: { include_usage: true } }),
    signal: args.signal
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI stream failed (${res.status}): ${detail.slice(0, 500)}`)
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
        if (evt.usage) turn.usage = usageFromOpenAi(evt.usage)
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
    reader.releaseLock()
  }

  turn.toolCalls = Array.from(toolByIndex.values())
  return turn
}

export async function streamOpenAiPlain(args: {
  apiKey: string
  audit: ModelAudit
  emit: (evt: ChatStreamEvent) => void
  req: ChatRequest
  modelId: string
  signal: AbortSignal
  system: string
  maxTokens?: number
  temp?: number
}): Promise<void> {
  const formattedSystem: OpenAiMessage = { role: 'developer', content: args.system }
  const messages: OpenAiMessage[] = [formattedSystem, ...toOpenAiMessages(args.req)]

  const body = openAiBody({
    modelId: args.modelId,
    messages,
    maxTokens: args.maxTokens,
    temp: args.temp,
    stage: 'chat:plain'
  })

  const call = args.audit.begin({
    requestId: args.req.requestId,
    conversationId: args.req.conversationId,
    provider: 'openai',
    modelId: args.modelId,
    stage: 'chat:plain',
    input: body
  })

  try {
    const turn = await streamOpenAiChat({
      apiKey: args.apiKey,
      body,
      signal: args.signal,
      conversationId: args.req.conversationId,
      onText: (text) => {
        call.addOutput(text)
        args.emit({ requestId: args.req.requestId, type: 'delta', text })
      }
    })
    call.finish({ output: turn.text, usage: turn.usage })
  } catch (err) {
    if (args.signal.aborted) {
      call.finish({ output: '[Aborted]' })
    } else {
      call.finish({ status: 'error', error: err })
      throw err
    }
  }
}

export async function runOpenAiToolLoop(args: {
  apiKey: string
  audit: ModelAudit
  emit: (evt: ChatStreamEvent) => void
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
}): Promise<void> {
  const buildTools = () =>
    resolveTurnTools(args.toolDefs, args.ctx.grantedTools).map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  let tools = buildTools()

  const systemText = args.workspaceBlock
    ? `${args.agentSystem}\n\n${args.workspaceBlock}`
    : args.agentSystem

  const formattedSystem: OpenAiMessage = {
    role: 'developer',
    content: systemText
  }
  const messages: OpenAiMessage[] = [formattedSystem, ...toOpenAiMessages(args.req)]
  const resultMsgs: OpenAiMessage[] = []
  const validation = createToolValidationState()

  for (let turn = 0; !args.signal.aborted; turn++) {
    args.ctx.iteration = turn + 1
    args.supervisor?.iterationStarted(turn + 1)
    tools = buildTools()

    const call = args.audit.begin({
      requestId: args.req.requestId,
      conversationId: args.req.conversationId,
      provider: 'openai',
      modelId: args.modelId,
      stage: `chat:browser:${turn}`,
      input: { system: systemText, tools, messages }
    })

    let assistant: StreamedTurn
    try {
      assistant = await streamOpenAiChat({
        apiKey: args.apiKey,
        signal: args.signal,
        conversationId: args.req.conversationId,
        body: openAiBody({
          modelId: args.modelId,
          stage: `chat:browser:${turn}`,
          messages,
          tools,
          maxTokens: args.maxTokens
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

    stubOldOpenAiResults(resultMsgs, args.keepResults)

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

      const toolMsg: OpenAiMessage = { role: 'tool', tool_call_id: callId, name, content: outcome.text }
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

export function stubOldOpenAiResults(msgs: OpenAiMessage[], keep: number): void {
  const cutoff = msgs.length - keep
  for (let i = 0; i < cutoff; i++) {
    const msg = msgs[i]
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.startsWith(STUB_PREFIX)) continue
      msg.content = `${STUB_PREFIX} (id ${msg.tool_call_id}) — earlier result trimmed to save tokens. Call recall_history with tool_call_id "${msg.tool_call_id}" to read it in full.`
    }
  }
}
