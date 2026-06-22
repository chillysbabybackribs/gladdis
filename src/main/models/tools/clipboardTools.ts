import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { ToolOutcome } from '../browserTools'
import { cap, parseTimeoutMs } from './toolUtils'

const execFileAsync = promisify(execFile)

/** A healthy xclip read/write returns in single-digit milliseconds. If it
 *  hasn't finished in a few seconds the X selection owner is wedged, so the
 *  clipboard timeout is capped well below the generic 10-min command ceiling. */
const CLIPBOARD_TIMEOUT_MS = 4_000
const CLIPBOARD_SELECTIONS = new Set(['clipboard', 'primary'])

export type ClipboardSelection = 'clipboard' | 'primary'

function normalizeSelection(selection: unknown): ClipboardSelection {
  const value = String(selection ?? '').trim().toLowerCase()
  return CLIPBOARD_SELECTIONS.has(value) ? (value as ClipboardSelection) : 'clipboard'
}

export async function runReadClipboard(args: Record<string, any>): Promise<ToolOutcome> {
  const selection = normalizeSelection(args.selection)
  const timeout = Math.min(parseTimeoutMs(args.timeout_ms || CLIPBOARD_TIMEOUT_MS), CLIPBOARD_TIMEOUT_MS)
  try {
    const { stdout, stderr } = await execFileAsync('xclip', ['-o', '-selection', selection], {
      maxBuffer: 10 * 1024 * 1024,
      timeout
    })
    const payload = String(stdout ?? '').trim()
    if (!payload) {
      return { ok: true, text: `Clipboard [${selection}] is empty.` }
    }
    const extra = String(stderr ?? '').trim()
    return {
      ok: true,
      text: cap(`Clipboard [${selection}]:\n${payload}${extra ? `\n${extra}` : ''}`, 40_000)
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { ok: false, text: 'read_clipboard: xclip not found. Install with: sudo apt-get install -y xclip' }
    }
    const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT'
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
    const prefix = timedOut ? `read_clipboard timed out after ${timeout}ms.` : 'read_clipboard failed:'
    return { ok: false, text: `read_clipboard failed:\n${prefix}\n${output || 'Could not read clipboard.'}` }
  }
}

export async function runWriteClipboard(args: Record<string, any>): Promise<ToolOutcome> {
  const text = String(args.text ?? '')
  if (!text) {
    return { ok: false, text: 'write_clipboard: "text" is required.' }
  }
  const selection = normalizeSelection(args.selection)
  const argsOut = ['-selection', selection]
  const timeout = Math.min(parseTimeoutMs(args.timeout_ms || CLIPBOARD_TIMEOUT_MS), CLIPBOARD_TIMEOUT_MS)
  try {
    const { stdout, stderr } = await execFileWithInput('xclip', ['-i', ...argsOut], text, 10 * 1024 * 1024, timeout)
    const output = [stdout, stderr].filter(Boolean).join('\n').trim()
    return {
      ok: true,
      text: `Wrote ${text.length} character(s) to clipboard [${selection}].${output ? `\n${output}` : ''}`
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { ok: false, text: 'write_clipboard: xclip not found. Install with: sudo apt-get install -y xclip' }
    }
    const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT' || err?.message?.includes('timed out')
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
    const prefix = timedOut ? `write_clipboard timed out after ${timeout}ms.` : 'write_clipboard failed:'
    return { ok: false, text: `write_clipboard failed:\n${prefix}\n${output || 'Could not write clipboard.'}` }
  }
}

interface SpawnResult {
  stdout: string
  stderr: string
}

/**
 * Writes `input` to a command's stdin and waits for it to exit.
 *
 * stdout/stderr are intentionally set to 'ignore' rather than 'pipe'. xclip -i
 * daemonizes itself (it must stay resident to serve the X selection), and the
 * child it forks inherits any open stdio fds. If we keep stdout/stderr piped,
 * those fds never close, so the 'close' event never fires and the call hangs
 * until the timeout fires (minutes). Ignoring them lets the parent see the
 * fork exit immediately. The command produces no output we need anyway.
 */
function execFileWithInput(
  file: string,
  args: string[],
  input: string,
  _maxBuffer = 10 * 1024 * 1024,
  timeoutMs = 600_000
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err: any = new Error(`Command timed out after ${timeoutMs}ms.`)
        err.code = 'ETIMEDOUT'
        err.signal = 'SIGTERM'
        child.kill('SIGTERM')
        reject(err)
      }, timeoutMs)
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout: '', stderr: '' })
        return
      }
      const err: any = new Error(`Command failed with exit code ${code}`)
      err.code = code
      reject(err)
    })
    child.stdin.on('error', () => { /* child gone before we finished writing; 'close'/'error' handles it */ })
    child.stdin.write(input)
    child.stdin.end()
  })
}
