import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * Lifecycle controller for the singleton xterm.js instance + its backing PTY.
 *
 * Boot order (lazy):
 *   1. <TerminalHost /> mounts and gives us the hidden host div via hostRef.
 *   2. We construct the xterm.js Terminal once and open() it into the host.
 *   3. open() does NOT spawn the PTY — that happens on the first `ensurePty()`,
 *      typically triggered by <TerminalSlot/> mounting (i.e. the user opening
 *      the dock for the first time). Boot cost stays at zero until used.
 *
 * Move semantics: TerminalSlot calls `attach(slotEl)` to appendChild the host
 * div into itself and `detach()` to return it home. The xterm canvas, the PTY
 * process, and the scrollback all survive this — no React rerender, no IPC
 * thrashing.
 */

const CURSOR_THEME = {
  // Cursor-dark theme alignment (see src/renderer/styles/theme.css).
  background: '#1c1c1c',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#1c1c1c',
  selectionBackground: 'rgba(68, 147, 248, 0.28)',
  black: '#181818',
  red: '#e46a61',
  green: '#3fb950',
  yellow: '#d8a24a',
  blue: '#4493f8',
  magenta: '#b48ead',
  cyan: '#56b6c2',
  white: '#e6e6e6',
  brightBlack: '#5c5c5c',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#a5d6ff',
  brightWhite: '#ffffff'
} as const

export interface TerminalHandle {
  /** True once the xterm instance is initialized into the host div. */
  ready: boolean
  /** Spawn (or reuse) the PTY and wire it to xterm. Returns the session id. */
  ensurePty: () => Promise<string | null>
  /**
   * Move the xterm host element into a visible slot. Returns a teardown that
   * returns the host element to its hidden home div.
   */
  attach: (slotEl: HTMLElement) => () => void
  /** Force a FitAddon resize, e.g. after a layout transition settles. */
  refit: () => void
  /** Focus the underlying xterm textarea. */
  focus: () => void
  /** Current PTY session id, or null if none has been spawned yet. */
  ptyId: string | null
}

