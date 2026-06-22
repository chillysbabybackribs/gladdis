import { useEffect, useState } from 'react'
import type { ModelCallRecord } from '../../../shared/types'

/**
 * Live audit-record store: pulls the snapshot once at mount, then merges in
 * the streaming `audit:event` updates from main. Records are kept sorted by
 * `startedAt` descending so the History modal renders newest-first without
 * a re-sort on every render.
 */
export function useAuditRecords(): ModelCallRecord[] {
  const [records, setRecords] = useState<ModelCallRecord[]>([])
  useEffect(() => {
    void window.gladdis.audit.list().then(setRecords)
    const off = window.gladdis.audit.onEvent((event) => {
      setRecords((current) => {
        const index = current.findIndex((r) => r.id === event.record.id)
        if (index !== -1) {
          const updated = [...current]
          updated[index] = event.record
          if (current[index].startedAt === event.record.startedAt) return updated
          return updated.sort((a, b) => b.startedAt - a.startedAt)
        }
        const insertIdx = current.findIndex((r) => r.startedAt < event.record.startedAt)
        if (insertIdx === -1) return [...current, event.record]
        return [...current.slice(0, insertIdx), event.record, ...current.slice(insertIdx)]
      })
    })
    return off
  }, [])
  return records
}
