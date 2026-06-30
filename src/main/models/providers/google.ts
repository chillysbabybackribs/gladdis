import crypto from 'crypto'
import { GoogleGenAI, Type } from '@google/genai'
import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import {
  continueAfterToolCalls,
  createToolValidationState,
  type SupervisorTransition,
} from './toolValidation'
import { executeProviderToolCall, handleProviderTurnWithoutToolCalls } from './loopCore'
import { withDateContext } from './dateContext'

interface CacheEntry {
  name: string
  createdAt: number
}

const activeCaches = new Map<string, CacheEntry>()

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function getOrCreateGeminiCache(args: {
  ai: GoogleGenAI
  modelId: string
  agentSystem: string
  workspaceBlock: string | null
  tools?: any[]
}): Promise<string | undefined> {
  if (!args.workspaceBlock) {
    return undefined
  }

  // Generate a hash representing the static block + agent system + tools
  const toolsJson = args.tools ? JSON.stringify(args.tools) : ''
  const hashInput = `${args.agentSystem}|||${args.workspaceBlock}|||${toolsJson}`
  const hash = computeHash(hashInput)
  const cacheKey = `${args.modelId}:${args.tools ? 'tools:' : 'plain:'}${hash}`

  const existing = activeCaches.get(cacheKey)
  if (existing && Date.now() - existing.createdAt < 25 * 60 * 1000) { // 25 min expiry limit
    return existing.name
  }

  try {
    const MIN_CACHEABLE_TOKENS = 4096
    const combinedText = args.workspaceBlock
      ? `${args.agentSystem}\n\n${args.workspaceBlock}`
      : args.agentSystem

    const countResponse = await args.ai.models.countTokens({
      model: args.modelId,
      contents: [{ role: 'user', parts: [{ text: combinedText }] }]
    })

    const totalTokens = countResponse.totalTokens ?? 0
    if (totalTokens < MIN_CACHEABLE_TOKENS) {
      return undefined
    }

    // 2. Create the cache
    const config: any = {
      contents: [
        { role: 'user', parts: [{ text: combinedText }] },
        { role: 'model', parts: [{ text: 'I have loaded the workspace context and tool definitions. I am ready to assist you.' }] }
      ],
      ttl: '1800s', // 30 minutes
      displayName: `gladdis_${args.tools ? 'tools_' : ''}${hash.slice(0, 8)}`
    }

    if (args.tools) {
      config.tools = args.tools
    }

    const cache = await args.ai.caches.create({
      model: args.modelId,
      config
    })

    if (cache.name) {
      activeCaches.set(cacheKey, {
        name: cache.name,
        createdAt: Date.now()
      })
      return cache.name
    }
  } catch (err) {
    console.warn('[Gemini Caching] Failed to create context cache:', err)
  }

  return undefined
}
import type { LlmComplete } from '../../pipeline/Planner'
import type { BrowserTools, ToolContext, ToolDef } from '../browserTools'
import { resolveTurnTools } from '../agentTools'

type FinishUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
type ActiveAuditCall = {
  addOutput: (chunk: unknown) => void
  finish: (result?: { output?: unknown; status?: 'ok' | 'error'; error?: unknown; usage?: FinishUsage }) => void
}
type ModelAudit = {
  begin: (call: {
    requestId?: string
    conversationId?: string | null
    provider: 'google'
    modelId: string
    stage: string
    input: unknown
  }) => ActiveAuditCall
}

export interface GoogleToolResponseRecord {
  name: string
  callId: string
  response: {
    result: string
    tool_call_id: string
    note?: string
  }
}

const STUB_PREFIX = '[trimmed]'

export function usageFromGoogle(value: any): FinishUsage | undefined {
  const usage = value?.usageMetadata ?? value?.usage_metadata
  if (!usage) return undefined
  const inputTokens =
    typeof usage.promptTokenCount === 'number'
      ? usage.promptTokenCount
      : typeof usage.inputTokenCount === 'number'
        ? usage.inputTokenCount
        : undefined
  const outputTokens =
    typeof usage.candidatesTokenCount === 'number'
      ? usage.candidatesTokenCount
      : typeof usage.outputTokenCount === 'number'
        ? usage.outputTokenCount
        : undefined
  const cachedInputTokens =
    typeof usage.cachedContentTokenCount === 'number'
      ? usage.cachedContentTokenCount
      : typeof usage.cached_content_token_count === 'number'
        ? usage.cached_content_token_count
        : undefined
  return inputTokens == null && outputTokens == null && cachedInputTokens == null
    ? undefined
    : { inputTokens, outputTokens, cachedInputTokens }
}

