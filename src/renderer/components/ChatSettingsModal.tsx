import { useEffect, useState } from 'react'
import type {
  ChatPanelSide,
  ClaudeCodeStatus,
  CodexStatus,
  ConversationMeta,
  CursorStatus,
  ConversationSearchHit,
  KeyStatus,
  ModelCallRecord,
  PhoneBridgeStatus,
  Workspace
} from '../../../shared/types'

type Tab = 'history' | 'keys' | 'phone' | 'calls'

interface Props {
  auditRecords: ModelCallRecord[]
  codexStatus: CodexStatus | null
  claudeCodeStatus: ClaudeCodeStatus | null
  cursorStatus: CursorStatus | null
  currentId: string | null
  initialTab?: Tab
  keyStatus: KeyStatus
  /** History list + search are scoped to this side so chats stay where they were created. */
  panel: ChatPanelSide
  refreshKey: number
  onClose: () => void
  onKeysSaved: (status: KeyStatus) => void
  onPickHistory: (id: string) => void
  onContinueHistory: (id: string) => void
}

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function ChatSettingsModal({
  auditRecords,
  codexStatus,
  claudeCodeStatus,
  cursorStatus,
  currentId,
  initialTab = 'history',
  keyStatus,
  panel,
  refreshKey,
  onClose,
  onKeysSaved,
  onPickHistory,
  onContinueHistory
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [items, setItems] = useState<ConversationMeta[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<ConversationSearchHit[]>([])
  const [anthropic, setAnthropic] = useState('')
  const [google, setGoogle] = useState('')
  const [openai, setOpenai] = useState('')
  const [grok, setGrok] = useState('')
  const [saving, setSaving] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [phoneStatus, setPhoneStatus] = useState<PhoneBridgeStatus | null>(null)
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [phoneInstallUrl, setPhoneInstallUrl] = useState<string | null>(null)
  const totals = auditRecords.reduce(
    (acc, r) => {
      acc.calls += 1
      acc.in += r.inputTokensActual ?? r.inputTokensEstimate
      acc.out += r.outputTokensActual ?? r.outputTokensEstimate
      return acc
    },
    { calls: 0, in: 0, out: 0 }
  )

  useEffect(() => {
    void window.gladdis.chats.list(panel).then(setItems)
  }, [refreshKey, panel])
  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) {
      setSearchHits([])
      return
    }
    void window.gladdis.chats.search(query, 8, panel).then(setSearchHits)
  }, [searchQuery, panel])
  useEffect(() => {
    void window.gladdis.workspace.get().then(setWorkspace)
  }, [])
  useEffect(() => {
    void window.gladdis.phone.status().then(setPhoneStatus)
  }, [])

  const remove = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation()
    await window.gladdis.chats.delete(id)
    setItems((cur) => cur.filter((c) => c.id !== id))
  }
  const saveKeys = async () => {
    setSaving(true)
    let next = keyStatus
    if (anthropic.trim()) next = await window.gladdis.keys.set('anthropic', anthropic.trim())
    if (google.trim()) next = await window.gladdis.keys.set('google', google.trim())
    if (grok.trim()) next = await window.gladdis.keys.set('grok', grok.trim())
    if (openai.trim()) next = await window.gladdis.keys.set('openai', openai.trim())
    setSaving(false)
    onKeysSaved(next)
    setAnthropic('')
    setGoogle('')
    setGrok('')
    setOpenai('')
  }
  const refreshPhone = async () => {
    setPhoneStatus(await window.gladdis.phone.status())
  }
  const startPhone = async (host?: string) => {
    setPhoneBusy(true)
    setPhoneError(null)
    try {
      setPhoneStatus(await window.gladdis.phone.start(host ? { host } : undefined))
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : String(err))
      await refreshPhone()
    } finally {
      setPhoneBusy(false)
    }
  }
  const stopPhone = async () => {
    setPhoneBusy(true)
    setPhoneError(null)
    try {
      setPhoneStatus(await window.gladdis.phone.stop())
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhoneBusy(false)
    }
  }
  const copyPhoneUrl = async () => {
    const url = phoneInstallUrl ?? phoneStatus?.appUrl
    if (!url) return
    await navigator.clipboard?.writeText(url)
  }
  const pairPhoneDevice = async () => {
    setPhoneBusy(true)
    setPhoneError(null)
    try {
      const result = await window.gladdis.phone.pairDevice()
      setPhoneInstallUrl(result.appUrl)
      setPhoneStatus(await window.gladdis.phone.status())
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhoneBusy(false)
    }
  }
  const revokePhoneDevice = async (deviceId: string) => {
    setPhoneBusy(true)
    setPhoneError(null)
    try {
      setPhoneStatus(await window.gladdis.phone.revokeDevice(deviceId))
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhoneBusy(false)
    }
  }
  const codexLine = !codexStatus
    ? 'Checking...'
    : !codexStatus.installed
      ? 'Not installed - run npm i -g @openai/codex'
      : !codexStatus.authenticated
        ? 'Installed, not logged in - run codex login'
        : `Ready${codexStatus.version ? ` v${codexStatus.version}` : ''}`
  const claudeCodeLine = !claudeCodeStatus
    ? 'Checking...'
    : !claudeCodeStatus.installed
      ? 'Not installed - run npm i -g @anthropic-ai/claude-code'
      : !claudeCodeStatus.authenticated
        ? 'Installed, not logged in - run claude auth login'
        : `Ready${claudeCodeStatus.version ? ` v${claudeCodeStatus.version}` : ''}`
  const cursorLine = !cursorStatus
    ? 'Checking...'
    : !cursorStatus.installed
      ? 'Not installed - install Cursor Agent CLI'
      : !cursorStatus.authenticated
        ? 'Installed, not logged in - run agent login'
        : `Ready${cursorStatus.version ? ` v${cursorStatus.version}` : ''}`

  return (
    <div className="modal-overlay">
      <div className="modal chat-settings-modal">
        <div className="modal-head">
          <span>Chat settings</span>
          <button className="modal-x" onClick={onClose}>
            x
          </button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Chat settings tabs">
          {(['history', 'keys', 'phone', 'calls'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'keys' ? 'API keys' : t === 'phone' ? 'Phone' : t === 'calls' ? 'Model calls' : 'History'}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'history' && (
            <div className="history-pane">
              <input
                className="history-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search saved chats"
              />
              {!searchQuery.trim() ? (
                <div className="history-list">
                  {items.length === 0 ? <div className="history-empty">No saved chats yet.</div> : items.map((c) => (
                    <div key={c.id} className={`history-item ${c.id === currentId ? 'active' : ''}`} onClick={() => onPickHistory(c.id)}>
                      <div className="history-item-main">
                        <div className="history-item-title">{c.title}</div>
                        <div className="history-item-time">{timeAgo(c.updatedAt)}</div>
                      </div>
                      <button className="history-action" onClick={(e) => { e.stopPropagation(); onContinueHistory(c.id) }} title="Continue in new chat">Continue</button>
                      <button className="history-del" onClick={(e) => remove(e, c.id)} title="Delete chat">x</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="history-list">
                  {searchHits.length === 0 ? <div className="history-empty">No matches yet.</div> : searchHits.map((hit) => (
                    <div key={`${hit.conversationId}:${hit.messageIndex}`} className={`history-search-hit ${hit.conversationId === currentId ? 'active' : ''}`}>
                      <button className="history-search-main" onClick={() => onPickHistory(hit.conversationId)}>
                        <div className="history-item-title">{hit.title}</div>
                        <div className="history-item-time">{timeAgo(hit.updatedAt)} · {hit.role}</div>
                        <div className="history-search-excerpt">{hit.excerpt}</div>
                      </button>
                      <div className="history-search-actions">
                        <button className="history-action" onClick={() => onPickHistory(hit.conversationId)}>Open</button>
                        <button className="history-action" onClick={() => onContinueHistory(hit.conversationId)}>Continue</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'keys' && (
            <KeysPane status={keyStatus} codexLine={codexLine} claudeCodeLine={claudeCodeLine} cursorLine={cursorLine} workspace={workspace} saving={saving}
              anthropic={anthropic} google={google} grok={grok} openai={openai} setAnthropic={setAnthropic}
              setGoogle={setGoogle} setGrok={setGrok} setOpenai={setOpenai} onSave={saveKeys} />
          )}
          {tab === 'phone' && (
            <PhonePane
              busy={phoneBusy}
              error={phoneError}
              status={phoneStatus}
              onCopy={copyPhoneUrl}
              onPair={pairPhoneDevice}
              onRefresh={refreshPhone}
              onRevoke={revokePhoneDevice}
              onStartLan={() => startPhone('0.0.0.0')}
              onStartLocal={() => startPhone()}
              onStop={stopPhone}
              installUrl={phoneInstallUrl}
            />
          )}
          {tab === 'calls' && (
            <div className="settings-pane">
              <div className="settings-pane-title">{totals.calls} calls · {fmt(totals.in)} in · {fmt(totals.out)} out</div>
              <div className="settings-audit-list">
                {auditRecords.length === 0 ? <div className="audit-empty">No model calls yet.</div> : auditRecords.map((r) => (
                  <div className={`audit-row ${r.status}`} key={r.id}>
                    <div className="audit-row-top"><span className="audit-stage">{r.stage}</span><span className="audit-status">{r.status}</span></div>
                    <div className="audit-model">{r.provider} · {r.modelId}</div>
                    <div className="audit-metrics"><span>{fmt(r.inputTokensActual ?? r.inputTokensEstimate)} in</span><span>{fmt(r.outputTokensActual ?? r.outputTokensEstimate)} out</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PhonePane(props: {
  busy: boolean
  error: string | null
  status: PhoneBridgeStatus | null
  installUrl: string | null
  onCopy: () => void
  onPair: () => void
  onRefresh: () => void
  onRevoke: (deviceId: string) => void
  onStartLan: () => void
  onStartLocal: () => void
  onStop: () => void
}) {
  const status = props.status
  const running = !!status?.running
  return (
    <div className="settings-pane phone-pane">
      <div className="settings-pane-title">Phone access <span className={`key-pill ${running ? 'set' : ''}`}>{running ? 'running' : 'off'}</span></div>
      <p className="modal-note">
        Start the desktop bridge, then open the install URL from the landing-page phone client or directly in a mobile browser.
      </p>
      {status?.appUrl && (
        <div className="phone-url" title={status.appUrl}>
          {status.appUrl}
        </div>
      )}
      {props.installUrl && (
        <div className="phone-url paired" title={props.installUrl}>
          {props.installUrl}
        </div>
      )}
      <div className="phone-grid">
        <div>
          <span className="modal-label">Host</span>
          <div className="phone-value">{status?.host ?? '127.0.0.1'}</div>
        </div>
        <div>
          <span className="modal-label">Port</span>
          <div className="phone-value">{status?.port ?? 'auto'}</div>
        </div>
      </div>
      {props.error && <div className="phone-error">{props.error}</div>}
      <div className="phone-actions">
        {!running ? (
          <>
            <button className="btn-primary" onClick={props.onStartLocal} disabled={props.busy}>Start local</button>
            <button className="btn-ghost" onClick={props.onStartLan} disabled={props.busy}>Start LAN</button>
          </>
        ) : (
          <>
            <button className="btn-primary" onClick={props.onPair} disabled={props.busy}>Pair phone</button>
            <button className="btn-ghost" onClick={props.onCopy} disabled={!props.installUrl && !status?.appUrl}>Copy URL</button>
            <button className="btn-ghost" onClick={props.onStop} disabled={props.busy}>Stop</button>
          </>
        )}
        <button className="btn-ghost" onClick={props.onRefresh} disabled={props.busy}>Refresh</button>
      </div>
      <div className="phone-devices">
        {(status?.devices.length ?? 0) === 0 ? (
          <div className="phone-device-empty">No paired phones yet.</div>
        ) : status?.devices.map((device) => (
          <div className="phone-device" key={device.id}>
            <div>
              <div className="phone-device-label">{device.label}</div>
              <div className="phone-device-meta">
                {device.lastSeenAt ? `Seen ${timeAgo(device.lastSeenAt)}` : `Paired ${timeAgo(device.createdAt)}`}
              </div>
            </div>
            <button className="btn-ghost" onClick={() => props.onRevoke(device.id)} disabled={props.busy}>Revoke</button>
          </div>
        ))}
      </div>
      <p className="modal-note">
        LAN mode binds to 0.0.0.0 for trusted-network testing. Pairing creates a durable phone token so installed clients reconnect quickly.
      </p>
    </div>
  )
}

function KeysPane(props: {
  anthropic: string; codexLine: string; claudeCodeLine: string; cursorLine: string; google: string; grok: string; openai: string; saving: boolean
  status: KeyStatus; workspace: Workspace | null; onSave: () => void
  setAnthropic: (v: string) => void; setGoogle: (v: string) => void
  setGrok: (v: string) => void; setOpenai: (v: string) => void
}) {
  return (
    <>
      <KeyField label="Anthropic" set={props.status.anthropic} value={props.anthropic} onChange={props.setAnthropic} />
      <KeyField label="Google (Gemini)" set={props.status.google} placeholder="AIza..." value={props.google} onChange={props.setGoogle} />
      <KeyField label="Grok (xAI)" set={props.status.grok} placeholder="xai-..." value={props.grok} onChange={props.setGrok} />
      <KeyField label="OpenAI (chat & speech)" set={props.status.openai} value={props.openai} onChange={props.setOpenai} />
      <div className="modal-field">
        <span className="modal-label">OpenAI Codex <span className="key-pill set">status</span></span>
        <p className="modal-note">{props.codexLine}</p>
        <p className="modal-note">{props.claudeCodeLine}</p>
        <p className="modal-note">{props.cursorLine}</p>
        <p className="modal-note">{props.workspace?.folder ? props.workspace.folder : 'No working folder set.'}</p>
      </div>
      <button className="btn-primary settings-save" onClick={props.onSave} disabled={props.saving}>
        {props.saving ? 'Saving...' : 'Save keys'}
      </button>
    </>
  )
}

function KeyField({
  label,
  onChange,
  set,
  value,
  placeholder = 'sk-...'
}: {
  label: string
  onChange: (value: string) => void
  set: boolean
  value: string
  placeholder?: string
}) {
  return (
    <label className="modal-field">
      <span className="modal-label">
        {label}
        <span className={`key-pill ${set ? 'set' : ''}`}>{set ? 'set' : 'not set'}</span>
      </span>
      <input type="password" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
