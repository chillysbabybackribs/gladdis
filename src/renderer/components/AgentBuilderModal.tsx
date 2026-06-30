import { useEffect, useMemo, useState } from 'react'
import { useEnvironmentStatus } from '../hooks/useEnvironmentStatus'
import type { ModelOption } from '../../../shared/models'
import type { SavedAgent, SavedAgentBlueprint } from '../../../shared/types'

interface AgentBuilderModalProps {
  isOpen: boolean
  agent?: SavedAgent | null
  onClose: () => void
}

function formatListText(value?: string[]): string {
  const items = value?.map((entry) => entry.trim()).filter(Boolean) ?? []
  return items.length > 0 ? items.join('\n') : 'Not available yet.'
}

function formatBooleanText(value?: boolean): string {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  return 'Auto'
}

function isModelUsable(
  model: ModelOption,
  keyStatus: ReturnType<typeof useEnvironmentStatus>['keyStatus'],
  codexStatus: ReturnType<typeof useEnvironmentStatus>['codexStatus'],
  claudeCodeStatus: ReturnType<typeof useEnvironmentStatus>['claudeCodeStatus']
): boolean {
  if (!keyStatus) return false
  switch (model.provider) {
    case 'codex':
      return !!codexStatus?.installed && !!codexStatus?.authenticated
    case 'claudecode':
      return !!claudeCodeStatus?.installed && !!claudeCodeStatus?.authenticated
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

function buildLocalDraft(goal: string, workspaceFolder: string | null): string {
  return [
    'You are a specialized task expert inside Gladdis.',
    '',
    'Primary objective:',
    goal,
    '',
    'Operating principles:',
    '- Optimize for direct completion of the task at the highest practical quality.',
    '- Spend the fewest tokens that still preserve correctness, useful context, and verification.',
    '- Do not rediscover context that is already known. Use exact paths, commands, APIs, product facts, and acceptance checks when they are provided.',
    '- Ask for or gather missing context only when it is necessary to complete the task safely.',
    '- Keep changes and recommendations scoped to the user goal.',
    '- Validate the result with the most relevant available check before finishing.',
    workspaceFolder ? `- Treat the active workspace as: ${workspaceFolder}` : '- If no workspace is selected, operate as a portable expert for this task family.',
    '',
    'Output contract:',
    '- State only the plan detail needed for execution.',
    '- Report the result, important tradeoffs, and verification.'
  ].join('\n')
}

export default function AgentBuilderModal({ isOpen, agent = null, onClose }: AgentBuilderModalProps) {
  const { models, keyStatus, codexStatus, claudeCodeStatus, workspace } = useEnvironmentStatus()
  const availableModels = useMemo(
    () => models.filter((model) => isModelUsable(model, keyStatus, codexStatus, claudeCodeStatus)),
    [models, keyStatus, codexStatus, claudeCodeStatus]
  )

  const [agentName, setAgentName] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [roughPrompt, setRoughPrompt] = useState('')
  const [optimizedPrompt, setOptimizedPrompt] = useState('')
  const [testTask, setTestTask] = useState('')
  const [contextSummary, setContextSummary] = useState('')
  const [optimizationMode, setOptimizationMode] = useState<'quick' | 'deep'>('quick')
  const [optimizing, setOptimizing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [optimizerFallbackNotice, setOptimizerFallbackNotice] = useState('')
  const [blueprintMetadata, setBlueprintMetadata] = useState<SavedAgentBlueprint>({})
  const editing = !!agent

  useEffect(() => {
    if (!isOpen) return
    setAgentName(agent?.name ?? '')
    setSelectedModel(agent?.modelId ?? '')
    setRoughPrompt(agent?.roughPrompt ?? '')
    setOptimizedPrompt(agent?.prompt ?? '')
    setTestTask(agent?.testTask ?? '')
    setBlueprintMetadata({
      goal: agent?.goal,
      optimizerModelId: agent?.optimizerModelId,
      runtimeModelId: agent?.runtimeModelId,
      taskFamily: agent?.taskFamily,
      workspaceBound: agent?.workspaceBound,
      preferredTools: agent?.preferredTools,
      disallowedTools: agent?.disallowedTools,
      knownPaths: agent?.knownPaths,
      knownCommands: agent?.knownCommands,
      workflowSteps: agent?.workflowSteps,
      verificationSteps: agent?.verificationSteps,
      stopConditions: agent?.stopConditions,
      fallbackRules: agent?.fallbackRules,
      assumptions: agent?.assumptions,
      testTasks: agent?.testTasks,
      optimizationSummary: agent?.optimizationSummary,
      evidenceNotes: agent?.evidenceNotes,
      validationNotes: agent?.validationNotes
    })
    setContextSummary('')
    setOptimizerFallbackNotice('')
    setOptimizing(false)
    setSaving(false)
    setError(null)
  }, [agent, isOpen])

  if (!isOpen) return null

  const canSave = agentName.trim().length > 0 && selectedModel.trim().length > 0 && optimizedPrompt.trim().length > 0
  const validationNotes = blueprintMetadata.validationNotes ?? []
  const hasBlueprintMetadata = Boolean(
    blueprintMetadata.goal ||
      blueprintMetadata.taskFamily ||
      blueprintMetadata.optimizerModelId ||
      blueprintMetadata.runtimeModelId ||
      typeof blueprintMetadata.workspaceBound !== 'undefined' ||
      blueprintMetadata.preferredTools?.length ||
      blueprintMetadata.disallowedTools?.length ||
      blueprintMetadata.knownPaths?.length ||
      blueprintMetadata.knownCommands?.length ||
      blueprintMetadata.workflowSteps?.length ||
      blueprintMetadata.verificationSteps?.length ||
      blueprintMetadata.stopConditions?.length ||
      blueprintMetadata.fallbackRules?.length ||
      blueprintMetadata.assumptions?.length ||
      blueprintMetadata.testTasks?.length ||
      blueprintMetadata.optimizationSummary?.trim() ||
      blueprintMetadata.evidenceNotes?.length
  )

  const handleGenerateDraft = async () => {
    const trimmed = roughPrompt.trim()
    if (!trimmed || optimizing) return

    const requestedModelId = selectedModel.trim() || availableModels[0]?.id || ''
    if (!requestedModelId) {
      setOptimizedPrompt(buildLocalDraft(trimmed, workspace.folder))
      setTestTask(`Use this agent to complete: ${trimmed}`)
      setContextSummary(workspace.folder ? `Used active workspace: ${workspace.folder}` : 'No workspace context was available.')
      return
    }

    setOptimizing(true)
    setError(null)
    setOptimizerFallbackNotice('')
    try {
      if (!selectedModel.trim()) setSelectedModel(requestedModelId)
      const result = await window.gladdis.agents.optimize({
        name: agentName,
        modelId: requestedModelId,
        roughPrompt: trimmed,
        optimizationMode,
        workspaceRoot: workspace.folder,
        existingAgent: agent
      })
      if (!agentName.trim() && result.name) setAgentName(result.name)
      if (result.modelId && result.modelId !== requestedModelId) {
        setSelectedModel(result.modelId)
        setOptimizerFallbackNotice(`Optimizer used ${result.modelId} instead of ${requestedModelId}.`)
      }
      setOptimizedPrompt(result.prompt)
      setTestTask(result.testTask)
      setBlueprintMetadata((previous) => ({ ...previous, ...result }))
      setContextSummary(result.contextSummary ?? '')
    } catch (err) {
      setOptimizedPrompt(buildLocalDraft(trimmed, workspace.folder))
      setTestTask(`Use this agent to complete: ${trimmed}`)
      setContextSummary(workspace.folder ? `Used active workspace: ${workspace.folder}` : 'No workspace context was available.')
      setError(`Used a local draft because optimization failed: ${err instanceof Error ? err.message : String(err)}`)
      setBlueprintMetadata((previous) => ({ ...previous, validationNotes: [] }))
    } finally {
      setOptimizing(false)
    }
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
        goal: blueprintMetadata.goal ?? roughPrompt.trim(),
        optimizerModelId: blueprintMetadata.optimizerModelId,
        runtimeModelId: blueprintMetadata.runtimeModelId,
        taskFamily: blueprintMetadata.taskFamily,
        workspaceBound: blueprintMetadata.workspaceBound,
        preferredTools: blueprintMetadata.preferredTools,
        disallowedTools: blueprintMetadata.disallowedTools,
        knownPaths: blueprintMetadata.knownPaths,
        knownCommands: blueprintMetadata.knownCommands,
        workflowSteps: blueprintMetadata.workflowSteps,
        verificationSteps: blueprintMetadata.verificationSteps,
        stopConditions: blueprintMetadata.stopConditions,
        fallbackRules: blueprintMetadata.fallbackRules,
        assumptions: blueprintMetadata.assumptions,
        testTasks: blueprintMetadata.testTasks,
        optimizationSummary: blueprintMetadata.optimizationSummary,
        evidenceNotes: blueprintMetadata.evidenceNotes,
        validationNotes: blueprintMetadata.validationNotes,
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
            <div style={modeToggleStyle} aria-label="Optimization mode">
              <button
                type="button"
                onClick={() => setOptimizationMode('quick')}
                style={optimizationModeButtonStyle(optimizationMode === 'quick')}
              >
                Quick
              </button>
              <button
                type="button"
                onClick={() => setOptimizationMode('deep')}
                style={optimizationModeButtonStyle(optimizationMode === 'deep')}
              >
                Deep
              </button>
            </div>
            <span style={modeHintStyle}>
              {optimizationMode === 'deep'
                ? 'Deep mode runs search, read spans, and dossier synthesis.'
                : 'Quick mode runs a compact workspace summary only.'}
            </span>
          </div>

          <div style={buttonRowStyle}>
            <button
              type="button"
              onClick={handleGenerateDraft}
              style={buttonStyle(!roughPrompt.trim() || optimizing)}
              disabled={!roughPrompt.trim() || optimizing}
            >
              {optimizing
                ? 'Optimizing...'
                : optimizationMode === 'deep'
                  ? 'Deep Optimize'
                  : 'Optimize'}
            </button>
          </div>
          {contextSummary ? <div style={contextSummaryStyle}>{contextSummary}</div> : null}
          {validationNotes.length > 0 ? (
            <div style={validationNoteStyle}>
              <div>Blueprint validation notes:</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {validationNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {optimizerFallbackNotice ? <div style={fallbackNoticeStyle}>{optimizerFallbackNotice}</div> : null}
          {hasBlueprintMetadata ? (
            <details style={detailsStyle}>
              <summary style={summaryStyle}>Automated blueprint (review only)</summary>
              <div style={detailsBodyStyle}>
                <div style={twoColumnStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Goal</span>
                    <div style={readOnlyTextStyle}>{blueprintMetadata.goal || 'Not available yet.'}</div>
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Task family</span>
                    <div style={readOnlyTextStyle}>{blueprintMetadata.taskFamily || 'Not available yet.'}</div>
                  </label>
                </div>
                <div style={twoColumnStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Workspace-bound</span>
                    <div style={readOnlyTextStyle}>{formatBooleanText(blueprintMetadata.workspaceBound)}</div>
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Model IDs</span>
                    <div style={readOnlyTextStyle}>
                      Optimizer: {blueprintMetadata.optimizerModelId || 'Not available yet.'}
                      <br />
                      Runtime: {blueprintMetadata.runtimeModelId || 'Not available yet.'}
                    </div>
                  </label>
                </div>
                <div style={twoColumnStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Preferred tools</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.preferredTools)}</pre>
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Disallowed tools</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.disallowedTools)}</pre>
                  </label>
                </div>
                <div style={twoColumnStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Known paths</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.knownPaths)}</pre>
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Known commands</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.knownCommands)}</pre>
                  </label>
                </div>
                <div style={twoColumnStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Workflow steps</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.workflowSteps)}</pre>
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Verification steps</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.verificationSteps)}</pre>
                  </label>
                </div>
                <div style={twoColumnStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Stop conditions</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.stopConditions)}</pre>
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Fallback rules</span>
                    <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.fallbackRules)}</pre>
                  </label>
                </div>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Assumptions</span>
                  <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.assumptions)}</pre>
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Additional test tasks</span>
                  <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.testTasks)}</pre>
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Optimization summary</span>
                  <div style={readOnlyTextStyle}>{blueprintMetadata.optimizationSummary || 'Not available yet.'}</div>
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Evidence notes</span>
                  <pre style={readOnlyCodeStyle}>{formatListText(blueprintMetadata.evidenceNotes)}</pre>
                </label>
              </div>
            </details>
          ) : null}

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

const twoColumnStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 16
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

const detailsStyle: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: '10px 12px'
}

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-secondary)'
}

const detailsBodyStyle: React.CSSProperties = {
  marginTop: 10,
  display: 'grid',
  gap: 12
}

const readOnlyTextStyle: React.CSSProperties = {
  ...inputStyle,
  background: '#121212',
  color: 'var(--text-secondary)',
  minHeight: 36,
  display: 'block',
  whiteSpace: 'pre-wrap'
}

const readOnlyCodeStyle: React.CSSProperties = {
  ...readOnlyTextStyle,
  overflow: 'auto',
  margin: 0,
  padding: '8px 10px',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
}

const hintStyle: React.CSSProperties = {
  color: '#fca5a5',
  fontSize: 12
}

const contextSummaryStyle: React.CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  background: 'rgba(255, 255, 255, 0.04)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.4
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

const modeToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  overflow: 'hidden'
}

const optimizationModeButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: '10px 12px',
  border: 'none',
  borderRight: '1px solid var(--border-subtle)',
  background: active ? '#262626' : 'transparent',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: 13
})

const modeHintStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 12,
  alignSelf: 'center'
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

const validationNoteStyle: React.CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  background: 'rgba(255, 255, 255, 0.04)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.4
}

const fallbackNoticeStyle: React.CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  background: 'rgba(72, 201, 176, 0.08)',
  color: '#86efac',
  fontSize: 12
}
