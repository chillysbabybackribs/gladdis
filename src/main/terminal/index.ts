import { ipcMain, type WebContents } from 'electron'
import { PtyHost } from './PtyHost'
import { IPC } from '../../../shared/ipc'
import type { TerminalSpawnOpts } from '../../../shared/terminal'

/**
 * Stand up the PTY host and wire the renderer IPC channels.
 *
 * Returns the host so the caller (main) can `disposeAll()` on app quit.
 * `sendToRenderer` is called with `(channel, payload)` and is expected to
 * forward to whichever `WebContents` is mounted; we keep it abstract so this
 * module isn't coupled to the BaseWindow / uiView lifecycle.
 */
export function registerTerminalIpc(
  getRendererCwd: () => string | null,
  sendToRenderer: (channel: string, payload: unknown) => void
): PtyHost {
  const host = new PtyHost(
    (id, data) => sendToRenderer(IPC.TERMINAL_DATA, { id, data }),
    (id, exitCode, signal) => sendToRenderer(IPC.TERMINAL_EXIT, { id, exitCode, signal })
  )

  ipcMain.handle(IPC.TERMINAL_CREATE, (_e, opts: TerminalSpawnOpts) =>
    host.create(opts ?? { cols: 80, rows: 24 }, getRendererCwd())
  )
  ipcMain.on(IPC.TERMINAL_WRITE, (_e, id: string, data: string) => host.write(id, data))
  ipcMain.on(IPC.TERMINAL_RESIZE, (_e, id: string, cols: number, rows: number) =>
    host.resize(id, cols, rows)
  )
  ipcMain.handle(IPC.TERMINAL_KILL, (_e, id: string) => {
    host.kill(id)
  })
  ipcMain.on(IPC.TERMINAL_SET_CWD, (_e, id: string, folder: string) => host.setCwd(id, folder))

  return host
}

/** Helper: only send if the target WebContents is alive. */
export function sendIfLive(wc: WebContents, channel: string, payload: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, payload)
}