export async function titleGoogle(args: {
  ai: GoogleGenAI
  audit: ModelAudit
  modelId: string
  prompt: string
}): Promise<string> {
  const call = args.audit.begin({
    provider: 'google',
    modelId: args.modelId,
    stage: 'title',
    input: args.prompt
  })
  try {
    const res = await args.ai.models.generateContent({
      model: args.modelId,
      contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
      config: { maxOutputTokens: 24 }
    })
    const text = res.text ?? ''
    call.finish({ output: text, usage: usageFromGoogle(res) })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function completeGoogle(args: {
  ai: GoogleGenAI
  audit: ModelAudit
  modelId: string
  system: string
  user: string
  maxOutputTokens: number
  stage: string
}): Promise<string> {
  const call = args.audit.begin({
    provider: 'google',
    modelId: args.modelId,
    stage: args.stage,
    input: { system: args.system, user: args.user }
  })
  try {
    const res = await args.ai.models.generateContent({
      model: args.modelId,
      contents: [
        { role: 'user', parts: [{ text: args.system }] },
        { role: 'model', parts: [{ text: 'Acknowledged. I will follow these instructions.' }] },
        { role: 'user', parts: [{ text: args.user }] }
      ],
      config: { maxOutputTokens: args.maxOutputTokens }
    })
    const text = res.text ?? ''
    call.finish({ output: text, usage: usageFromGoogle(res) })
    return text
  } catch (err) {
    call.finish({ status: 'error', error: err })
    throw err
  }
}

export async function streamGooglePlain(args: {
  ai: GoogleGenAI
  audit: ModelAudit
  emit: (e: ChatStreamEvent) => void
  req: ChatRequest
  modelId: string
  signal: AbortSignal
  system: string
  maxOutputTokens: number
}): Promise<void> {
  const contents = toGoogleContents(args.req)
  const call = args.audit.begin({
    requestId: args.req.requestId,
    conversationId: args.req.conversationId,
    provider: 'google',
    modelId: args.modelId,
    stage: 'chat:plain',
    input: { system: args.system, contents }
  })
  let output = ''
  let finalUsage: FinishUsage | undefined
  try {
    const response = await args.ai.models.generateContentStream({
      model: args.modelId,
      contents: [
        { role: 'user', parts: [{ text: args.system }] },
        { role: 'model', parts: [{ text: 'Acknowledged. I will follow these instructions.' }] },
        ...contents
      ],
      config: {
        abortSignal: args.signal,
        maxOutputTokens: args.maxOutputTokens
      }
    })
    for await (const chunk of response) {
      finalUsage = usageFromGoogle(chunk) ?? finalUsage
      if (args.signal.aborted) break
      if (chunk.text) {
        output += chunk.text
        call.addOutput(chunk.text)
        args.emit({ requestId: args.req.requestId, type: 'delta', text: chunk.text })
      }
    }
    call.finish({ output, usage: finalUsage })
  } catch (err) {
    call.finish({ status: 'error', error: err, output })
    throw err
  }
}

export async function runGoogleToolLoop(args: {
  ai: GoogleGenAI
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
  maxOutputTokens: number
  keepResults: number
  supervisor?: {
    iterationStarted: (iteration: number) => void
    transition: (iteration: number, transition: SupervisorTransition) => void
  }
}): Promise<void> {
  const preambleText = args.workspaceBlock
    ? `${args.agentSystem}\n\n${args.workspaceBlock}`
    : args.agentSystem

  // Use all tools for stable prefix caching
  const functionDeclarations = args.toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.parameters)
  }))

  const cachedContentName = await getOrCreateGeminiCache({
    ai: args.ai,
    modelId: args.modelId,
    agentSystem: args.agentSystem,
    workspaceBlock: args.workspaceBlock,
    tools: [{ functionDeclarations }]
  })

  // Prepend preamble if not using explicit cache (explicit cache already includes it)
  const fullContents = toGoogleContents(args.req)
  const contents = cachedContentName
    ? fullContents
    : [
        { role: 'user', parts: [{ text: preambleText }] },
        { role: 'model', parts: [{ text: 'I have loaded the workspace context and tool definitions. I am ready to assist you.' }] },
        ...fullContents
      ]

  const responseObjs: GoogleToolResponseRecord[] = []
  const validation = createToolValidationState()

  for (let turn = 0; !args.signal.aborted; turn++) {
    args.ctx.iteration = turn + 1
    args.supervisor?.iterationStarted(turn + 1)
    
    const useCache = !!cachedContentName
    const call = args.audit.begin({
      requestId: args.req.requestId,
      conversationId: args.req.conversationId,
      provider: 'google',
      modelId: args.modelId,
      stage: `chat:browser:${turn}`,
      input: { system: args.agentSystem, tools: functionDeclarations, contents }
    })
    // TEMP token-bloat probe — remove after one diagnostic run.
    {
      const partChars = (parts: any[]): number =>
        (parts ?? []).reduce((sum: number, p: any) => {
          if (p?.text) return sum + p.text.length
          if (p?.functionCall) return sum + JSON.stringify(p.functionCall).length
          if (p?.functionResponse) return sum + JSON.stringify(p.functionResponse).length
          if (p?.inlineData?.data) return sum + p.inlineData.data.length
          return sum + JSON.stringify(p ?? '').length
        }, 0)
      let priorUser = 0
      let modelOutputs = 0
      let verbatimResults = 0
      let stubResults = 0
      for (const c of contents as any[]) {
        const sz = partChars(c.parts)
        if (c.role === 'model') {
          modelOutputs += sz
        } else if (c.role === 'user') {
          const isToolResult = (c.parts ?? []).some((p: any) => p.functionResponse)
          if (!isToolResult) {
            priorUser += sz
          } else {
            const stubbed = (c.parts ?? []).some(
              (p: any) => typeof p?.functionResponse?.response?.result === 'string' &&
                p.functionResponse.response.result.startsWith(STUB_PREFIX)
            )
            if (stubbed) stubResults += sz
            else verbatimResults += sz
          }
        }
      }
      const total = priorUser + modelOutputs + verbatimResults + stubResults
      const k = (n: number) => (n / 1000).toFixed(1) + 'k'
      console.log(
        `[token-probe] turn=${turn} contents=${(contents as any[]).length} totalChars=${k(total)} ` +
        `priorUser=${k(priorUser)} modelOutputs=${k(modelOutputs)} ` +
        `verbatimResults=${k(verbatimResults)} stubResults=${k(stubResults)}`
      )
    }
    let resp: any
    try {
      const config: any = {
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: args.signal
      }

      if (useCache) {
        config.cachedContent = cachedContentName
      } else {
        config.tools = [{ functionDeclarations }]
      }

      resp = await args.ai.models.generateContent({
        model: args.modelId,
        contents,
        config
      })
    } catch (err) {
      call.finish({ status: 'error', error: err })
      throw err
    }

    const parts = resp.candidates?.[0]?.content?.parts ?? []
    const calls = parts.filter((p: any) => p.functionCall)
    const output = parts.map((p: any) => p.text ?? JSON.stringify(p.functionCall ?? '')).join('')
    for (const p of parts) {
      if (p.text) {
        call.addOutput(p.text)
        args.emit({ requestId: args.req.requestId, type: 'delta', text: p.text })
      }
    }
    call.finish({ output, usage: usageFromGoogle(resp) })

    contents.push({ role: 'model', parts })
    if (calls.length === 0) {
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
        appendRetryPrompt: (prompt) => contents.push({ role: 'user', parts: [{ text: prompt }] }),
        emitWarningDelta: (warningDelta) =>
          args.emit({ requestId: args.req.requestId, type: 'delta', text: warningDelta })
      })
      if (result === 'continue') continue
      return
    }

    await stubOldGoogleResults(responseObjs, args.keepResults, {
      ai: args.ai,
      audit: args.audit,
      modelId: 'gemini-2.5-flash-lite'
    })

    const responseParts: any[] = []
    for (const [callIndex, c] of calls.entries()) {
      if (args.signal.aborted) return
      const fc = c.functionCall
      if (!fc?.name) continue
      const name = fc.name
      const callId = buildGoogleToolCallId(name, turn, callIndex)
      const { outcome } = await executeProviderToolCall({
        requestId: args.req.requestId,
        callId,
        name,
        toolArgs: (fc.args ?? {}) as Record<string, any>,
        runTool: (toolName, toolArgs) => args.tools.run(toolName, toolArgs, args.ctx),
        emitToolCall: args.emit,
        emitToolResult: args.emit,
        rememberFullResult: (toolCallId, text) => args.ctx.fullResults!.set(toolCallId, text),
        validationState: validation
      })
      const response = {
        tool_call_id: callId,
        result: outcome.text,
        ...(outcome.imageBase64 ? { note: 'Screenshot image follows in this turn.' } : {})
      }
      responseObjs.push({ name, callId, response })
      responseParts.push({ functionResponse: { name, response } })
      if (outcome.imageBase64) {
        responseParts.push({
          inlineData: { mimeType: 'image/png', data: outcome.imageBase64 }
        })
      }
    }
    contents.push({ role: 'user', parts: responseParts })
    args.supervisor?.transition(turn + 1, continueAfterToolCalls(calls.length))
  }
}

