import { useCallback, useEffect, useRef, useState } from 'react'
import type { TtsVoice } from '../../../shared/types'

const VOICE_KEY = 'gladdis:tts:voice'
const SPEED_KEY = 'gladdis:tts:speed'

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.warn(`Failed to set localStorage key "${key}":`, e)
  }
}

/**
 * Global (cross-panel) TTS voice + playback speed, persisted to localStorage.
 * Both chat panels share these, so a `storage` event mirrors a change made in
 * one panel into the other (storage events fire cross-document, not in the
 * writer). The on/off toggle stays per-panel and lives in ChatPanel.
 */
export function useTtsSettings() {
  const [voice, setVoice] = useState<TtsVoice>(
    () => (safeGetItem(VOICE_KEY) as TtsVoice) || 'alloy'
  )
  const [speed, setSpeed] = useState<number>(() => Number(safeGetItem(SPEED_KEY)) || 1)

  const persistVoice = useCallback((v: TtsVoice) => {
    setVoice(v)
    safeSetItem(VOICE_KEY, v)
  }, [])
  const persistSpeed = useCallback((s: number) => {
    setSpeed(s)
    safeSetItem(SPEED_KEY, String(s))
  }, [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === VOICE_KEY && e.newValue) setVoice(e.newValue as TtsVoice)
      if (e.key === SPEED_KEY && e.newValue) setSpeed(Number(e.newValue) || 1)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return { voice, speed, setVoice: persistVoice, setSpeed: persistSpeed }
}

/**
 * Reads a model reply aloud, once, when audible replies are toggled on.
 *
 * Deliberately ONE TTS call per reply: `speak` only accumulates the streamed
 * text, and `flush` (called on the reply's `done`) synthesizes the whole thing
 * in a single OpenAI request and plays the single resulting clip. This is why
 * the audio can't reorder, drop its first words, or switch voice mid-reply —
 * every one of those came from splitting a reply across many async TTS calls.
 * The cost is that audio begins a beat after the reply finishes, not while it
 * streams; that tradeoff buys correctness and a much simpler hook.
 *
 * It reads text the model already produced and is independent of how that text
 * was generated — Codex's keyless free path is never involved here.
 *
 * One `generation` counter is the only concurrency guard needed: `stop()` bumps
 * it so a synth still in flight from an aborted reply (or a slow one the user
 * interrupted) can't play over the next reply.
 */
export function useTts(
  enabled: boolean,
  opts?: { voice?: string; speed?: number; onError?: (message: string) => void }
) {
  // Keep the latest opts reachable from stable callbacks without re-creating
  // them (which would re-subscribe the chat stream in the parent).
  const onErrorRef = useRef(opts?.onError)
  onErrorRef.current = opts?.onError
  const voiceRef = useRef(opts?.voice)
  voiceRef.current = opts?.voice
  const speedRef = useRef(opts?.speed ?? 1)
  speedRef.current = opts?.speed ?? 1
  // The reply text accumulated so far (spoken in one call on flush()).
  const buffer = useRef('')
  const audio = useRef<HTMLAudioElement | null>(null)
  // Bumped on every stop(); a synth/playback tagged with an older value is a
  // no-op, so an aborted reply's audio never plays over the next reply.
  const generation = useRef(0)

  /** Accumulate streamed delta text. Does NOT synthesize — flush() does. */
  const speak = useCallback(
    (delta: string) => {
      if (!enabled) return
      buffer.current += delta
    },
    [enabled]
  )

  /** Synthesize the whole accumulated reply in one call and play it (on done). */
  const flush = useCallback(async () => {
    if (!enabled) return
    const text = buffer.current.trim()
    buffer.current = ''
    if (!text) return

    const gen = generation.current
    const res = await window.gladdis.tts.speak(text, voiceRef.current)
    // Aborted while the request was in flight — drop it.
    if (gen !== generation.current) return
    if (!res.ok) {
      // Surface real failures (bad key / network) instead of failing silently.
      if (res.reason === 'error' && res.message) onErrorRef.current?.(`TTS failed — ${res.message}`)
      return
    }
    if (!res.audio) return

    const bytes = Uint8Array.from(atob(res.audio), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
    const el = (audio.current ??= new Audio())
    el.src = url
    // Speed is a free, instant client-side playback-rate change — no re-synth.
    el.playbackRate = speedRef.current
    const cleanup = () => URL.revokeObjectURL(url)
    el.onended = cleanup
    el.onerror = cleanup
    void el.play().catch((e) => {
      cleanup()
      if (gen !== generation.current) return
      // Most commonly a browser autoplay block — surface it rather than swallow.
      onErrorRef.current?.(`TTS playback blocked — ${e instanceof Error ? e.message : String(e)}`)
    })
  }, [enabled])

  /** Silence everything and discard buffered text (new send / abort / toggle off). */
  const stop = useCallback(() => {
    generation.current += 1
    buffer.current = ''
    if (audio.current) {
      audio.current.onended = null
      audio.current.onerror = null
      audio.current.pause()
      audio.current.src = ''
    }
  }, [])

  // Toggling audio off mid-reply stops playback immediately.
  useEffect(() => {
    if (!enabled) stop()
  }, [enabled, stop])

  return { speak, flush, stop }
}
