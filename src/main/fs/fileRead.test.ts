import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLineRange } from './fileRead'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeTempFile(lines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-file-read-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'example.ts')
  await fs.writeFile(filePath, lines.join('\n'))
  return filePath
}

describe('readLineRange', () => {
  it('stops after the requested end line when total counts are not needed', async () => {
    const filePath = await makeTempFile(['alpha', 'beta', 'gamma', 'delta'])

    const result = await readLineRange(filePath, 2, 3)

    expect(result.content).toBe('beta\ngamma')
    expect(result.startLine).toBe(2)
    expect(result.endLine).toBe(3)
    expect(result.totalLines).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('keeps counting total lines when explicitly requested', async () => {
    const filePath = await makeTempFile(['alpha', 'beta', 'gamma', 'delta'])

    const result = await readLineRange(filePath, 2, 3, { countTotalLines: true })

    expect(result.content).toBe('beta\ngamma')
    expect(result.totalLines).toBe(4)
    expect(result.endLine).toBe(3)
  })
})
