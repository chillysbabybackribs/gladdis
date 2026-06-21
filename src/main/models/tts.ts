import type { KeyStore } from './KeyStore'
import { TTS_VOICES, type TtsResult, type TtsVoice } from '../../../shared/chat'

/** OpenAI TTS model. gpt-4o-mini-tts is the cheapest good voice
 *  (~$0.015 / 1000 chars). mp3 plays directly in the renderer's <audio>.
 *  Speed is applied client-side via <audio>.playbackRate (not a synth param —
 *  gpt-4o-mini-tts ignores the API `speed` field), so it isn't sent here. */
const TTS_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_VOICE: TtsVoice = 'alloy'
const TTS_ENDPOINT = 'https://api.openai.com/v1/audio/speech'

/**
 * Synthesize speech for a chunk of reply text via OpenAI. Used only when the
 * user has toggled audible replies on; converts text the model ALREADY produced
 * into audio. It never calls a chat model and is completely independent of the
 * Codex path — Codex replies still cost nothing to generate; only this optional
 * TTS step (when enabled) incurs OpenAI's per-character charge.
 *
 * Returns a structured result instead of throwing so a missing key or a network
 * blip degrades to silence without ever breaking the chat stream.
 */
export async function synthesizeSpeech(
  keys: KeyStore,
  text: string,
  voice?: string
): Promise<TtsResult> {
  const key = keys.get('openai')
  if (!key) return { ok: false, reason: 'no-key' }

  const trimmed = text.trim()
  if (!trimmed) return { ok: true, audio: '', format: 'mp3' }

  // Validate against the known list so a stale/bad value can't reach the API.
  const safeVoice: TtsVoice =
    voice && (TTS_VOICES as readonly string[]).includes(voice) ? (voice as TtsVoice) : DEFAULT_VOICE

  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: safeVoice,
        input: trimmed,
        response_format: 'mp3'
      })
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: 'error', message: `OpenAI TTS ${res.status}: ${detail.slice(0, 200)}` }
    }
    // A 200 can still carry a JSON error (or empty) body instead of audio; the
    // renderer would then fail with "no supported source". Catch that here and
    // report the actual body so the cause is visible, not a decode mystery.
    const ct = res.headers.get('content-type') ?? ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (!ct.startsWith('audio/') || buf.length === 0) {
      const body = buf.toString('utf8').slice(0, 200)
      return {
        ok: false,
        reason: 'error',
        message: `OpenAI TTS returned ${ct || 'no content-type'} (${buf.length} bytes): ${body}`
      }
    }
    return { ok: true, audio: buf.toString('base64'), format: 'mp3' }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}
