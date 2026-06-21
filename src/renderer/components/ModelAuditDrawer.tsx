import type { ModelCallRecord } from '../../../shared/types'

interface Props {
  open: boolean
  records: ModelCallRecord[]
  onClose: () => void
}

export function ModelAuditDrawer({ open, records, onClose }: Props) {
  const totals = records.reduce(
    (acc, r) => {
      acc.calls += 1
      acc.in += r.inputTokensActual ?? r.inputTokensEstimate
      acc.out += r.outputTokensActual ?? r.outputTokensEstimate
      return acc
    },
    { calls: 0, in: 0, out: 0 }
  )

  return (
    <>
      <div className={`audit-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`audit-drawer ${open ? 'open' : ''}`}>
        <div className="audit-head">
          <div>
            <div className="audit-title">Model calls</div>
            <div className="audit-sub">
              {totals.calls} calls · {fmt(totals.in)} in · {fmt(totals.out)} out
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <div className="audit-list">
          {records.length === 0 ? (
            <div className="audit-empty">No model calls yet.</div>
          ) : (
            records.map((r) => <AuditRow key={r.id} record={r} />)
          )}
        </div>
      </aside>
    </>
  )
}

function AuditRow({ record }: { record: ModelCallRecord }) {
  const input = record.inputTokensActual ?? record.inputTokensEstimate
  const output = record.outputTokensActual ?? record.outputTokensEstimate
  return (
    <div className={`audit-row ${record.status}`}>
      <div className="audit-row-top">
        <span className="audit-stage">{record.stage}</span>
        <span className="audit-status">{record.status}</span>
      </div>
      <div className="audit-model">{record.provider} · {record.modelId}</div>
      <div className="audit-metrics">
        <span>{fmt(input)} in</span>
        <span>{fmt(output)} out</span>
        <span>{record.latencyMs == null ? 'running' : `${(record.latencyMs / 1000).toFixed(1)}s`}</span>
      </div>
      {record.error && <div className="audit-error">{record.error}</div>}
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
