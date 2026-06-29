import { useEffect, useState } from 'react'
import type {
  DreamAutoConfig,
  DreamAutoStatus,
  DreamPreferenceOrder
} from '../../../shared/types'
import { DEFAULT_DREAM_AUTO_CONFIG } from '../../../shared/types'

interface Props {
  workspaceRoot: string
  initialConfig: DreamAutoConfig
  status?: DreamAutoStatus | null
  onClose: () => void
  /** Called after every successful setConfig so the parent stays in sync. */
  onConfigChange: (next: DreamAutoConfig) => void
}

type AutoAdoptMode = DreamAutoConfig['autoAdopt']

const STRICTNESS_OPTIONS: { value: AutoAdoptMode; label: string; hint: string }[] = [
  {
    value: 'strict',
    label: 'Strict',
    hint:
      "Only auto-adopt when every promotion is supported and nothing replaces an existing entry. Hygiene-only changes always apply."
  },
  {
    value: 'permissive',
    label: 'Permissive',
    hint:
      "Auto-adopt as long as the adoption gate isn't blocked. Faster, more memory churn, slightly higher risk."
  },
  {
    value: 'off',
    label: 'Always review',
    hint:
      "Never auto-adopt. Every auto-dream produces a candidate that waits for your review."
  }
]

const PREFERENCE_OPTIONS: { value: DreamPreferenceOrder; label: string; hint: string }[] = [
  {
    value: 'cheapest',
    label: 'Cheapest',
    hint: 'Prefers Codex / fast models. Low cost per run, good for routine consolidation.'
  },
  {
    value: 'best',
    label: 'Best',
    hint: 'Prefers larger models. Higher cost per run, better at subtle merges.'
  }
]

/**
 * Settings modal for the auto-dream scheduler. Every change persists
 * immediately via `dream.auto.setConfig` — there is no Apply button — and
 * the parent is notified so its own cached config stays current. The
 * read-only status block at the bottom helps users see WHY a dream did or
 * didn't trigger lately (useful when the dual gate keeps blocking).
 */
export function AutoDreamSettingsModal({
  workspaceRoot,
  initialConfig,
  status,
  onClose,
  onConfigChange
}: Props) {
  const [config, setConfig] = useState<DreamAutoConfig>(initialConfig)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setConfig(initialConfig)
  }, [initialConfig])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commit = async (patch: Partial<DreamAutoConfig>) => {
    setSaving(true)
    setError(null)
    try {
      const merged = await window.gladdis.dream.auto.setConfig(workspaceRoot, patch)
      setConfig(merged)
      onConfigChange(merged)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const resetDefaults = () => void commit({ ...DEFAULT_DREAM_AUTO_CONFIG })

  return (
    <div
      className="modal-overlay dream-diff-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal dream-diff-modal" role="dialog" aria-label="Auto-dream settings">
        <div className="modal-head">
          <div>
            <div style={{ fontWeight: 600 }}>Auto-dream settings</div>
            <div className="dream-subtle">
              Background memory curation, Anthropic-calibrated. Off by default.
            </div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body dream-diff-body">
          <section className="auto-settings-section">
            <label className="auto-settings-toggle">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => void commit({ enabled: e.target.checked })}
              />
              <div>
                <div className="auto-settings-toggle-label">
                  {config.enabled ? 'Auto-dream is on' : 'Auto-dream is off'}
                </div>
                <div className="auto-settings-toggle-hint">
                  When on, gladdis quietly consolidates memory after a dual gate of
                  time and new conversations clears.
                </div>
              </div>
            </label>
          </section>

          <section className="auto-settings-section">
            <h4 className="auto-settings-heading">Trigger conditions</h4>
            <div className="auto-settings-grid">
              <NumberField
                label="Hours since last dream"
                value={config.minHours}
                min={1}
                max={24 * 7}
                step={1}
                onCommit={(v) => void commit({ minHours: v })}
                hint="Default: 24 (Anthropic's calibration)."
              />
              <NumberField
                label="New conversations since last dream"
                value={config.minSessions}
                min={1}
                max={100}
                step={1}
                onCommit={(v) => void commit({ minSessions: v })}
                hint="Default: 5. Conversations updated since the last dream count."
              />
              <NumberField
                label="Quiet seconds after last message"
                value={config.activityCooldownSeconds}
                min={0}
                max={60 * 60}
                step={30}
                onCommit={(v) => void commit({ activityCooldownSeconds: v })}
                hint="Won't trigger mid-conversation. 120 = two minutes."
              />
              <NumberField
                label="Max auto-runs per day"
                value={config.dailyRunCap}
                min={1}
                max={50}
                step={1}
                onCommit={(v) => void commit({ dailyRunCap: v })}
                hint="Hard ceiling on automatic runs per UTC day."
              />
            </div>
          </section>

          <section className="auto-settings-section">
            <h4 className="auto-settings-heading">Adoption</h4>
            <div className="auto-settings-radios">
              {STRICTNESS_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`auto-settings-radio${config.autoAdopt === opt.value ? ' is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="autoAdopt"
                    value={opt.value}
                    checked={config.autoAdopt === opt.value}
                    onChange={() => void commit({ autoAdopt: opt.value })}
                  />
                  <div>
                    <div className="auto-settings-radio-label">{opt.label}</div>
                    <div className="auto-settings-radio-hint">{opt.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>

          <section className="auto-settings-section">
            <h4 className="auto-settings-heading">Model preference</h4>
            <div className="auto-settings-radios auto-settings-radios-row">
              {PREFERENCE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`auto-settings-radio${config.preferenceOrder === opt.value ? ' is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="preferenceOrder"
                    value={opt.value}
                    checked={config.preferenceOrder === opt.value}
                    onChange={() => void commit({ preferenceOrder: opt.value })}
                  />
                  <div>
                    <div className="auto-settings-radio-label">{opt.label}</div>
                    <div className="auto-settings-radio-hint">{opt.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {status && (
            <section className="auto-settings-section auto-settings-status">
              <h4 className="auto-settings-heading">Current status</h4>
              <dl className="auto-settings-status-grid">
                <dt>Sessions since last dream</dt>
                <dd>{status.sessionsSinceLastDream}</dd>
                <dt>Auto-runs today</dt>
                <dd>
                  {status.runsToday} / {config.dailyRunCap}
                </dd>
                <dt>Last successful dream</dt>
                <dd>{status.lastDreamAt ? new Date(status.lastDreamAt).toLocaleString() : '—'}</dd>
                {status.lastSkipReason && (
                  <>
                    <dt>Last skip reason</dt>
                    <dd className="auto-settings-status-reason">{status.lastSkipReason}</dd>
                  </>
                )}
              </dl>
            </section>
          )}

          {error && (
            <div className="auto-settings-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="dream-btn dream-btn-discard" onClick={resetDefaults} disabled={saving}>
            Reset to defaults
          </button>
          <button className="dream-btn dream-btn-adopt" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  hint,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  hint?: string
  onCommit: (next: number) => void
}) {
  // Keep a string in local state while the user edits — clamping on every
  // keystroke makes typing impossible (you can't transit through "1" on
  // your way to "12" if min is 5). Clamp once, on blur or Enter.
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <label className="auto-settings-field">
      <span className="auto-settings-field-label">{label}</span>
      <input
        type="number"
        className="auto-settings-input"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
      />
      {hint && <span className="auto-settings-field-hint">{hint}</span>}
    </label>
  )
}
