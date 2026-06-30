import type { ToolDef } from '../browserTools'

type OpenAiFunctionTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolDef['parameters']
  }
}

type AnthropicTool = {
  name: string
  description: string
  input_schema: ToolDef['parameters']
  cache_control?: { type: 'ephemeral' }
}

const OPENAI_TOOL_CACHE = new WeakMap<ToolDef[], OpenAiFunctionTool[]>()
const ANTHROPIC_TOOL_CACHE = new WeakMap<ToolDef[], AnthropicTool[]>()
let openAiToolComputeCount = 0
let anthropicToolComputeCount = 0

export function toOpenAiFunctionTools(toolDefs: ToolDef[]): OpenAiFunctionTool[] {
  const cached = OPENAI_TOOL_CACHE.get(toolDefs)
  if (cached) return cached

  openAiToolComputeCount += 1
  const tools = toolDefs.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
  OPENAI_TOOL_CACHE.set(toolDefs, tools)
  return tools
}

export function toAnthropicTools(toolDefs: ToolDef[]): AnthropicTool[] {
  const cached = ANTHROPIC_TOOL_CACHE.get(toolDefs)
  if (cached) return cached

  anthropicToolComputeCount += 1
  const tools = toolDefs.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(index === toolDefs.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
  }))
  ANTHROPIC_TOOL_CACHE.set(toolDefs, tools)
  return tools
}

export const __testInternals = {
  reset(): void {
    openAiToolComputeCount = 0
    anthropicToolComputeCount = 0
  },
  getState(): { openAiToolComputeCount: number; anthropicToolComputeCount: number } {
    return { openAiToolComputeCount, anthropicToolComputeCount }
  }
}
