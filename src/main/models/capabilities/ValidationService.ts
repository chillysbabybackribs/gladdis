import { execFile } from 'child_process'
import { access } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * The four named checks gladdis surfaces to the agent. Each language profile
 * fills in the actual command for whichever subset it supports — e.g. Python
 * has no native `build`, so that slot is null and the service reports
 * "blocked" cleanly instead of silently shelling into npm.
 */
export type ValidationCheck = 'typecheck' | 'test' | 'build' | 'check'

type CommandSpec = readonly [string, readonly string[]]

interface LanguageProfile {
  language: WorkspaceLanguage
  manifest: string[]
  commands: Partial<Record<ValidationCheck, CommandSpec>>
}

export type WorkspaceLanguage = 'node' | 'python' | 'rust' | 'go' | 'unknown'

const LANGUAGE_PROFILES: ReadonlyArray<LanguageProfile> = [
  {
    language: 'node',
    manifest: ['package.json'],
    commands: {
      typecheck: ['npm', ['run', 'typecheck']],
      test: ['npm', ['test']],
      build: ['npm', ['run', 'build']],
      check: ['npm', ['run', 'check']]
    }
  },
  {
    language: 'rust',
    manifest: ['Cargo.toml'],
    commands: {
      typecheck: ['cargo', ['check']],
      test: ['cargo', ['test']],
      build: ['cargo', ['build']],
      check: ['cargo', ['check']]
    }
  },
  {
    language: 'go',
    manifest: ['go.mod'],
    commands: {
      typecheck: ['go', ['vet', './...']],
      test: ['go', ['test', './...']],
      build: ['go', ['build', './...']],
      check: ['go', ['vet', './...']]
    }
  },
  {
    language: 'python',
    manifest: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
    commands: {
      typecheck: ['python', ['-m', 'mypy', '.']],
      test: ['python', ['-m', 'pytest']]
    }
  }
]

export interface VerifyChangeInput {
  workspaceRoot: string
  checks?: ValidationCheck[]
  goal?: string
}

export interface VerifyChangeResult {
  ok: boolean
  status: 'pass' | 'fail' | 'blocked'
  summary: string
  language: WorkspaceLanguage
  structuredPayload: {
    workspaceRoot: string
    language: WorkspaceLanguage
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
    const profile = await detectLanguageProfile(input.workspaceRoot)
    if (!profile) {
      return blocked(
        input.workspaceRoot,
        'unknown',
        'No supported workspace manifest found (looked for package.json, Cargo.toml, go.mod, pyproject.toml, setup.py, setup.cfg, requirements.txt). Pick a project root that contains one of these.'
      )
    }

    const requested = this.resolveChecks(input)
    const supported = requested.filter((check) => profile.commands[check])
    const skipped = requested.filter((check) => !profile.commands[check])
    if (supported.length === 0) {
      return blocked(
        input.workspaceRoot,
        profile.language,
        `${profile.language} workspace does not support these checks: ${requested.join(', ')}. Supported here: ${Object.keys(profile.commands).join(', ') || '(none)'}.`
      )
    }

    const results: VerifyChangeResult['structuredPayload']['checks'] = []
    for (const check of supported) {
      const [file, args] = profile.commands[check]!
      try {
        const { stdout, stderr } = await execFileAsync(file, [...args], {
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
          summary: this.summaryFromResults(results, skipped),
          language: profile.language,
          structuredPayload: {
            workspaceRoot: input.workspaceRoot,
            language: profile.language,
            checks: results
          }
        }
      }
    }

    return {
      ok: true,
      status: 'pass',
      summary: this.summaryFromResults(results, skipped),
      language: profile.language,
      structuredPayload: {
        workspaceRoot: input.workspaceRoot,
        language: profile.language,
        checks: results
      }
    }
  }

  private resolveChecks(input: VerifyChangeInput): ValidationCheck[] {
    const KNOWN: readonly ValidationCheck[] = ['typecheck', 'test', 'build', 'check']
    const requested = (input.checks ?? []).filter((check): check is ValidationCheck =>
      (KNOWN as readonly string[]).includes(check)
    )
    if (requested.length > 0) return requested
    const goal = (input.goal ?? '').toLowerCase()
    if (/\btest|behavior|regression\b/.test(goal)) return ['test']
    if (/\bbuild|bundle|packag|runtime\b/.test(goal)) return ['build']
    if (/\bbroad|sweep|full|all\b/.test(goal)) return ['check']
    return DEFAULT_CHECKS
  }

  private summaryFromResults(
    results: VerifyChangeResult['structuredPayload']['checks'],
    skipped: ValidationCheck[]
  ): string {
    const body = results
      .map((result) => {
        const head = `${result.check}: ${result.ok ? 'pass' : 'fail'}`
        return `${head}\n${result.output}`
      })
      .join('\n\n')
    if (skipped.length === 0) return body
    return `${body}\n\nSkipped (no command for this language): ${skipped.join(', ')}`
  }
}

async function detectLanguageProfile(workspaceRoot: string): Promise<LanguageProfile | null> {
  for (const profile of LANGUAGE_PROFILES) {
    for (const manifest of profile.manifest) {
      try {
        await access(join(workspaceRoot, manifest))
        return profile
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

function blocked(workspaceRoot: string, language: WorkspaceLanguage, reason: string): VerifyChangeResult {
  return {
    ok: false,
    status: 'blocked',
    summary: reason,
    language,
    structuredPayload: { workspaceRoot, language, checks: [] }
  }
}

function capOutput(text: string, max = 12_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text
}
