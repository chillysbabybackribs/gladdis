import { useEffect, useMemo, useState } from 'react'
import { useEnvironmentStatus } from '../hooks/useEnvironmentStatus'
import type { ModelOption } from '../../../shared/models'
import type { SavedAgent } from '../../../shared/types'

interface AgentBuilderModalProps {
  isOpen: boolean
  agent?: SavedAgent | null
  onClose: () => void
}

function isModelUsable(model: ModelOption, keyStatus: ReturnType<typeof useEnvironmentStatus>['keyStatus'], codexStatus: ReturnType<typeof useEnvironmentStatus>['codexStatus']): boolean {
  if (!keyStatus) return false
  switch (model.provider) {
    case 'codex':
      return !!codexStatus?.installed && !!codexStatus?.authenticated
    case 'anthropic':
      return keyStatus.anthropic
    case 'google':
      return keyStatus.google
    case 'openai':
      return keyStatus.openai
    case 'grok':
      return keyStatus.grok
    default:
      return false
  }
}

export default function AgentBuilderModal({ isOpen, agent = null, onClose }: AgentBuilderModalProps) {
  const { models, keyStatus, codexStatus, workspace } = useEnvironmentStatus()
  const availableModels = useMemo(
    () => models.filter((model) => isModelUsable(model, keyStatus, codexStatus)),
    [models, keyStatus, codexStatus]
  )

  const [agentName, setAgentName] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [roughPrompt, setRoughPrompt] = useState('')
  const [optimizedPrompt, setOptimizedPrompt] = useState('')
  const [testTask, setTestTask] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editing = !!agent

  useEffect(() => {
    if (!isOpen) return
    setAgentName(agent?.name ?? '')
    setSelectedModel(agent?.modelId ?? '')
    setRoughPrompt(agent?.roughPrompt ?? '')
    setOptimizedPrompt(agent?.prompt ?? '')
    setTestTask(agent?.testTask ?? '')
    setSaving(false)
    setError(null)
  }, [agent, isOpen])

  if (!isOpen) return null

  const canSave = agentName.trim().length > 0 && selectedModel.trim().length > 0 && optimizedPrompt.trim().length > 0

  const handleGenerateDraft = () => {
    const trimmed = roughPrompt.trim()
    if (!trimmed) return
    const generated = [
      'You are a specialized workspace agent operating inside the current project directory.',
      '',
      'Primary objective:',
      trimmed,
      '',
      'Working style:',
      '- Inspect the current repository before making changes.',
      '- Prefer small, verifiable edits.',
      '- Explain important tradeoffs and risks.',
      '- Validate changes with the most relevant check before finishing.',
      workspace.folder ? `- Treat the active workspace as: ${workspace.folder}` : '- Use the active workspace as the execution context.',
      '',
      'Output expectations:',
      '- State the plan briefly before acting.',
      '- Summarize what changed and how it was verified.'
    ].join('\n')
    setOptimizedPrompt(generated)
  }

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    setError(null)
    try {
      await window.gladdis.agents.save({
        id: agent?.id,
        name: agentName.trim(),
        modelId: selectedModel,
        roughPrompt: roughPrompt.trim(),
        prompt: optimizedPrompt.trim(),
        testTask: testTask.trim()
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <div>
            <h2 style={titleStyle}>{editing ? 'Edit Agent' : 'Create an Agent'}</h2>
            <p style={subtitleStyle}>{editing ? 'Update this agent while keeping its saved identity.' : 'Build an agent around a currently available model and the active workspace.'}</p>
          </div>
          <button type="button" onClick={onClose} style={closeButtonStyle}>
            ✕
          </button>
        </div>

        <div style={bodyStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>Agent name</span>
            <input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="UI bug fixer" style={inputStyle} />
          </label>

          <label style={fieldStyle}>
            <span style={labelStyle}>Available model</span>
            <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} style={inputStyle}>
              <option value="">Select a usable model...</option>
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.provider})
                </option>
              ))}
            </select>
            {availableModels.length === 0 ? <span style={hintStyle}>No models are currently available. Add an API key or connect Codex first.</span> : null}
          </label>

          <label style={fieldStyle}>
            <span style={labelStyle}>Rough agent goal</span>
            <textarea
              value={roughPrompt}
              onChange={(event) => setRoughPrompt(event.target.value)}
              placeholder="Example: Create an agent that fixes failing frontend builds, explains the root cause, and keeps changes minimal."
              style={textareaStyle}
              rows={5}
            />
          </label>

          <div style={buttonRowStyle}>
            <button
              type="button"
              onClick={handleGenerateDraft}
              style={buttonStyle(!roughPrompt.trim())}
              disabled={!roughPrompt.trim()}
            >
              Generate Draft Prompt
            </button>
          </div>

          <label style={fieldStyle}>
            <span style={labelStyle}>Editable agent prompt</span>
            <textarea value={optimizedPrompt} onChange={(event) => setOptimizedPrompt(event.target.value)} style={textareaStyle} rows={10} />
          </label>

          <label style={fieldStyle}>
            <span style={labelStyle}>Test task</span>
            <textarea
              value={testTask}
              onChange={(event) => setTestTask(event.target.value)}
              placeholder="Example: Inspect the repo and propose the smallest fix for the current failing build."
              style={textareaStyle}
              rows={4}
            />
          </label>
          {error ? <div style={errorStyle}>{error}</div> : null}
        </div>

        <div style={footerStyle}>
          <button type="button" onClick={onClose} style={buttonStyle(false)}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} style={primaryButtonStyle(!canSave || saving)} disabled={!canSave || saving}>
            {saving ? 'Saving...' : editing ? 'Update Agent' : 'Save Agent'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.68)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24
}

const modalStyle: React.CSSProperties = {
  width: 'min(860px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  boxShadow: '0 20px 70px rgba(0,0,0,0.62)'
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  padding: '20px 24px 14px',
  borderBottom: '1px solid var(--border-subtle)'
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700
}

const subtitleStyle: React.CSSProperties = {
  margin: '6px 0 0',
  color: 'var(--text-secondary)',
  fontSize: 14
}

const closeButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 20
}

const bodyStyle: React.CSSProperties = {
  padding: '18px 24px 20px',
  display: 'grid',
  gap: 16
}

const fieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-secondary)'
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  background: '#181818',
  color: 'var(--text-primary)',
  outline: 'none'
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  fontFamily: 'inherit'
}

const hintStyle: React.CSSProperties = {
  color: '#fca5a5',
  fontSize: 12
}

const errorStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  color: '#f5f5f5',
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  fontSize: 13
}

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-start'
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 12,
  padding: '16px 24px 24px',
  borderTop: '1px solid var(--border-subtle)'
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  cursor: 'pointer'
}

const buttonStyle = (disabled: boolean): React.CSSProperties => ({
  ...secondaryButtonStyle,
  opacity: disabled ? 0.48 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer'
})

const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  ...buttonStyle(disabled),
  background: disabled ? 'var(--bg-elevated)' : '#0f0f0f',
  border: disabled ? '1px solid var(--border-subtle)' : '1px solid #4a4a4a',
  boxShadow: disabled ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.08)'
})
