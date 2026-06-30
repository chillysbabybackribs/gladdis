import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { dirname, join } from 'node:path'
import type { PhoneBridgeDevice } from '../../../shared/types'

interface StoredPhoneDevice extends PhoneBridgeDevice {
  tokenHash: string
  revokedAt: number | null
}

interface PhoneDeviceFile {
  version: 1
  devices: StoredPhoneDevice[]
}

export class PhoneDeviceStore {
  private readonly file: string
  private devices = new Map<string, StoredPhoneDevice>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(file = join(app.getPath('userData'), 'gladdis-phone-devices.json')) {
    this.file = file
    this.load()
  }

  list(): PhoneBridgeDevice[] {
    return [...this.devices.values()]
      .filter((device) => !device.revokedAt)
      .map(toPublicDevice)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  create(label = 'Phone'): { device: PhoneBridgeDevice; token: string } {
    const now = Date.now()
    const token = newDeviceToken()
    const device: StoredPhoneDevice = {
      id: randomUUID(),
      label: normalizeLabel(label),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null
    }
    this.devices.set(device.id, device)
    this.schedulePersist()
    return { device: toPublicDevice(device), token }
  }

  authenticate(token: string): PhoneBridgeDevice | null {
    const tokenHash = hashToken(token)
    for (const device of this.devices.values()) {
      if (device.revokedAt || device.tokenHash !== tokenHash) continue
      device.lastSeenAt = Date.now()
      this.schedulePersist()
      return toPublicDevice(device)
    }
    return null
  }

  revoke(id: string): boolean {
    const device = this.devices.get(id)
    if (!device || device.revokedAt) return false
    device.revokedAt = Date.now()
    this.schedulePersist()
    return true
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.persist()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as PhoneDeviceFile
      if (!raw || raw.version !== 1 || !Array.isArray(raw.devices)) return
      for (const device of raw.devices) {
        if (!isStoredDevice(device)) continue
        this.devices.set(device.id, device)
      }
    } catch (error) {
      console.warn('[phone] failed to load paired devices:', error)
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 50)
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`
    const payload: PhoneDeviceFile = {
      version: 1,
      devices: [...this.devices.values()]
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(tmp, this.file)
  }
}

function toPublicDevice(device: StoredPhoneDevice): PhoneBridgeDevice {
  return {
    id: device.id,
    label: device.label,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt
  }
}

function isStoredDevice(value: unknown): value is StoredPhoneDevice {
  if (!value || typeof value !== 'object') return false
  const device = value as Record<string, unknown>
  return (
    typeof device.id === 'string' &&
    typeof device.label === 'string' &&
    typeof device.tokenHash === 'string' &&
    typeof device.createdAt === 'number' &&
    (typeof device.lastSeenAt === 'number' || device.lastSeenAt === null) &&
    (typeof device.revokedAt === 'number' || device.revokedAt === null)
  )
}

function normalizeLabel(value: string): string {
  const label = value.trim()
  return label.slice(0, 80) || 'Phone'
}

function newDeviceToken(): string {
  return `gph_${randomBytes(32).toString('base64url')}`
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
