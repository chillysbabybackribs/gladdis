import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/gladdis-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8')
  }
}))

import { synthesizeSpeech } from './tts'

/** Minimal KeyStore stand-in: only get('openai') matters for TTS. */
function keysWith(openai?: string) {
  return { get: (p: string) => (p === 'openai' ? openai : undefined) } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('synthesizeSpeech', () => {
  it('returns no-key (no network call) when the OpenAI key is unset', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await synthesizeSpeech(keysWith(undefined), 'hello')
    expect(res).toEqual({ ok: false, reason: 'no-key' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns empty ok for whitespace-only text without calling the API', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await synthesizeSpeech(keysWith('sk-test'), '   ')
    expect(res).toEqual({ ok: true, audio: '', format: 'mp3' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns base64 audio on a successful synthesis', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Map([['content-type', 'audio/mpeg']]),
        arrayBuffer: async () => bytes.buffer
      }))
    )
    const res = await synthesizeSpeech(keysWith('sk-test'), 'speak this')
    expect(res).toEqual({ ok: true, audio: Buffer.from(bytes).toString('base64'), format: 'mp3' })
  })

  it('reports a 200 that carries a JSON error body instead of audio', async () => {
    const body = Buffer.from('{"error":{"message":"bad model"}}')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      }))
    )
    const res = await synthesizeSpeech(keysWith('sk-test'), 'speak this')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('error')
      expect(res.message).toContain('bad model')
    }
  })

  it('degrades to an error result (never throws) on an API failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' }))
    )
    const res = await synthesizeSpeech(keysWith('sk-test'), 'speak this')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('error')
      expect(res.message).toContain('401')
    }
  })

  it('degrades to an error result when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    const res = await synthesizeSpeech(keysWith('sk-test'), 'speak this')
    expect(res).toEqual({ ok: false, reason: 'error', message: 'network down' })
  })
})
