export type TerminalAgentCommand =
  | {
      type: 'terminal:run'
      command: 'codex' | 'codex --yolo' | 'claude' | 'claude --dangerously-skip-permissions'
    }

export type AgentCreateCommand = {
  type: 'agents:create'
}

export type AppCommand = TerminalAgentCommand | AgentCreateCommand
