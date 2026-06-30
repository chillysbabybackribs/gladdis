import { describe, expect, it, vi, afterEach } from 'vitest'
import { runAuditCodebase, type TaskToolsDeps } from './taskTools'
import { CodebaseAuditor } from '../CodebaseAuditor'

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAIMock(this: unknown) {
    return {}
  })
}))

describe('runAuditCodebase', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to the latest substantive user request when goal is omitted', async () => {
    const auditSpy = vi
      .spyOn(CodebaseAuditor.prototype, 'runAudit')
      .mockResolvedValue('# Audit report from fallback goal')

    const deps: TaskToolsDeps = {
      files: {} as any,
      keys: { get: vi.fn().mockReturnValue('test-google-key') } as any,
      capabilityBroker: null,
      getWorkspaceRoot: () => '/tmp/workspace'
    }

    const result = await runAuditCodebase(
      deps,
      { focusPath: 'src/main' },
      {
        tabId: 'tab-1',
        latestUserText: 'audit the codebase for inefficient systems in place'
      } as any
    )

    expect(result.ok).toBe(true)
    expect(result.text).toBe('# Audit report from fallback goal')
    expect(auditSpy).toHaveBeenCalledWith(
      'src/main',
      'audit the codebase for inefficient systems in place'
    )
  })

  it('prefers an explicit goal over the turn-context fallback', async () => {
    const auditSpy = vi
      .spyOn(CodebaseAuditor.prototype, 'runAudit')
      .mockResolvedValue('# Audit report from explicit goal')

    const deps: TaskToolsDeps = {
      files: {} as any,
      keys: { get: vi.fn().mockReturnValue('test-google-key') } as any,
      capabilityBroker: null,
      getWorkspaceRoot: () => '/tmp/workspace'
    }

    await runAuditCodebase(
      deps,
      {
        goal: 'audit the codebase for efficient systems in place',
        focusPath: 'src/renderer'
      },
      {
        tabId: 'tab-1',
        latestUserText: 'audit the codebase for inefficient systems in place'
      } as any
    )

    expect(auditSpy).toHaveBeenCalledWith(
      'src/renderer',
      'audit the codebase for efficient systems in place'
    )
  })
})
