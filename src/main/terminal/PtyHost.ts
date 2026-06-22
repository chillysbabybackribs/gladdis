import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { homedir } from 'node:os'
import type { TerminalInfo, TerminalSpawnOpts } from '../../../shared/terminal'

interface Session {
  id: string
  pty: IPty
  shell: string
  cwd: string
}

/**
 * Owns every live PTY in the main process. One id == one shell process.
 * v1 only opens a single session at a time from the renderer, but the id-keyed
 * surface is designed so tabbed terminals are a renderer-only addition later.
 *
 * Data/exit events stream out via the constructor callbacks (which the IPC
 * registrar wires straight to `uiView.webContents.send`). No buffering: the
 * renderer's xterm.js owns the scrollback. We can't recover scrollback if the
 * renderer reloads mid-session — the PTY keeps running, but xterm starts blank.
 */
export class PtyHost {
  private sessions = new Map<string, Session>()
  private seq = 0

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number | null, signal: number | null) => void
  ) {}

  /** Spawn a new PTY. Throws on spawn failure (caller surfaces as IPC error). */
  create(opts: TerminalSpawnOpts, defaultCwd: string | null): TerminalInfo {
    const shell = this.resolveShell(opts.shell)
    const args = this.shellArgs(shell)
    const cwd = this.resolveCwd(opts.cwd ?? defaultCwd)
    const cols = Math.max(2, Math.floor(opts.cols ?? 80))
    const rows = Math.max(1, Math.floor(opts.rows ?? 24))

    // Strip Electron-injected vars so the spawned shell looks like a real one
    // (otherwise things like prompt themes that key on ELECTRON_RUN_AS_NODE
    // misbehave, and any model API key set in main.process.env would otherwise
    // leak into every shell command).
    const env = this.scrubEnv(process.env)

    const pty = ptySpawn(shell, args, {
      cols,
      rows,
      cwd,
      env,
      name: 'xterm-256color'
    })

    const id = this.nextId()
    pty.onData((data) => this.onData(id, data))
    pty.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.onExit(id, exitCode ?? null, signal ?? null)
    })

    this.sessions.set(id, { id, pty, shell, cwd })
    return { id, pid: pty.pid, shell, cwd }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    const c = Math.max(2, Math.floor(cols))
    const r = Math.max(1, Math.floor(rows))
    try {
      session.pty.resize(c, r)
    } catch (err) {
      // resize can throw EBADF when the PTY just exited; harmless.
      if (process.env.GLADDIS_TERMINAL_DEBUG) {
        console.warn(`[pty ${id}] resize failed:`, (err as Error).message)
      }
    }
  }

  /** Run `cd <folder>` inside the live shell (won't disturb a foreground job). */
  setCwd(id: string, folder: string): void {
    const session = this.sessions.get(id)
    if (!session || !folder) return
    // Shell-quote the path for safety; bash/zsh both accept single-quotes
    // with embedded singles escaped as '\''.
    const quoted = `'${folder.replace(/'/g, `'\\''`)}'`
    session.pty.write(` cd ${quoted}\r`) // leading space → HISTCONTROL=ignorespace
    session.cwd = folder
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty.kill()
    } catch {
      /* already gone */
    }
    this.sessions.delete(id)
  }

  /** Tear down every PTY (called on window close / app quit). */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private nextId(): string {
    this.seq += 1
    return `pty-${this.seq}`
  }

  private resolveShell(override?: string): string {
    if (override && override.trim()) return override.trim()
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe'
    }
    return process.env.SHELL || '/bin/bash'
  }

  private shellArgs(_shell: string): string[] {
    // No args by default — match what gnome-terminal / iTerm / VS Code do.
    // Passing -l forced login-shell init (which re-runs /etc/profile + sources
    // ~/.bashrc on most setups); combined with the first SIGWINCH on resize
    // that produced a duplicate prompt on open. node-pty already gives us a
    // real TTY, so the shell behaves interactively without -i either.
    return []
  }

  private resolveCwd(requested: string | null | undefined): string {
    const candidate = (requested ?? '').trim()
    if (candidate) return candidate
    return homedir()
  }

  private scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) continue
      if (k === 'ELECTRON_RUN_AS_NODE') continue
      if (k === 'ELECTRON_NO_ATTACH_CONSOLE') continue
      // Inherited prompt hooks from the Electron parent can fire on every
      // PS1 render and amplify resize-driven redraws into duplicate prompts.
      // The user's own ~/.bashrc / ~/.zshrc will set these fresh per shell.
      if (k === 'PROMPT_COMMAND' || k === 'PROMPT_DIRTRIM') continue
      if (k.startsWith('ANTHROPIC_') || k.startsWith('GEMINI_') || k.startsWith('OPENAI_')) {
        // Keep API keys *out* of the user's interactive shell unless they
        // explicitly want them. Leak risk: a `printenv | curl …` line in a
        // chat or screenshot.
        continue
      }
      out[k] = v
    }
    out.TERM = 'xterm-256color'
    out.COLORTERM = 'truecolor'
    return out
  }
}
