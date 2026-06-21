import { app, safeStorage } from 'electron'
import { readFileSync, writeFile, existsSync } from 'fs'
import { join } from 'path'
import type { KeyStatus, Provider } from '../../../shared/types'

/**
 * Stores provider API keys on disk under userData, encrypted with the OS
 * keychain via Electron safeStorage when available. Keys live only in the
 * main process and are never sent to the renderer — only KeyStatus is.
 */
export class KeyStore {
  private file = join(app.getPath('userData'), 'gladdis-keys.json')
  private keys = new Map<Provider, string>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.load()
    // Environment variables take precedence and are not persisted.
    if (process.env.ANTHROPIC_API_KEY) this.keys.set('anthropic', process.env.ANTHROPIC_API_KEY)
    if (process.env.GEMINI_API_KEY) this.keys.set('google', process.env.GEMINI_API_KEY)
    if (process.env.OPENAI_API_KEY) this.keys.set('openai', process.env.OPENAI_API_KEY)
    // XAI_API_KEY is the canonical name; GROK_API_KEY is accepted as an alias.
    const grokEnv = process.env.XAI_API_KEY || process.env.GROK_API_KEY
    if (grokEnv) this.keys.set('grok', grokEnv)
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
      for (const [provider, stored] of Object.entries(raw)) {
        this.keys.set(provider as Provider, this.decrypt(stored))
      }
    } catch (e) {
      console.warn('[keys] failed to load:', e)
    }
  }

  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.writeNow()
    }, 100)
  }

  private writeNow(): void {
    const out: Record<string, string> = {}
    for (const [provider, key] of this.keys) {
      if (key) out[provider] = this.encrypt(key)
    }
    writeFile(this.file, JSON.stringify(out), { mode: 0o600 }, (e) => {
      if (e) console.warn('[keys] failed to persist:', e)
    })
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(value).toString('base64')}`
    }
    return `raw:${Buffer.from(value).toString('base64')}`
  }

  private decrypt(stored: string): string {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('raw:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    }
    return stored
  }

  get(provider: Provider): string | undefined {
    return this.keys.get(provider)
  }

  set(provider: Provider, key: string): KeyStatus {
    const trimmed = key.trim()
    if (trimmed) this.keys.set(provider, trimmed)
    else this.keys.delete(provider)
    this.persist()
    return this.status()
  }

  /**
   * Provider key status. `codex` is intentionally always false here — Codex
   * doesn't use a gladdis-stored key; its usability is reported separately via
   * CodexClient.status() (CLI install + login). Callers that care about Codex
   * read CodexStatus, not this flag.
   */
  status(): KeyStatus {
    return {
      anthropic: !!this.keys.get('anthropic'),
      google: !!this.keys.get('google'),
      codex: false,
      openai: !!this.keys.get('openai'),
      grok: !!this.keys.get('grok')
    }
  }
}
