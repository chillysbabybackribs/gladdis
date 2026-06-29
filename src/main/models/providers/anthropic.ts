import Anthropic from '@anthropic-ai/sdk'
import type { ChatRequest, ChatStreamEvent } from '../../../../shared/types'
import type { LlmComplete } from '../../pipeline/Planner'
import type { BrowserTools, ToolContext, ToolDef } from '../browserTools'
import { resolveTurnTools } from '../agentTools'
import {
  continueAfterToolCalls,
  createToolValidationState,
  type SupervisorTransition,
} from './toolValidation'
import { executeProviderToolCall, handleProviderTurnWithoutToolCalls } from './loopCore'

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
  }) => ActiveAuditCall
}

const STUB_PREFIX = '[trimmed]'

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

function applyRollingCache(messages: Anthropic.MessageParam[]): void {
  // First, strip all cache_control from all messages to avoid exceeding the limit
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'cache_control' in block) {
          delete (block as any).cache_control
        }
      }
    }
  }

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
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
      break // Only cache the single last user message
    }
  }
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
  applyRollingCache(messages)

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
}): Promise<void> {
  const system: Anthropic.MessageCreateParams['system'] = [
    { type: 'text', text: args.agentSystem, cache_control: { type: 'ephemeral' } }
  ]
  if (args.workspaceBlock) {
    system.push({ type: 'text', text: args.workspaceBlock, cache_control: { type: 'ephemeral' } })
  }

  // Rebuilt each step because request_tools can grow the granted set mid-turn.
  // The cache_control marker sits on the last tool, so the prompt cache naturally
  // invalidates exactly when (and only when) the tool list actually changes.
  const buildTools = () => {
    const defs = resolveTurnTools(args.toolDefs, args.ctx.grantedTools)
    return defs.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
      ...(i === defs.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
    }))
  }
  let anthropicTools = buildTools()

  const messages = toAnthropicMessages(args.req)
  const resultBlocks: Anthropic.ToolResultBlockParam[] = []
  const validation = createToolValidationState()

  for (let turn = 0; !args.signal.aborted; turn++) {
    args.ctx.iteration = turn + 1
    args.supervisor?.iterationStarted(turn + 1)
    anthropicTools = buildTools() // pick up tools granted via request_tools last step
    applyRollingCache(messages)
    const call = args.audit.begin({
      requestId: args.req.requestId,
      conversationId: args.req.conversationId,
      provider: 'anthropic',
      modelId: args.modelId,
      stage: `chat:browser:${turn}`,
      input: { system: args.agentSystem, tools: anthropicTools, messages }
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

    stubOldResults(resultBlocks, args.keepResults)

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
 * Collapse all but the last `keep` Anthropic tool_result blocks to a short
 * stub, in place. The full result stays retrievable via recall_history using
 * the block's tool_use_id, so trimming the live window doesn't lose anything.
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
  return req.messages.map((m) => {
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
