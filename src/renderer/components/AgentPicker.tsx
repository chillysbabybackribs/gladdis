import { useEffect, useRef, useState } from 'react'
import type { SavedAgent } from '../../../shared/types'

interface Props {
  value: string | null
  agents: SavedAgent[]
  onChange: (agentId: string | null) => void
  onEdit: (agent: SavedAgent) => void
  onDelete: (agentId: string) => Promise<void>
}

export function AgentPicker({ value, agents, onChange, onEdit, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const current = agents.find((agent) => agent.id === value) ?? null

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const deleteAgent = async (agent: SavedAgent) => {
    if (deletingId) return
    const ok = window.confirm(`Delete agent "${agent.name}"?`)
    if (!ok) return

    setDeleteError(null)
    setDeletingId(agent.id)
    try {
      await onDelete(agent.id)
      if (agent.id === value) onChange(null)
    } catch (error) {
      console.warn('Failed to delete agent:', error)
      setDeleteError('Could not delete agent')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="agent-picker" ref={ref}>
      <button
        type="button"
        className={`agent-picker-btn ${current ? 'set' : ''} ${open ? 'open' : ''}`}
        onClick={() => setOpen((next) => !next)}
        title={current ? `Agent: ${current.name}` : 'Select saved agent'}
      >
        <span>{current?.name ?? 'Agent'}</span>
      </button>
      {open && (
        <div className="agent-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!current}
            className={`agent-menu-item ${!current ? 'sel' : ''}`}
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
          >
            <span className="agent-menu-label">No custom agent</span>
          </button>
          {agents.map((agent) => (
            <div key={agent.id} className={`agent-menu-row ${agent.id === value ? 'sel' : ''}`}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={agent.id === value}
                className="agent-menu-item"
                onClick={() => {
                  onChange(agent.id)
                  setOpen(false)
                }}
              >
                <span className="agent-menu-label">{agent.name}</span>
              </button>
              <button
                type="button"
                className="agent-menu-action"
                title={`Edit ${agent.name}`}
                aria-label={`Edit ${agent.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onEdit(agent)
                  setOpen(false)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path
                    d="m4.25 12.85-.35 1.7 1.7-.35 7.05-7.05-1.35-1.35-7.05 7.05Zm8.95-6.25.55-.55a1.05 1.05 0 0 0 0-1.5l-.3-.3a1.05 1.05 0 0 0-1.5 0l-.55.55"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="agent-menu-action agent-menu-delete"
                title={`Delete ${agent.name}`}
                aria-label={`Delete ${agent.name}`}
                disabled={deletingId === agent.id}
                onClick={(event) => {
                  event.stopPropagation()
                  void deleteAgent(agent)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path
                    d="M3.75 5.25h10.5M7.5 5.25v-1.5h3v1.5m-5.25 0 .65 8.5a1.5 1.5 0 0 0 1.5 1.35h3.2a1.5 1.5 0 0 0 1.5-1.35l.65-8.5"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ))}
          {deleteError && <div className="agent-menu-error">{deleteError}</div>}
        </div>
      )}
    </div>
  )
}
