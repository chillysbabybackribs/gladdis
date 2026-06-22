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

const PROVIDERS = [
  { id: 'codex', label: 'Codex' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Gemini' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'grok', label: 'Grok (xAI)' }
] as const

/** Small dropdown to pick the active model, grouped by provider with a secondary pop out menu. */
export function ModelPicker({ value, onChange, models, keyStatus, codexStatus }: Props) {
  const [open, setOpen] = useState(false)
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
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

  useEffect(() => {
    if (!open) setActiveProvider(null)
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
      case 'openai':
        return keyStatus.openai
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
        <div className="model-menu" role="menu">
          <div className="model-menu-providers">
            {PROVIDERS.map((prov) => {
              const isActive = activeProvider === prov.id
              const isSelectedProv = current?.provider === prov.id
              const providerModels = models.filter((m) => m.provider === prov.id)
              return (
                <div
                  key={prov.id}
                  className={`model-provider-wrap ${isActive ? 'active' : ''}`}
                  onMouseEnter={() => setActiveProvider(prov.id)}
                >
                  <button
                    role="menuitem"
                    className={`model-menu-item provider-item ${isActive ? 'active' : ''} ${isSelectedProv ? 'current-prov' : ''}`}
                  >
                    <span className="model-menu-label">{prov.label}</span>
                    <span className="model-menu-chevron">›</span>
                  </button>
                  {isActive && providerModels.length > 0 && (
                    <div className="model-submenu" role="menu">
                      {providerModels.map((m) => {
                        const ok = usable(m)
                        const speculative = m.availability === 'speculative'
                        return (
                          <button
                            key={m.id}
                            role="menuitemcheckbox"
                            aria-checked={m.id === value}
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
            })}
          </div>
        </div>
      )}
    </div>
  )
}
