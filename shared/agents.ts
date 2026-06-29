export interface SavedAgent {
  id: string
  name: string
  modelId: string
  prompt: string
  roughPrompt?: string
  testTask?: string
  createdAt: number
  updatedAt: number
}

export interface SaveAgentInput {
  id?: string
  name: string
  modelId: string
  prompt: string
  roughPrompt?: string
  testTask?: string
}

export interface OptimizeAgentInput {
  name?: string
  modelId: string
  roughPrompt: string
  workspaceRoot?: string | null
  existingAgent?: SavedAgent | null
}

export interface OptimizeAgentResult {
  name?: string
  modelId?: string
  prompt: string
  testTask: string
  contextSummary?: string
  notes?: string[]
  source: 'llm'
}

export interface ChatAgentSelection {
  id: string
  name: string
  prompt: string
}
