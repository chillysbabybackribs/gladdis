import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { app } from 'electron'
import { dirname, join } from 'node:path'

/**
 * Resolves the phone bridge's server token, in priority order:
 *
 *   1. an explicit `GLADDIS_PHONE_BRIDGE_TOKEN` env override (never persisted)
 *   2. a previously persisted token on disk
 *   3. a freshly generated token, persisted for next launch
 *
 * Without this, the server token was `randomUUID()` per launch, so any URL or
 * installed PWA carrying the baked-in token broke after a desktop restart.
 * Pinning keeps a server-token install valid across restarts; paired-device
 * tokens already persist separately in PhoneDeviceStore.
 */
export function resolvePhoneBridgeToken(
  envToken: string | undefined = process.env.GLADDIS_PHONE_BRIDGE_TOKEN,
  file = join(app.getPath('userData'), 'gladdis-phone-bridge-token')
): string {
  const explicit = envToken?.trim()
  if (explicit) return explicit

  const persisted = readToken(file)
  if (persisted) return persisted

  const token = newBridgeToken()
  writeToken(file, token)
  return token
}

function readToken(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const value = readFileSync(file, 'utf8').trim()
    return value || null
  } catch (error) {
    console.warn('[phone] failed to read bridge token:', error)
    return null
  }
}

function writeToken(file: string, token: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, token, { mode: 0o600 })
  } catch (error) {
    // Non-fatal: fall back to an in-memory token for this launch only.
    console.warn('[phone] failed to persist bridge token:', error)
  }
}

function newBridgeToken(): string {
  return `gbt_${randomBytes(32).toString('base64url')}`
}
