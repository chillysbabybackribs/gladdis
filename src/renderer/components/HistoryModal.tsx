import { useEffect, useState } from 'react'
import type { ConversationMeta } from '../../../shared/types'

/** Relative-time label, coarse buckets are plenty for a history list. */
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

interface Props {
  /** Currently loaded conversation, highlighted in the list. */
  currentId: string | null
  onClose: () => void
  onPick: (id: string) => void
  /** Bumped by the parent to force a re-list after a save/new-chat. */
  refreshKey: number
}

/**
 * Modal listing past conversations (newest first). It uses the same shell as
 * the settings modal so overlays stay visually consistent across chat tools.
 */
export function HistoryModal({ currentId, onClose, onPick, refreshKey }: Props) {
  const [items, setItems] = useState<ConversationMeta[]>([])

  useEffect(() => {
    void window.gladdis.chats.list().then(setItems)
  }, [refreshKey])

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await window.gladdis.chats.delete(id)
    setItems((cur) => cur.filter((c) => c.id !== id))
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>History</span>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="history-list">
            {items.length === 0 ? (
              <div className="history-empty">No saved chats yet.</div>
            ) : (
              items.map((c) => (
                <div
                  key={c.id}
                  className={`history-item ${c.id === currentId ? 'active' : ''}`}
                  onClick={() => onPick(c.id)}
                  title={c.title}
                >
                  <div className="history-item-main">
                    <div className="history-item-title">{c.title}</div>
                    <div className="history-item-time">{timeAgo(c.updatedAt)}</div>
                  </div>
                  <button
                    className="history-del"
                    title="Delete chat"
                    aria-label="Delete chat"
                    onClick={(e) => remove(e, c.id)}
                  >
                    🗑
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
