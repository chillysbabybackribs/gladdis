import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneDeviceStore } from './PhoneDeviceStore'

const userData = join(tmpdir(), 'gladdis-phone-device-store-vitest')

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

describe('PhoneDeviceStore', () => {
  beforeEach(async () => {
    await rm(userData, { recursive: true, force: true })
    await mkdir(userData, { recursive: true })
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  it('creates durable device tokens without persisting the raw token', async () => {
    const store = new PhoneDeviceStore()
    const { device, token } = store.create('Dale phone')

    expect(token).toMatch(/^gph_/)
    expect(device.label).toBe('Dale phone')
    expect(store.authenticate(token)?.id).toBe(device.id)

    await store.flush()
    const raw = await readFile(join(userData, 'gladdis-phone-devices.json'), 'utf8')
    expect(raw).not.toContain(token)
    expect(raw).toContain('tokenHash')
  })

  it('loads existing devices and rejects revoked tokens', async () => {
    const first = new PhoneDeviceStore()
    const { device, token } = first.create()
    await first.flush()

    const second = new PhoneDeviceStore()
    expect(second.authenticate(token)?.id).toBe(device.id)
    expect(second.revoke(device.id)).toBe(true)
    expect(second.authenticate(token)).toBeNull()
  })
})
