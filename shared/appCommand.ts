export type TerminalAgentCommand =
  | {
      type: 'terminal:run'
      command: 'codex' | 'codex --yolo' | 'claude' | 'claude --dangerously-skip-permissions'
    }

export type AgentCreateCommand = {
  type: 'agents:create'
}

/** Select (or clear, with agentId null) the active agent for one chat panel. */
export type AgentSelectCommand = {
  type: 'agents:select'
  panel: 'left' | 'right'
  agentId: string | null
}

/** Open the Agent Builder to edit a saved agent (from the native Agents menu). */
export type AgentEditCommand = {
  type: 'agents:edit'
  agentId: string
}

/** Which memory section the Memory menu asked to open. */
export type MemorySection = 'curate' | 'review' | 'history' | 'auto'

export type MemoryOpenCommand = {
  type: 'memory:open'
  section: MemorySection
}

export type AppCommand =
  | TerminalAgentCommand
  | AgentCreateCommand
  | AgentSelectCommand
  | AgentEditCommand
  | MemoryOpenCommand
