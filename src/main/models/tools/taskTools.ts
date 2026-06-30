import { execFile } from 'child_process'
import { promisify } from 'util'
import { GoogleGenAI } from '@google/genai'
import type { FileTools } from '../../fs/FileTools'
import type { KeyStore } from '../KeyStore'
import type { ToolContext, ToolOutcome } from '../browserTools'
import { CodebaseAuditor } from '../CodebaseAuditor'
import type { CapabilityBroker } from '../capabilities/CapabilityBroker'
import { cap } from './toolUtils'

const execFileAsync = promisify(execFile)

const DEFAULT_PUBLISH_MESSAGE = 'Update Gladdis app'

const VALIDATION_COMMANDS = {
  typecheck: ['npm', ['run', 'typecheck']],
  test: ['npm', ['test']],
  build: ['npm', ['run', 'build']],
  check: ['npm', ['run', 'check']]
} as const

type LegacyValidationCheck = keyof typeof VALIDATION_COMMANDS

export interface TaskToolsDeps {
  files: FileTools
  keys?: KeyStore
  capabilityBroker?: CapabilityBroker | null
  getWorkspaceRoot: () => string | null
}

/**
 * Workspace-level codebase audit. Pulls the workspace root, instantiates a
 * CodebaseAuditor with model fallback, and ships the rendered Markdown report
 * back to the model.
 */
export async function runAuditCodebase(
  deps: TaskToolsDeps,
  args: Record<string, any>,
  ctx?: ToolContext
): Promise<ToolOutcome> {
  const root = deps.getWorkspaceRoot() || process.cwd()
  const googleKey = deps.keys?.get('google') || process.env.GEMINI_API_KEY
  if (!googleKey) {
    return {
      ok: false,
      text: 'Error: Google Gemini API key not found in key storage.'
    }
  }
  const ai = new GoogleGenAI({ apiKey: googleKey })
  const modelOverride = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined
  const auditor = new CodebaseAuditor(root, ai, modelOverride, {
    capabilityBroker: deps.capabilityBroker ?? undefined,
    brokerContext:
      ctx?.taskId && ctx?.requestId
        ? {
            requestId: ctx.requestId,
            assistantMessageId: ctx.assistantMessageId,
            taskId: ctx.taskId,
            iteration: ctx.iteration
          }
        : undefined
  })
  const focusPath = typeof args.focusPath === 'string' ? args.focusPath : undefined
  const auditGoal =
    typeof args.goal === 'string' && args.goal.trim()
      ? args.goal.trim()
      : ctx?.latestUserText?.trim() || undefined
  const auditReport = await auditor.runAudit(focusPath, auditGoal)
  return {
    ok: !auditReport.startsWith('Error:'),
    text: auditReport
  }
}

/**
 * Validation runner that survives the legacy `run_validation` tool surface
 * (npm-only). The newer `verify_change` capability already detects language;
 * this one stays Node-shaped because the contract is "name a script".
 */
export async function runValidation(
  deps: TaskToolsDeps,
  args: Record<string, any>
): Promise<ToolOutcome> {
  const check = String(args.check ?? '').trim() as LegacyValidationCheck
  const command = VALIDATION_COMMANDS[check]
  if (!command) {
    return {
      ok: false,
      text: 'run_validation: "check" must be one of typecheck, test, build, or check.'
    }
  }

  const cwd = deps.files.getRoot() ?? process.cwd()
  const [bin, argv] = command
  const pretty = [bin, ...argv].join(' ')
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...argv], {
      cwd,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024
    })
    const output = [stdout, stderr].filter(Boolean).join('\n').trim()
    return {
      ok: true,
      text: cap(`PASS: ${pretty}\n${output || '(no output)'}`, 40_000)
    }
  } catch (err: any) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
    return {
      ok: false,
      text: cap(`FAIL: ${pretty}\n${output || 'Validation failed.'}`, 40_000)
    }
  }
}

/**
 * Stage all changes, commit, and push. Refuses cleanly if the workspace is
 * outside a git repo or there's nothing to publish.
 */
export async function runPublishChanges(
  deps: TaskToolsDeps,
  args: Record<string, any>
): Promise<ToolOutcome> {
  const cwd = deps.files.getRoot() ?? process.cwd()
  const message = commitMessage(args.message)
  const remote = String(args.remote ?? 'origin').trim() || 'origin'
  const requestedBranch = args.branch ? String(args.branch).trim() : ''

  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd)
    const repoRoot = (await git(['rev-parse', '--show-toplevel'], cwd)).stdout.trim() || cwd
    const before = (await git(['status', '--short'], repoRoot)).stdout.trim()
    if (!before) return { ok: true, text: 'publish_changes: no local changes to publish.' }

    await git(['add', '-A'], repoRoot)
    const staged = await gitQuiet(['diff', '--cached', '--quiet'], repoRoot)
    if (staged.code === 0) return { ok: true, text: 'publish_changes: no staged changes to publish.' }

    await git(['commit', '-m', message], repoRoot)
    const branch = requestedBranch || (await git(['branch', '--show-current'], repoRoot)).stdout.trim()
    if (!branch) {
      return { ok: false, text: 'publish_changes: could not determine the current branch.' }
    }

    await git(['push', '-u', remote, branch], repoRoot, 240_000)
    const commit = (await git(['rev-parse', '--short', 'HEAD'], repoRoot)).stdout.trim()
    const after = (await git(['status', '--short'], repoRoot)).stdout.trim()
    return {
      ok: true,
      text:
        `Published ${commit} to ${remote}/${branch}.\n` +
        `Commit message: ${message}\n` +
        `Changed files before publish:\n${cap(before, 8_000)}` +
        (after ? `\n\nRemaining local changes:\n${cap(after, 8_000)}` : '\n\nWorking tree clean.')
    }
  } catch (err: any) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
    return { ok: false, text: cap(`publish_changes failed:\n${output || String(err)}`, 20_000) }
  }
}

function commitMessage(value: unknown): string {
  const raw = String(value ?? '').trim()
  const message = raw || DEFAULT_PUBLISH_MESSAGE
  return message.split(/\r?\n/)[0].slice(0, 200)
}

async function git(
  argsList: string[],
  cwd: string,
  timeout = 180_000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', argsList, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024
  })
}

async function gitQuiet(
  argsList: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await git(argsList, cwd)
    return { code: 0, ...result }
  } catch (err: any) {
    return {
      code: typeof err?.code === 'number' ? err.code : 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? '')
    }
  }
}
