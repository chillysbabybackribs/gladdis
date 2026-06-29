import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

describe('searchWithRipgrep', () => {
  beforeEach(() => {
    execFileMock.mockReset()
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
    expect(pathLaneArgs).toContain('*ChatService.ts*')
    expect(result.hits).toEqual([
      expect.objectContaining({
        kind: 'path',
        path: '/repo/src/main/ChatService.ts',
        text: 'src/main/ChatService.ts'
      })
    ])
  })
})
