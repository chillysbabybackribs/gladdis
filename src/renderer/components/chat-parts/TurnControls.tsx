import type {
  ClaudeCodeStatus,
  CodexStatus,
  CursorStatus,
  KeyStatus,
  ModelOption,
  SavedAgent,
  Workspace
} from '../../../../shared/types'
import { ModelPicker } from '../ModelPicker'

/**
 * Top-of-composer controls: model picker + workspace folder chip.
 * The chip's title flips between "click to change" and the prompt to pick
 * a folder so first-time users discover the affordance without explanation.
 *
 * Agent selection lives beside model selection because saved agents are
 * effectively composer-scoped model presets.
 */
export function TurnControls({
  modelId,
  models,
  onModelChange,
  agentId,
  agents,
  onAgentChange,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
  keyStatus,
  codexStatus,
  claudeCodeStatus,
  cursorStatus,
  workspace,
  onPickWorkspace
}: {
  modelId: string
  models: ModelOption[]
  onModelChange: (id: string) => void
  agentId: string | null
  agents: SavedAgent[]
  onAgentChange: (id: string | null) => void
  onCreateAgent: () => void
  onEditAgent: (agent: SavedAgent) => void
  onDeleteAgent: (agent: SavedAgent) => void
  keyStatus: KeyStatus
  codexStatus: CodexStatus | null
  claudeCodeStatus: ClaudeCodeStatus | null
  cursorStatus: CursorStatus | null
  workspace: Workspace
  onPickWorkspace: () => void
}) {
  const folderLabel = workspace.folder
    ? workspace.folder.split('/').filter(Boolean).slice(-2).join('/')
    : null
  return (
    <div className="composer-turn-controls">
      <ModelPicker
        value={modelId}
        onChange={onModelChange}
        agentId={agentId}
        agents={agents}
        onAgentChange={onAgentChange}
        onCreateAgent={onCreateAgent}
        onEditAgent={onEditAgent}
        onDeleteAgent={onDeleteAgent}
        models={models}
        keyStatus={keyStatus}
        codexStatus={codexStatus}
        claudeCodeStatus={claudeCodeStatus}
        cursorStatus={cursorStatus}
      />
      <button
        className={`workspace-btn ${workspace.folder ? 'set' : ''}`}
        title={
          workspace.folder
            ? `Working folder: ${workspace.folder}\nClick to change`
            : 'Choose a folder to work from'
        }
        aria-label="Choose working folder"
        onClick={onPickWorkspace}
      >
        <svg width="15" height="15" viewBox="0 0 18 18" fill="none">
          <path
            d="M2.25 5.25A1.5 1.5 0 0 1 3.75 3.75h3l1.5 1.5h6a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V5.25Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        {folderLabel && <span className="workspace-label">{folderLabel}</span>}
      </button>
    </div>
  )
}

/**
 * Chat settings control rendered into the panel's footer slot. Lives outside
 * `<TurnControls>` because the parent portals it into a slot owned by
 * the surrounding layout (one-cog-per-panel).
 */
export function ChatSettingsButton({
  panelLabel,
  open,
  onOpen
}: {
  panelLabel: string
  open: boolean
  onOpen: () => void
}) {
  return (
    <button
      className={`footer-action ${open ? 'is-open' : ''}`}
      title={`${panelLabel} chat settings`}
      aria-label={`${panelLabel} chat settings`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onOpen}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M3.25 5.75A2.75 2.75 0 0 1 6 3h8a2.75 2.75 0 0 1 2.75 2.75v4.5A2.75 2.75 0 0 1 14 13h-2.9l-3.35 2.7a.65.65 0 0 1-1.06-.5V13H6a2.75 2.75 0 0 1-2.75-2.75v-4.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M10 6.65v.9M10 10.45v.9M8.35 7.6l.78.45M10.87 9.95l.78.45M8.35 10.4l.78-.45M10.87 8.05l.78-.45"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <circle cx="10" cy="9" r="1.45" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </button>
  )
}
