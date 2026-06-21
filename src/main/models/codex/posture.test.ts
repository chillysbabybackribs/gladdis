import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveCodexPosture } from './posture'

describe('Codex posture', () => {
  it('uses the home directory as the default cwd with unrestricted access', () => {
    expect(resolveCodexPosture(null)).toEqual({
      cwd: homedir(),
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never'
    })
  })

  it('treats a selected folder as cwd only, not as a write sandbox', () => {
    expect(resolveCodexPosture('/tmp/gladdis-workspace')).toEqual({
      cwd: '/tmp/gladdis-workspace',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never'
    })
  })
})
