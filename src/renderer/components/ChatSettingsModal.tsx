import { useEffect, useState } from 'react'
import type {
  CodexStatus,
  ConversationMeta,
  ConversationSearchHit,
  KeyStatus,
  ModelCallRecord,
  Workspace
} from '../../../shared/types'

type Tab = 'history' | 'keys' | 'calls'

interface Props {
  auditRecords: ModelCallRecord[]
  codexStatus: CodexStatus | null
  currentId: string | null
  initialTab?: Tab
  keyStatus: KeyStatus
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
  currentId,
  initialTab = 'history',
  keyStatus,
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
    void window.gladdis.chats.list().then(setItems)
  }, [refreshKey])
  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) {
      setSearchHits([])
      return
    }
    void window.gladdis.chats.search(query, 8).then(setSearchHits)
  }, [searchQuery])
  useEffect(() => {
    void window.gladdis.workspace.get().then(setWorkspace)
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
  const codexLine = !codexStatus
    ? 'Checking...'
    : !codexStatus.installed
      ? 'Not installed - run npm i -g @openai/codex'
      : !codexStatus.authenticated
        ? 'Installed, not logged in - run codex login'
        : `Ready${codexStatus.version ? ` v${codexStatus.version}` : ''}`

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
          {(['history', 'keys', 'calls'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'keys' ? 'API keys' : t === 'calls' ? 'Model calls' : 'History'}
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
            <KeysPane status={keyStatus} codexLine={codexLine} workspace={workspace} saving={saving}
              anthropic={anthropic} google={google} grok={grok} openai={openai} setAnthropic={setAnthropic}
              setGoogle={setGoogle} setGrok={setGrok} setOpenai={setOpenai} onSave={saveKeys} />
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

function KeysPane(props: {
  anthropic: string; codexLine: string; google: string; grok: string; openai: string; saving: boolean
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
