import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePhoneBridgeToken } from './phoneBridgeToken'

const userData = join(tmpdir(), 'gladdis-phone-bridge-token-vitest')
const tokenFile = join(userData, 'gladdis-phone-bridge-token')

// resolvePhoneBridgeToken's default `file` arg reads app.getPath at import time.
vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

describe('resolvePhoneBridgeToken', () => {
  beforeEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  it('prefers an explicit env override and never persists it', () => {
    const token = resolvePhoneBridgeToken('explicit-token', tokenFile)
    expect(token).toBe('explicit-token')
    expect(existsSync(tokenFile)).toBe(false)
  })

  it('generates and persists a token when none exists', async () => {
    const token = resolvePhoneBridgeToken(undefined, tokenFile)
    expect(token).toMatch(/^gbt_/)
    expect(await readFile(tokenFile, 'utf8')).toBe(token)
  })

  it('reuses the persisted token across launches (stable across restarts)', () => {
    const first = resolvePhoneBridgeToken(undefined, tokenFile)
    const second = resolvePhoneBridgeToken(undefined, tokenFile)
    expect(second).toBe(first)
  })

  it('lets an env override win over a persisted token', () => {
    const persisted = resolvePhoneBridgeToken(undefined, tokenFile)
    const overridden = resolvePhoneBridgeToken('from-env', tokenFile)
    expect(overridden).toBe('from-env')
    // env override does not clobber the persisted file
    expect(resolvePhoneBridgeToken(undefined, tokenFile)).toBe(persisted)
  })
})
