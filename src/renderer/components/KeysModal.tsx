import { useState, useEffect } from 'react'
import type { CodexStatus, KeyStatus, Workspace } from '../../../shared/types'

interface Props {
  status: KeyStatus
  onClose: () => void
  onSaved: (status: KeyStatus) => void
  /** Codex install/auth status (probed by the parent); null while loading. */
  codexStatus: CodexStatus | null
}

/** Modal for entering provider API keys + configuring Codex. Keys go straight to
 *  main (KeyStore); this UI only ever knows whether a key is set, never its value.
 *  Codex has no key here — it uses the local `codex` CLI's own login. */
export function KeysModal({ status, onClose, onSaved, codexStatus }: Props) {
  const [anthropic, setAnthropic] = useState('')
  const [google, setGoogle] = useState('')
  const [openai, setOpenai] = useState('')
  const [grok, setGrok] = useState('')
  const [saving, setSaving] = useState(false)
  // Display-only: the working folder is chosen from the chat header (single
  // source of truth). Shown here for context next to Codex's login status.
  const [workspace, setWorkspace] = useState<Workspace | null>(null)

  useEffect(() => {
    void window.gladdis.workspace.get().then(setWorkspace)
  }, [])

  const save = async () => {
    setSaving(true)
    let next = status
    if (anthropic.trim()) next = await window.gladdis.keys.set('anthropic', anthropic.trim())
    if (google.trim()) next = await window.gladdis.keys.set('google', google.trim())
    if (grok.trim()) next = await window.gladdis.keys.set('grok', grok.trim())
    if (openai.trim()) next = await window.gladdis.keys.set('openai', openai.trim())
    setSaving(false)
    onSaved(next)
    onClose()
  }

  const codexLine = () => {
    if (!codexStatus) return 'Checking…'
    if (!codexStatus.installed) return 'Not installed — run npm i -g @openai/codex'
    if (!codexStatus.authenticated) return 'Installed, not logged in — run codex login'
    const v = codexStatus.version ? ` v${codexStatus.version}` : ''
    return `Ready${v} · signed in via ${codexStatus.authMethod ?? 'CLI'}`
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>API keys</span>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            <span className="modal-label">
              Anthropic
              <span className={`key-pill ${status.anthropic ? 'set' : ''}`}>
                {status.anthropic ? 'set' : 'not set'}
              </span>
            </span>
            <input
              type="password"
              placeholder="sk-ant-…"
              value={anthropic}
              onChange={(e) => setAnthropic(e.target.value)}
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">
              Google (Gemini)
              <span className={`key-pill ${status.google ? 'set' : ''}`}>
                {status.google ? 'set' : 'not set'}
              </span>
            </span>
            <input
              type="password"
              placeholder="AIza…"
              value={google}
              onChange={(e) => setGoogle(e.target.value)}
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">
              Grok (xAI)
              <span className={`key-pill ${status.grok ? 'set' : ''}`}>
                {status.grok ? 'set' : 'not set'}
              </span>
            </span>
            <input
              type="password"
              placeholder="xai-…"
              value={grok}
              onChange={(e) => setGrok(e.target.value)}
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">
              OpenAI (audible replies)
              <span className={`key-pill ${status.openai ? 'set' : ''}`}>
                {status.openai ? 'set' : 'not set'}
              </span>
            </span>
            <input
              type="password"
              placeholder="sk-…"
              value={openai}
              onChange={(e) => setOpenai(e.target.value)}
            />
            <p className="modal-note" style={{ margin: '4px 0 0' }}>
              Only used for text-to-speech when the composer’s audio toggle is on. Not used for chat.
            </p>
          </label>

          <div className="modal-field">
            <span className="modal-label">
              OpenAI Codex
              <span
                className={`key-pill ${codexStatus?.installed && codexStatus?.authenticated ? 'set' : ''}`}
              >
                {codexStatus?.installed && codexStatus?.authenticated ? 'ready' : 'setup'}
              </span>
            </span>
            <p className="modal-note" style={{ margin: '4px 0 8px' }}>
              Codex uses the local <code>codex</code> CLI and its own login (no key here). {codexLine()}
            </p>
            <div className="codex-workspace">
              <div className="codex-folder">
                {workspace?.folder ? (
                  <>
                    <strong>Folder:</strong> <code>{workspace.folder}</code>
                    <div className="modal-note">
                      starting folder only · full read/write OS access stays enabled
                    </div>
                  </>
                ) : (
                  <div className="modal-note">
                    No folder set — Codex starts from home with <strong>full access</strong>.
                    Choose a starting folder from the folder button in the chat header.
                  </div>
                )}
              </div>
            </div>
          </div>

          <p className="modal-note">
            Keys are stored encrypted on this device (OS keychain) and never leave the main
            process. Environment variables <code>ANTHROPIC_API_KEY</code> /{' '}
            <code>GEMINI_API_KEY</code> / <code>XAI_API_KEY</code> / <code>OPENAI_API_KEY</code> are
            used automatically if set.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
