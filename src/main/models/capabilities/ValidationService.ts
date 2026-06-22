import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const VALIDATION_COMMANDS = {
  typecheck: ['npm', ['run', 'typecheck']],
  test: ['npm', ['test']],
  build: ['npm', ['run', 'build']],
  check: ['npm', ['run', 'check']]
} as const

export type ValidationCheck = keyof typeof VALIDATION_COMMANDS

export interface VerifyChangeInput {
  workspaceRoot: string
  checks?: ValidationCheck[]
  goal?: string
}

export interface VerifyChangeResult {
  ok: boolean
  status: 'pass' | 'fail' | 'blocked'
  summary: string
  structuredPayload: {
    workspaceRoot: string
    checks: Array<{
      check: ValidationCheck
      ok: boolean
      output: string
    }>
  }
}

const DEFAULT_CHECKS: ValidationCheck[] = ['typecheck']

export class ValidationService {
  async verifyChange(input: VerifyChangeInput): Promise<VerifyChangeResult> {
    const checks = this.resolveChecks(input)
    if (checks.length === 0) {
      return {
        ok: false,
        status: 'blocked',
        summary: 'No supported validation checks were selected.',
        structuredPayload: {
          workspaceRoot: input.workspaceRoot,
          checks: []
        }
      }
    }

    const results: VerifyChangeResult['structuredPayload']['checks'] = []
    for (const check of checks) {
      const [file, args] = VALIDATION_COMMANDS[check]
      try {
        const { stdout, stderr } = await execFileAsync(file, args, {
          cwd: input.workspaceRoot,
          timeout: 600_000,
          maxBuffer: 10 * 1024 * 1024
        })
        const output = capOutput([stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)')
        results.push({ check, ok: true, output })
      } catch (err: any) {
        const output = capOutput(
          [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim() || 'Validation failed.'
        )
        results.push({ check, ok: false, output })
        return {
          ok: false,
          status: 'fail',
          summary: this.summaryFromResults(results),
          structuredPayload: {
            workspaceRoot: input.workspaceRoot,
            checks: results
          }
        }
      }
    }

    return {
      ok: true,
      status: 'pass',
      summary: this.summaryFromResults(results),
      structuredPayload: {
        workspaceRoot: input.workspaceRoot,
        checks: results
      }
    }
  }

  private resolveChecks(input: VerifyChangeInput): ValidationCheck[] {
    const requested = (input.checks ?? []).filter((check): check is ValidationCheck => check in VALIDATION_COMMANDS)
    if (requested.length > 0) return requested
    const goal = (input.goal ?? '').toLowerCase()
    if (/\btest|behavior|regression\b/.test(goal)) return ['test']
    if (/\bbuild|bundle|packag|runtime\b/.test(goal)) return ['build']
    if (/\bbroad|sweep|full|all\b/.test(goal)) return ['check']
    return DEFAULT_CHECKS
  }

  private summaryFromResults(results: VerifyChangeResult['structuredPayload']['checks']): string {
    return results
      .map((result) => {
        const head = `${result.check}: ${result.ok ? 'pass' : 'fail'}`
        return `${head}\n${result.output}`
      })
      .join('\n\n')
  }
}

function capOutput(text: string, max = 12_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text
}
