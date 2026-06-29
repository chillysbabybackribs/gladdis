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

export interface ChatAgentSelection {
  id: string
  name: string
  prompt: string
}
