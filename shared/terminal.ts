/**
 * Real PTY-backed terminal contract shared across main / preload / renderer.
 *
 * The PTY process lives in main (Node-side via @lydell/node-pty); the renderer
 * runs xterm.js and pipes keystrokes/resizes back through these IPC channels.
 * One terminal id == one shell process. v1 only uses a single session; the
 * id-keyed API leaves room for tabbed terminals later without re-wiring.
 */

export interface TerminalSpawnOpts {
  /** Initial PTY dimensions; FitAddon updates them right after attach. */
  cols: number
  rows: number
  /** Starting working directory. Defaults to the workspace folder in main. */
  cwd?: string
  /** Override $SHELL (default: process.env.SHELL || '/bin/bash' on POSIX). */
  shell?: string
}

export interface TerminalInfo {
  id: string
  pid: number
  shell: string
  cwd: string
}

/** Bytes (ANSI-tinted UTF-8) streamed from a PTY back to the renderer. */
export interface TerminalDataEvent {
  id: string
  data: string
}

/** Sent when the shell process exits or is killed. */
export interface TerminalExitEvent {
  id: string
  exitCode: number | null
  signal: number | null
}
