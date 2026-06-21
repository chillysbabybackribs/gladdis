import { app, session } from 'electron'
import { rm } from 'fs/promises'
import { join } from 'path'
import { configureStealthSession } from '../stealth'
import { BROWSER_PARTITION } from './constants'

export async function ensureSession(): Promise<void> {
  // Touch the partition early so cookies/storage persist like a real browser,
  // and present it as current real Chrome (UA + Accept-Language + Sec-CH-UA
  // client hints) so the bundled-Chromium version gap doesn't trip bot walls.
  await repairVolatileBrowserStorage()
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  configureStealthSession(browserSession)
}

async function repairVolatileBrowserStorage(): Promise<void> {
  const partitionDir = join(app.getPath('userData'), 'Partitions', 'gladdis')
  const volatileDirs = [
    'Service Worker',
    'Code Cache',
    'GPUCache',
    'DawnWebGPUCache',
    'DawnGraphiteCache'
  ]
  await Promise.all(volatileDirs.map(async (dir) => {
    try {
      await rm(join(partitionDir, dir), { recursive: true, force: true })
    } catch (err) {
      console.warn(`[browser session] failed to remove ${dir}:`, (err as Error)?.message ?? err)
    }
  }))
}
