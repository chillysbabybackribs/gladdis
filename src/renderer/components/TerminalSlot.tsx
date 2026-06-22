import { useEffect, useRef } from 'react'
import type { TerminalHandle } from '../hooks/useTerminal'

/**
 * The visible mount point for the singleton xterm container. On mount, we ask
 * the shared TerminalHandle to attach its container into this div; on unmount,
 * the handle returns the container to its hidden home. The xterm canvas and
 * the PTY both survive the move — that's how the same shell session follows
 * the user across dock positions.
 */
export function TerminalSlot({ handle }: { handle: TerminalHandle }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // attach itself short-circuits if the xterm container isn't ready yet.
    // Depending only on attach (which is memoized stably for the lifetime of
    // the parent hook) avoids re-running this effect on every ready/ptyId
    // transition, which would otherwise yank the xterm DOM out and back.
    return handle.attach(el)
  }, [handle.attach])

  return <div className="terminal-slot" ref={ref} />
}
