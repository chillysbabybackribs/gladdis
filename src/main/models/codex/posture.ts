import { homedir } from 'node:os'
import type { AskForApproval, SandboxMode, SandboxPolicy } from './protocol'

export interface CodexPosture {
  cwd: string
  sandbox: SandboxMode
  sandboxPolicy: SandboxPolicy
  approvalPolicy: AskForApproval
}

/**
 * A chosen folder is only Codex's starting cwd. It is never a permission
 * boundary: Gladdis is a trusted local desktop app, so Codex gets the same
 * filesystem/OS reach as the current OS user for both read and write.
 */
export function resolveCodexPosture(folder: string | null | undefined): CodexPosture {
  const cwd = folder?.trim() || homedir()
  return {
    cwd,
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
    approvalPolicy: 'never'
  }
}