/** Only summarize aged results big enough that compression actually saves tokens. */
const SUMMARIZE_MIN_CHARS = 2_000
/** Cap the summarizer's own output so a stub never re-bloats the payload. */
const SUMMARY_MAX_OUTPUT_TOKENS = 256

/** One-time map: callId -> generated summary, so a result is summarized at most once. */
const summaryCache = new Map<string, string>()

function bareStub(rec: GoogleToolResponseRecord): string {
  return (
    `${STUB_PREFIX} (id ${rec.callId}) — earlier ${rec.name} result trimmed to save tokens. ` +
    `Call recall_history with tool_call_id "${rec.callId}" to read it in full.`
  )
}

/**
 * Summarize the full tool-result text with a cheap model (Gemini Flash-Lite) so the
 * aged stub keeps WHAT the model learned, not just a "trimmed" placeholder. Falls back
 * to the bare stub on any failure — summarization is best-effort, never load-bearing.
 */
async function summarizeAgedResult(
  rec: GoogleToolResponseRecord,
  fullText: string,
  summarizer: {
    ai: GoogleGenAI
    audit: ModelAudit
    modelId: string
  }
): Promise<string> {
  const cached = summaryCache.get(rec.callId)
  if (cached) return cached
  try {
    const summary = await completeGoogle({
      ai: summarizer.ai,
      audit: summarizer.audit,
      modelId: summarizer.modelId,
      system:
        'You compress a tool result so a coding agent keeps the key facts without the full text. ' +
        'Output 1-4 tight lines: what the result contained (files/symbols/values/answer). No preamble.',
      user: fullText,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      stage: 'summarize-aged-result'
    })
    const trimmed = summary.trim()
    if (!trimmed) return bareStub(rec)
    const stub =
      `${STUB_PREFIX} (id ${rec.callId}) — earlier ${rec.name} result, summarized to save tokens:\n` +
      `${trimmed}\n` +
      `Call recall_history with tool_call_id "${rec.callId}" to read it in full.`
    summaryCache.set(rec.callId, stub)
    return stub
  } catch (err) {
    console.warn('[summarize-aged-result] falling back to bare stub:', err)
    return bareStub(rec)
  }
}

