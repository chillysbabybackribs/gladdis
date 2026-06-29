import type { CodexStatus, KeyStatus, ModelOption, Workspace } from '../../../../shared/types'
import { MemoryButton } from '../MemoryButton'
import { ModelPicker } from '../ModelPicker'

/**
 * Top-of-composer controls: model picker + workspace folder chip.
 * The chip's title flips between "click to change" and the prompt to pick
 * a folder so first-time users discover the affordance without explanation.
 */
export function TurnControls({
  modelId,
  models,
  onModelChange,
  keyStatus,
  codexStatus,
  workspace,
  onPickWorkspace
}: {
  modelId: string
  models: ModelOption[]
  onModelChange: (id: string) => void
  keyStatus: KeyStatus
  codexStatus: CodexStatus | null
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
        models={models}
        keyStatus={keyStatus}
        codexStatus={codexStatus}
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
      <MemoryButton workspace={workspace} />
    </div>
  )
}

/**
 * Settings cog rendered into the panel's footer slot. Lives outside
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
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M9 6.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <path
          d="M9 2.8v1.55M9 13.65v1.55M3.62 5.9l1.35.78M13.03 11.32l1.35.78M3.62 12.1l1.35-.78M13.03 6.68l1.35-.78"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
