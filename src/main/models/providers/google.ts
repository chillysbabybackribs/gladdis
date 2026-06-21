import crypto from 'crypto'
import { GoogleGenAI, Type } from '@google/genai'
import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import {
  createToolValidationState,
  needsValidationBeforeFinal,
  noteToolOutcome,
  validationInstruction,
  VALIDATION_FAILED_FINAL,
} from './toolValidation'

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
  if (!args.workspaceBlock || args.workspaceBlock.length < 50000) {
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
    // 1. Count tokens first to verify minimum threshold of 32,768 tokens
    const countResponse = await args.ai.models.countTokens({
      model: args.modelId,
      contents: [{ role: 'user', parts: [{ text: args.workspaceBlock }] }],
      config: {
        systemInstruction: args.agentSystem
      }
    })

    const totalTokens = countResponse.totalTokens ?? 0
    if (totalTokens < 32768) {
      return undefined
    }

    // 2. Create the cache
    const config: any = {
      systemInstruction: args.agentSystem,
      contents: [
        { role: 'user', parts: [{ text: args.workspaceBlock }] },
        { role: 'model', parts: [{ text: 'Workspace context loaded successfully. I am ready to help you with your code!' }] }
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

type FinishUsage = { inputTokens?: number; outputTokens?: number }
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
  return inputTokens == null && outputTokens == null ? undefined : { inputTokens, outputTokens }
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
      contents: [{ role: 'user', parts: [{ text: args.user }] }],
      config: { systemInstruction: args.system, maxOutputTokens: args.maxOutputTokens }
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
      contents,
      config: {
        abortSignal: args.signal,
        systemInstruction: args.system,
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
}): Promise<void> {
  const systemInstruction = args.workspaceBlock
    ? `${args.agentSystem}\n\n${args.workspaceBlock}`
    : args.agentSystem
  // Rebuilt each step because request_tools can grow the granted set mid-turn.
  const buildDecls = () =>
    resolveTurnTools(args.toolDefs, args.ctx.grantedTools).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toGeminiSchema(t.parameters)
    }))
  let functionDeclarations = buildDecls()

  const contents = toGoogleContents(args.req)
  const responseObjs: GoogleToolResponseRecord[] = []
  const validation = createToolValidationState()

  // Resolve or create Gemini context cache for large workspace blocks
  const cachedContentName = await getOrCreateGeminiCache({
    ai: args.ai,
    modelId: args.modelId,
    agentSystem: args.agentSystem,
    workspaceBlock: args.workspaceBlock,
    tools: [{ functionDeclarations }]
  })

  for (let turn = 0; !args.signal.aborted; turn++) {
    functionDeclarations = buildDecls() // pick up tools granted via request_tools last step
    // The prebuilt cache only covers the starting tools; once the model has pulled
    // in extra groups, send the full tool list inline instead of relying on it.
    const useCache = cachedContentName && !(args.ctx.grantedTools && args.ctx.grantedTools.size > 0)
    const call = args.audit.begin({
      requestId: args.req.requestId,
      conversationId: args.req.conversationId,
      provider: 'google',
      modelId: args.modelId,
      stage: `chat:browser:${turn}`,
      input: { system: args.agentSystem, tools: functionDeclarations, contents }
    })
    let resp: any
    try {
      const config: any = {
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: args.signal
      }

      if (useCache) {
        config.cachedContent = cachedContentName
      } else {
        config.systemInstruction = systemInstruction
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
      if (needsValidationBeforeFinal(validation, args.toolDefs) && !validation.reminderSent) {
        validation.reminderSent = true
        contents.push({ role: 'user', parts: [{ text: validationInstruction(validation) }] })
        continue
      }
      if (needsValidationBeforeFinal(validation, args.toolDefs) && !validation.autoValidationAttempted) {
        validation.autoValidationAttempted = true
        const callId = `auto_validation_${turn}`
        const toolArgs = { check: 'typecheck' }
        args.emit({ requestId: args.req.requestId, type: 'tool_call', tool: 'run_validation', args: toolArgs, callId })
        const outcome = await args.tools.run('run_validation', toolArgs, args.ctx)
        args.ctx.fullResults!.set(callId, outcome.text)
        noteToolOutcome(validation, 'run_validation', outcome)
        args.emit({
          requestId: args.req.requestId,
          type: 'tool_result',
          callId,
          ok: outcome.ok,
          preview: outcome.text
        })
        if (outcome.ok) return
        contents.push({
          role: 'user',
          parts: [{ text: `${VALIDATION_FAILED_FINAL}\n\nAutomatic typecheck result:\n${outcome.text}` }]
        })
        continue
      }
      if (needsValidationBeforeFinal(validation, args.toolDefs)) {
        args.emit({ requestId: args.req.requestId, type: 'delta', text: `\n\n${VALIDATION_FAILED_FINAL}` })
      }
      return
    }

    stubOldGoogleResults(responseObjs, args.keepResults)

    const responseParts: any[] = []
    for (const [callIndex, c] of calls.entries()) {
      if (args.signal.aborted) return
      const fc = c.functionCall
      if (!fc?.name) continue
      const name = fc.name
      const callId = buildGoogleToolCallId(name, turn, callIndex)
      args.emit({ requestId: args.req.requestId, type: 'tool_call', tool: name, args: fc.args, callId })
      const outcome = await args.tools.run(name, (fc.args ?? {}) as Record<string, any>, args.ctx)
      args.ctx.fullResults!.set(callId, outcome.text)
      noteToolOutcome(validation, name, outcome)
      args.emit({
        requestId: args.req.requestId,
        type: 'tool_result',
        callId,
        ok: outcome.ok,
        preview: outcome.text
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
  }
}

/** Same idea for the Google functionResponse result strings. */
export function stubOldGoogleResults(objs: GoogleToolResponseRecord[], keep: number): void {
  const cutoff = objs.length - keep
  for (let i = 0; i < cutoff; i++) {
    const rec = objs[i]
    const r = rec.response
    if (r.result.startsWith(STUB_PREFIX)) continue
    r.result =
      `${STUB_PREFIX} (id ${rec.callId}) — earlier ${rec.name} result trimmed to save tokens. ` +
      `Call recall_history with tool_call_id "${rec.callId}" to read it in full.`
  }
}

function toGoogleContents(req: ChatRequest): any[] {
  return req.messages.map((m) => {
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
