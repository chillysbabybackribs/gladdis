import { useEffect, useRef, useState } from 'react'
import type { CodexStatus, KeyStatus, ModelOption } from '../../../shared/types'

interface Props {
  value: string
  onChange: (modelId: string) => void
  /** The live catalog to render (codex slice may come from the installed CLI). */
  models: ModelOption[]
  keyStatus: KeyStatus
  /** Codex usability (CLI install + login); null while probing. */
  codexStatus: CodexStatus | null
}

/** Small dropdown to pick the active model, grouped by provider. */
export function ModelPicker({ value, onChange, models, keyStatus, codexStatus }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = models.find((m) => m.id === value) ?? models[0]

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Codex is gated on CLI install + login (no key); others on their API key.
  // Switch explicitly on provider so a new key-based provider can't silently
  // inherit another's key status.
  const usable = (m: ModelOption): boolean => {
    switch (m.provider) {
      case 'codex':
        return !!codexStatus?.installed && !!codexStatus?.authenticated
      case 'anthropic':
        return keyStatus.anthropic
      case 'google':
        return keyStatus.google
      case 'grok':
        return keyStatus.grok
      default:
        return false
    }
  }

  // Short pill shown on a disabled item, explaining why it's unavailable.
  const unavailableLabel = (m: ModelOption): string => {
    if (m.provider !== 'codex') return 'no key'
    if (!codexStatus) return '…'
    if (!codexStatus.installed) return 'not installed'
    if (!codexStatus.authenticated) return 'log in'
    return 'no key'
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className={`model-picker-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Select model"
      >
        {current.label}
      </button>
      {open && (
        <div className="model-menu" role="listbox">
          {models.map((m) => {
            const ok = usable(m)
            const speculative = m.availability === 'speculative'
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={m.id === value}
                className={`model-menu-item ${m.id === value ? 'sel' : ''} ${ok ? '' : 'nokey'}`}
                onClick={() => {
                  if (!ok) return
                  onChange(m.id)
                  setOpen(false)
                }}
                title={speculative ? 'Preview: this model id has not been verified with the provider; selecting it may 404.' : undefined}
              >
                <span className="model-menu-label">{m.label}</span>
                {speculative && <span className="model-preview">preview</span>}
                {!ok && <span className="model-nokey">{unavailableLabel(m)}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
