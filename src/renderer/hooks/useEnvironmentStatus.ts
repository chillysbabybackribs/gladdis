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
    void window.gladdis.keys.status().then(setKeyStatus)
    void window.gladdis.workspace.get().then(setWorkspace)
    void window.gladdis.codex.status().then(setCodexStatus).catch(() => setCodexStatus(null))
    void window.gladdis.codex
      .models()
      .then((codexModels) => {
        if (!codexModels.length) return
        const nonCodex = MODELS.filter((m) => m.provider !== 'codex')
        setModels([...nonCodex, ...codexModels])
      })
      .catch(() => {
        /* keep static fallback */
      })
  }, [])

  const pickWorkspace = async () => {
    const ws = await window.gladdis.workspace.pickFolder()
    setWorkspace(ws)
  }

  return { keyStatus, setKeyStatus, codexStatus, models, workspace, setWorkspace, pickWorkspace }
}
