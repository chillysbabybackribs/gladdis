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
})