/**
 * Trim tool results that have aged past the verbatim window. Large results are replaced
 * with a model-generated summary (cheap model) instead of a bare placeholder, so the
 * agent retains the knowledge; small results just get the bare stub. `summarizer`
 * is optional — without it (or on any failure) we fall back to the original bare stub.
 */
export async function stubOldGoogleResults(
  objs: GoogleToolResponseRecord[],
  keep: number,
  summarizer?: { ai: GoogleGenAI; audit: ModelAudit; modelId: string }
): Promise<void> {
  const cutoff = objs.length - keep
  for (let i = 0; i < cutoff; i++) {
    const rec = objs[i]
    const r = rec.response
    if (r.result.startsWith(STUB_PREFIX)) continue
    const fullText = r.result
    if (summarizer && fullText.length >= SUMMARIZE_MIN_CHARS) {
      r.result = await summarizeAgedResult(rec, fullText, summarizer)
    } else {
      r.result = bareStub(rec)
    }
  }
}

function toGoogleContents(req: ChatRequest): any[] {
  return withDateContext(req.messages).map((m) => {
    const parts: any[] = [{ text: m.content || '' }]
    if (m.images && m.images.length > 0) {
      for (const img of m.images) {
        const match = img.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          const [, mimeType, data] = match
          parts.push({
            inlineData: { mimeType, data }
          })
        } else {
          parts.push({
            inlineData: { mimeType: 'image/png', data: img }
          })
        }
      }
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts
    }
  })
}

function buildGoogleToolCallId(name: string, turn: number, callIndex: number): string {
  return `${name}-${turn}-${callIndex}`
}

/** Map our JSON-schema-ish tool params into @google/genai's Schema enum types. */
function toGeminiSchema(p: { type: string; properties: Record<string, any>; required?: string[] }): any {
  const mapType = (t: string) =>
    t === 'string'
      ? Type.STRING
      : t === 'number'
        ? Type.NUMBER
        : t === 'boolean'
          ? Type.BOOLEAN
          : t === 'object'
            ? Type.OBJECT
            : Type.STRING
  const properties: Record<string, any> = {}
  for (const [k, v] of Object.entries(p.properties)) {
    properties[k] = { type: mapType(v.type), description: v.description }
  }
  return { type: Type.OBJECT, properties, required: p.required ?? [] }
}
