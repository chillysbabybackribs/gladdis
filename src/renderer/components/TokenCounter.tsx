import { useMemo } from 'react'
import type { ModelCallRecord } from '../../../shared/types'

interface Props {
  /** Audit records for this panel (live, newest-first). */
  records: ModelCallRecord[]
  /** Only count calls made in this conversation. */
  conversationId: string
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * Per-conversation token meter for the chat footer rail. It sums every model
 * call made in the current chat — across model switches — preferring actual
 * counts and falling back to the char/4 estimate while a call is still
 * streaming. Scoping by conversationId makes it persistent: the audit ledger
 * reloads its last 500 records on launch, so a restored chat shows its real
 * running total, and starting a new chat (a fresh id) resets it to zero. No
 * pricing — just the raw in / out / cached the providers report.
 */
export function TokenCounter({ records, conversationId }: Props) {
  const totals = useMemo(() => {
    let input = 0
    let output = 0
    let cached = 0
    for (const r of records) {
      if (r.conversationId !== conversationId) continue
      input += r.inputTokensActual ?? r.inputTokensEstimate
      output += r.outputTokensActual ?? r.outputTokensEstimate
      cached += r.cachedInputTokensActual ?? 0
    }
    return { input, output, cached }
  }, [records, conversationId])

  if (totals.input === 0 && totals.output === 0) return null

  return (
    <span
      className="footer-chat-tokens"
      title="Tokens used in this chat (in · out · cached)"
    >
      {fmt(totals.input)} in · {fmt(totals.output)} out
      {totals.cached > 0 && ` · ${fmt(totals.cached)} cached`}
    </span>
  )
}
