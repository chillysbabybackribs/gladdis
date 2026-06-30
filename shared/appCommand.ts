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

/**
 * Zoom one chat panel from the native View menu. The chat zoom is per-panel
 * and lives separately from Chromium's window-level zoom (which still applies
 * to the rest of the UI via the standard View > Zoom roles).
 */
export type ChatZoomCommand = {
  type: 'chat:zoom'
  panel: 'left' | 'right'
  action: 'in' | 'out' | 'reset'
}

/**
 * Zoom the embedded browser (all tabs share one factor) from the View menu.
 * The page content scales inside the existing WebContentsView bounds — the
 * rectangle in the layout stays the same, only the page content reflows
 * inside it.
 */
export type BrowserZoomCommand = {
  type: 'browser:zoom'
  action: 'in' | 'out' | 'reset'
}

export type AppCommand =
  | TerminalAgentCommand
  | AgentCreateCommand
  | AgentSelectCommand
  | AgentEditCommand
  | MemoryOpenCommand
  | ChatZoomCommand
  | BrowserZoomCommand
