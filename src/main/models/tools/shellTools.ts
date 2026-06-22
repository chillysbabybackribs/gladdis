import { execFile } from 'child_process'
import { promisify } from 'util'
import type { FileTools } from '../../fs/FileTools'
import type { ToolOutcome } from '../browserTools'
import { classifyCommand, readCommandSafetyConfig } from '../commandSafety'
import { cap, parseTimeoutMs } from './toolUtils'

const execFileAsync = promisify(execFile)

export interface ShellToolsDeps {
  files: FileTools
}

/**
 * `run_command` — arbitrary shell with full OS-user reach by design.
 * Only the high-signal denylist in {@link classifyCommand} stands between the
 * model and the system; see commandSafety.ts and the README "Threat model"
 * section for the override env vars.
 */
export async function runShellCommand(
  deps: ShellToolsDeps,
  args: Record<string, any>
): Promise<ToolOutcome> {
  const command = String(args.command ?? '').trim()
  if (!command) {
    return { ok: false, text: 'run_command: "command" is required.' }
  }
  const verdict = classifyCommand(command, readCommandSafetyConfig())
  if (!verdict.allowed) {
    const hint = verdict.hint ? `\n${verdict.hint}` : ''
    return { ok: false, text: `run_command refused: ${verdict.reason}${hint}` }
  }
  const timeout = parseTimeoutMs(args.timeout_ms)
  const cwd = (args.cwd ? String(args.cwd).trim() : '') || deps.files.getRoot() || process.cwd()
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024
    })
    const output = [stdout, stderr].filter(Boolean).join('\n').trim()
    return { ok: true, text: cap(`$ ${command}\n${output || '(no output)'}`, 40_000) }
  } catch (err: any) {
    const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT'
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
    const prefix = timedOut ? `Command timed out after ${timeout}ms.` : 'Command failed.'
    return { ok: false, text: cap(`$ ${command}\n${prefix}\n${output || 'Command failed.'}`, 40_000) }
  }
}
