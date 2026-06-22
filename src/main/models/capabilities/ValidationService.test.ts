import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ValidationService } from './ValidationService'

describe('ValidationService', () => {
  it('runs requested validation checks in the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-validation-pass-'))
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'validation-pass',
        scripts: {
          typecheck: 'node -e "process.exit(0)"'
        }
      })
    )

    const service = new ValidationService()
    const result = await service.verifyChange({
      workspaceRoot: workspace,
      checks: ['typecheck']
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe('pass')
    expect(result.language).toBe('node')
    expect(result.structuredPayload.checks).toEqual([
      expect.objectContaining({ check: 'typecheck', ok: true })
    ])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('returns a failed status when validation fails', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-validation-fail-'))
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'validation-fail',
        scripts: {
          typecheck: 'node -e "process.exit(1)"'
        }
      })
    )

    const service = new ValidationService()
    const result = await service.verifyChange({
      workspaceRoot: workspace,
      checks: ['typecheck']
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('typecheck: fail')

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('returns "blocked" with a clear reason when no manifest is present', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-validation-empty-'))

    const service = new ValidationService()
    const result = await service.verifyChange({ workspaceRoot: workspace, checks: ['typecheck'] })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('blocked')
    expect(result.language).toBe('unknown')
    expect(result.summary).toMatch(/no supported workspace manifest/i)
    expect(result.structuredPayload.checks).toEqual([])

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('detects a Rust workspace and reports its language', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-validation-rust-'))
    await fs.writeFile(path.join(workspace, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.0.0"\n')

    const service = new ValidationService()
    // We don't actually want cargo to run during the test (might not be
    // installed); we only need the language detection + the "blocked" path
    // when the requested check has no command in this profile.
    const result = await service.verifyChange({
      workspaceRoot: workspace,
      checks: ['check']
    })

    expect(result.language).toBe('rust')
    // cargo may or may not be installed in CI. Either way the language is rust;
    // we don't assert on ok/status here to avoid flakiness.

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('blocks cleanly when the language has no command for the requested check', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-validation-py-'))
    await fs.writeFile(path.join(workspace, 'pyproject.toml'), '[project]\nname = "x"\nversion = "0.0.0"\n')

    const service = new ValidationService()
    const result = await service.verifyChange({
      workspaceRoot: workspace,
      checks: ['build']
    })

    expect(result.language).toBe('python')
    expect(result.status).toBe('blocked')
    expect(result.summary).toMatch(/python workspace does not support/i)

    await fs.rm(workspace, { recursive: true, force: true })
  })
})
