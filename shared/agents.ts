export interface SavedAgentBlueprint {
  goal?: string
  optimizerModelId?: string
  runtimeModelId?: string
  taskFamily?: string
  workspaceBound?: boolean
  preferredTools?: string[]
  disallowedTools?: string[]
  knownPaths?: string[]
  knownCommands?: string[]
  workflowSteps?: string[]
  verificationSteps?: string[]
  stopConditions?: string[]
  fallbackRules?: string[]
  assumptions?: string[]
  testTasks?: string[]
  optimizationSummary?: string
  evidenceNotes?: string[]
  validationNotes?: string[]
}

export interface SavedAgent extends SavedAgentBlueprint {
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
  goal?: string
  optimizerModelId?: string
  runtimeModelId?: string
  taskFamily?: string
  workspaceBound?: boolean
  preferredTools?: string[]
  disallowedTools?: string[]
  knownPaths?: string[]
  knownCommands?: string[]
  workflowSteps?: string[]
  verificationSteps?: string[]
  stopConditions?: string[]
  fallbackRules?: string[]
  assumptions?: string[]
  testTasks?: string[]
  optimizationSummary?: string
  evidenceNotes?: string[]
  validationNotes?: string[]
  roughPrompt?: string
  testTask?: string
}

export interface OptimizeAgentInput {
  optimizationMode?: 'quick' | 'deep'
  name?: string
  modelId: string
  roughPrompt: string
  workspaceRoot?: string | null
  existingAgent?: SavedAgent | null
}

export interface OptimizeAgentResult extends SavedAgentBlueprint {
  name?: string
  modelId?: string
  prompt: string
  testTask: string
  contextSummary?: string
  notes?: string[]
  validationNotes?: string[]
  source: 'llm'
}

export interface ChatAgentSelection extends SavedAgentBlueprint {
  id: string
  name: string
  prompt: string
}
