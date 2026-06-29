import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

describe('searchWithRipgrep', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    vi.resetModules()
  })

  it('skips the path lane for multi-word content queries', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes('--files')) throw new Error('path lane should not run for prose queries')
      cb(null, { stdout: '', stderr: '' })
    })

    const { searchWithRipgrep } = await import('./fileSearch')
    const result = await searchWithRipgrep('/repo', 'chat service', '*.ts', 1, 8, false)

    expect(result.hits).toEqual([])
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0]?.[1]).not.toContain('--files')
  })

  it('runs a filtered path lane for filename-like queries', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes('--files')) {
        cb(null, { stdout: 'src/main/ChatService.ts\n', stderr: '' })
        return
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const { searchWithRipgrep } = await import('./fileSearch')
    const result = await searchWithRipgrep('/repo', 'ChatService.ts', '*.ts', 1, 8, false)

    expect(execFileMock).toHaveBeenCalledTimes(2)
    const pathLaneArgs = execFileMock.mock.calls.find((call) => Array.isArray(call[1]) && call[1].includes('--files'))?.[1] as
      | string[]
      | undefined
    expect(pathLaneArgs).toBeDefined()
    expect(pathLaneArgs).toContain('--files')
    expect(pathLaneArgs).toContain('/repo')
    expect(result.hits).toEqual([
      expect.objectContaining({
        kind: 'path',
        path: '/repo/src/main/ChatService.ts',
        text: 'src/main/ChatService.ts'
      })
    ])
  })

  it('reuses the warmed path index for repeated scoped filename searches', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes('--files')) {
        cb(null, { stdout: 'focus/ChatService.ts\nfocus/ChatStore.ts\n', stderr: '' })
        return
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const { resetFileSearchCachesForTest, searchWithRipgrep } = await import('./fileSearch')
    resetFileSearchCachesForTest()

    await searchWithRipgrep('/repo/src/main', 'ChatService.ts', '*.ts', 1, 8, false)
    await searchWithRipgrep('/repo/src/main', 'ChatStore.ts', '*.ts', 1, 8, false)

    const pathLaneCalls = execFileMock.mock.calls.filter((call) => Array.isArray(call[1]) && call[1].includes('--files'))
    expect(pathLaneCalls).toHaveLength(1)
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })
})
