import { useEffect, useState } from 'react'
import type {
  CodexStatus,
  KeyStatus,
  ModelOption,
  Workspace
} from '../../../shared/types'
import { MODELS } from '../../../shared/types'

/**
 * Environment snapshot used by the chat panel: which API keys are present,
 * whether Codex is installed/authenticated, the union of static + Codex-
 * sourced models, and the currently selected workspace folder.
 *
 * This snapshot is read-mostly per panel — fetched once at mount and
 * mutated in place via the returned setters when user actions (saving keys,
 * picking a folder) need to refresh state without a roundtrip.
 */
export interface EnvironmentStatus {
  keyStatus: KeyStatus
  setKeyStatus: (next: KeyStatus) => void
  codexStatus: CodexStatus | null
  models: ModelOption[]
  workspace: Workspace
  setWorkspace: (next: Workspace) => void
  pickWorkspace: () => Promise<void>
}

export function useEnvironmentStatus(): EnvironmentStatus {
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({
    anthropic: false,
    google: false,
    codex: false,
    openai: false,
    grok: false
  })
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [models, setModels] = useState<ModelOption[]>(MODELS)
  const [workspace, setWorkspace] = useState<Workspace>({ folder: null })

  useEffect(() => {
    void Promise.all([
      window.gladdis.keys.status(),
      window.gladdis.workspace.get(),
      window.gladdis.codex.status().catch(() => null), // Handle potential error for codex.status
      window.gladdis.codex.models().catch(() => []) // Handle potential error for codex.models
    ]).then(([keyStatus, workspace, codexStatus, codexModels]) => {
      setKeyStatus(keyStatus)
      setWorkspace(workspace)
      setCodexStatus(codexStatus)
      if (codexModels.length) {
        const nonCodex = MODELS.filter((m) => m.provider !== 'codex')
        setModels([...nonCodex, ...codexModels])
      }
    })

    const offWorkspace = window.gladdis.workspace.onUpdated(setWorkspace)
    return () => offWorkspace()
  }, [])

  const pickWorkspace = async () => {
    const ws = await window.gladdis.workspace.pickFolder()
    setWorkspace(ws)
  }

  return { keyStatus, setKeyStatus, codexStatus, models, workspace, setWorkspace, pickWorkspace }
}