export function useTerminal(hostRef: RefObject<HTMLDivElement | null>): TerminalHandle {
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const pendingResize = useRef<number | null>(null)
  const inputDisposeRef = useRef<(() => void) | null>(null)
  const dataUnsubRef = useRef<(() => void) | null>(null)
  const exitUnsubRef = useRef<(() => void) | null>(null)
  const [ready, setReady] = useState(false)
  const [ptyId, setPtyId] = useState<string | null>(null)

  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl || termRef.current) return

    // The xterm-bearing container is a sibling-free div we own, NOT the React-
    // managed host. We move this container between the host and slots; React
    // never sees it (no children rendered into hostEl), so reconciliation is
    // safe even though we relocate the DOM node.
    const container = document.createElement('div')
    container.className = 'gladdis-terminal-container'
    container.style.cssText = 'width:100%;height:100%;'
    hostEl.appendChild(container)
    containerRef.current = container

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      allowProposedApi: true,
      theme: CURSOR_THEME as Record<string, string>
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    setReady(true)

    return () => {
      inputDisposeRef.current?.()
      dataUnsubRef.current?.()
      exitUnsubRef.current?.()
      inputDisposeRef.current = null
      dataUnsubRef.current = null
      exitUnsubRef.current = null
      if (ptyIdRef.current) {
        void window.gladdis.terminal.kill(ptyIdRef.current).catch(() => {})
        ptyIdRef.current = null
      }
      term.dispose()
      container.remove()
      termRef.current = null
      fitRef.current = null
      containerRef.current = null
      setReady(false)
      setPtyId(null)
    }
  }, [hostRef])

  const ensurePty = useMemo(
    () => async (): Promise<string | null> => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return null
      if (ptyIdRef.current) return ptyIdRef.current

      // Best-effort fit before spawn so the shell prints its first prompt
      // at the right width; if the host div hasn't been attached yet, fall
      // back to a sane default and refit once the slot mounts.
      let cols = 80
      let rows = 24
      try {
        const measured = fit.proposeDimensions()
        if (measured && measured.cols > 0 && measured.rows > 0) {
          cols = measured.cols
          rows = measured.rows
        }
      } catch {
        /* host not visible yet; use defaults */
      }

      const info = await window.gladdis.terminal.create({ cols, rows })
      ptyIdRef.current = info.id
      setPtyId(info.id)

      // Pipe shell -> xterm. Unsubscribed on hook teardown.
      dataUnsubRef.current = window.gladdis.terminal.onData((e) => {
        if (e.id !== ptyIdRef.current) return
        term.write(e.data)
      })

      // PTY exit -> mark closed and let UI react if it cares.
      exitUnsubRef.current = window.gladdis.terminal.onExit((e) => {
        if (e.id !== ptyIdRef.current) return
        const code = e.exitCode == null ? '?' : String(e.exitCode)
        term.writeln(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m`)
        ptyIdRef.current = null
        setPtyId(null)
      })

      // xterm -> shell. dispose() returned by onData/onKey can detach later.
      const sub = term.onData((data) => {
        const id = ptyIdRef.current
        if (!id) return
        window.gladdis.terminal.write(id, data)
      })
      inputDisposeRef.current = () => sub.dispose()

      return info.id
    },
    []
  )

  const refit = useMemo(
    () => () => {
      const term = termRef.current
      const fit = fitRef.current
      const id = ptyIdRef.current
      if (!term || !fit) return
      // Defer one rAF so the slot's final box is settled (post-transition).
      if (pendingResize.current != null) cancelAnimationFrame(pendingResize.current)
      pendingResize.current = requestAnimationFrame(() => {
        pendingResize.current = null
        try {
          fit.fit()
        } catch {
          return
        }
        if (id) window.gladdis.terminal.resize(id, term.cols, term.rows)
      })
    },
    []
  )

  const attach = useMemo(
    () =>
      (slotEl: HTMLElement): (() => void) => {
        const container = containerRef.current
        const host = hostRef.current
        const fit = fitRef.current
        if (!container || !host) return () => {}
        slotEl.appendChild(container)

        // Defer the PTY spawn one rAF so the slot's layout has flushed and
        // FitAddon can measure the real cols/rows. Otherwise the shell starts
        // at the default 80x24, prints PS1, and the immediate resize that
        // follows fires SIGWINCH — at which point bash's readline reprints
        // the prompt and we end up with two copies on the same line.
        let cancelled = false
        const raf = requestAnimationFrame(() => {
          if (cancelled) return
          try {
            fit?.fit()
          } catch {
            /* slot not measurable yet; ensurePty will use its own fallback */
          }
          void ensurePty()
        })

        const onTransition = () => refit()
        slotEl.addEventListener('transitionend', onTransition)
        const ro = new ResizeObserver(() => refit())
        ro.observe(slotEl)
        // Focus so keystrokes land in the shell immediately on open.
        queueMicrotask(() => termRef.current?.focus())
        return () => {
          cancelled = true
          cancelAnimationFrame(raf)
          ro.disconnect()
          slotEl.removeEventListener('transitionend', onTransition)
          // Return the container to its hidden home div so the xterm canvas
          // (and its accessibility tree) stay alive while the dock is closed.
          host.appendChild(container)
        }
      },
    [ensurePty, hostRef, refit]
  )

  const focus = useMemo(
    () => () => {
      termRef.current?.focus()
    },
    []
  )

  // Memoize the handle so consumers (e.g. TerminalSlot's useEffect) only react
  // when something meaningful changed. Without this, every Workspace re-render
  // would produce a new handle object, kicking off attach/detach churn.
  return useMemo<TerminalHandle>(
    () => ({ ready, ensurePty, attach, refit, focus, ptyId }),
    [ready, ensurePty, attach, refit, focus, ptyId]
  )
}
