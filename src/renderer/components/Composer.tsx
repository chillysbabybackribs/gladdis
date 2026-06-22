import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { TTS_VOICES, TTS_VOICE_HINTS, type TtsVoice } from '../../../shared/types'

export interface ComposerSubmit {
  text: string
}

interface Props {
  /** Active tab id, so slash commands act on the right page. */
  activeId: string | null
  busy?: boolean
  onSubmit: (s: ComposerSubmit) => void
  /** Abort the in-flight stream (shown as a stop button while busy). */
  onStop?: () => void
  /** Whether replies are read aloud (TTS). */
  audioOn?: boolean
  /** Toggle audible replies on/off. */
  onToggleAudio?: () => void
  /** Selected TTS voice (global). */
  voice?: TtsVoice
  onVoiceChange?: (v: TtsVoice) => void
  /** Playback speed multiplier (global, client-side playbackRate). */
  speed?: number
  onSpeedChange?: (s: number) => void
  /** Per-turn context controls, such as model and working folder. */
  turnControls?: ReactNode
  /** Start a fresh conversation (the + button, bottom-left). */
  onNewChat?: () => void
  /** Disable the + when there's nothing to start fresh from. */
  newDisabled?: boolean
}

/* ------------------------------------------------------------------ *
 * Slash commands map straight onto the browser gladdis already owns.
 * They are real actions, not stubs — each one calls window.gladdis.
 * ------------------------------------------------------------------ */
interface SlashCommand {
  name: string
  hint: string
  /** Runs against the active tab id (may be null). Return text to echo. */
  run: (activeId: string | null) => void | Promise<void>
  /** Commands that need a typed argument keep the input open instead. */
  takesArg?: boolean
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'pipeline',
    hint: 'run a deterministic browser task (1 LLM plan call, then pure CDP)',
    takesArg: true,
    run: () => {}
  },
  {
    name: 'navigate',
    hint: 'open a URL in the active tab',
    takesArg: true,
    run: () => {}
  },
  {
    name: 'tab',
    hint: 'open a new browser tab',
    run: () => void window.gladdis.tabs.create()
  },
  {
    name: 'reload',
    hint: 'reload the active page',
    run: (id) => {
      if (id) void window.gladdis.tabs.reload(id)
    }
  },
  {
    name: 'back',
    hint: 'go back in history',
    run: (id) => {
      if (id) void window.gladdis.tabs.back(id)
    }
  },
  {
    name: 'screenshot',
    hint: 'capture the active page (CDP)',
    run: (id) => {
      if (id)
        void window.gladdis.cdp.send({
          tabId: id,
          method: 'Page.captureScreenshot',
          params: { format: 'png' }
        })
    }
  }
]

export function Composer({
  activeId,
  busy,
  onSubmit,
  onStop,
  audioOn,
  onToggleAudio,
  voice,
  onVoiceChange,
  speed,
  onSpeedChange,
  turnControls,
  onNewChat,
  newDisabled
}: Props) {
  const [draft, setDraft] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const audioMenuRef = useRef<HTMLDivElement>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)

  // Close the audio settings popover on any outside click.
  useEffect(() => {
    if (!audioMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!audioMenuRef.current?.contains(e.target as Node)) setAudioMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [audioMenuOpen])

  /** Play the selected voice saying "Hello" so the user can hear it before
   *  committing. Uses the live speed so the preview matches real playback. */
  const previewVoice = async () => {
    if (previewing) return
    setPreviewing(true)
    try {
      const res = await window.gladdis.tts.speak('Hello!', voice ?? 'alloy')
      if (!res.ok || !res.audio) return
      const bytes = Uint8Array.from(atob(res.audio), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
      const el = (previewAudio.current ??= new Audio())
      el.src = url
      el.playbackRate = speed ?? 1
      el.onended = () => URL.revokeObjectURL(url)
      await el.play().catch(() => URL.revokeObjectURL(url))
    } finally {
      setPreviewing(false)
    }
  }

  // Slash menu is open when the draft is a bare "/command" token.
  const slash = draft.startsWith('/') ? draft.slice(1).split(' ')[0] : null
  const matches = useMemo(() => {
    if (slash === null) return []
    const q = slash.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  }, [slash])
  const menuOpen = slash !== null && draft.indexOf(' ') === -1 && matches.length > 0

  useEffect(() => setMenuIndex(0), [slash])

  // Always keep focus on the composer input (e.g. on mount or when busy state changes)
  useEffect(() => {
    taRef.current?.focus()
  }, [busy])

  const reset = () => {
    setDraft('')
    requestAnimationFrame(() => taRef.current?.focus())
  }

  const runCommand = async (cmd: SlashCommand) => {
    if (cmd.takesArg) {
      // Keep the slash but add a space so the menu closes and arg can be typed.
      setDraft(`/${cmd.name} `)
      requestAnimationFrame(() => taRef.current?.focus())
      return
    }
    await cmd.run(activeId)
    reset()
  }

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return

    // A completed slash command with an argument, e.g. "/navigate example.com".
    if (text.startsWith('/')) {
      const [head, ...rest] = text.slice(1).split(' ')
      const arg = rest.join(' ').trim()
      if (head === 'navigate' && arg && activeId) {
        void window.gladdis.tabs.navigate(activeId, arg)
        reset()
        return
      }
      const cmd = SLASH_COMMANDS.find((c) => c.name === head)
      if (cmd && !cmd.takesArg) {
        void runCommand(cmd)
        return
      }
    }

    onSubmit({ text })
    reset()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        void runCommand(matches[menuIndex])
        return
      }
      if (e.key === 'Escape') {
        setDraft('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
  }

  const canSend = draft.trim().length > 0 && !busy

  return (
    <div className="composer">
      {menuOpen && (
        <div className="composer-menu" role="listbox">
          <div className="composer-menu-head">browser commands</div>
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              className={`composer-menu-item ${i === menuIndex ? 'sel' : ''}`}
              onMouseEnter={() => setMenuIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void runCommand(c)}
            >
              <span className="cmd-name">/{c.name}</span>
              <span className="cmd-hint">{c.hint}</span>
            </button>
          ))}
        </div>
      )}

      <div className="composer-box">
        {turnControls && <div className="composer-context">{turnControls}</div>}
        <textarea
          ref={taRef}
          autoFocus
          className="composer-input"
          rows={1}
          placeholder="Ask or tell gladdis what to do…   ( / for commands )"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {/* Toolbar: send / stop. Screenshots are deterministic tools the model
            calls (screenshot / screenshot_app), not composer buttons. */}
        <div className="composer-bar">
          <div className="composer-bar-left">
            {onNewChat && (
              <button
                type="button"
                className="composer-new"
                disabled={newDisabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onNewChat}
                title="New chat"
                aria-label="New chat"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 3.5v9M3.5 8h9"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>
          <div className="composer-bar-right">
            {onToggleAudio && (
              <div className="composer-audio-group" ref={audioMenuRef}>
                <button
                  type="button"
                  className={`composer-audio ${audioOn ? 'on' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onToggleAudio}
                  title={audioOn ? 'Audible replies on' : 'Audible replies off'}
                  aria-pressed={audioOn}
                >
                  {audioOn ? (
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                      <path d="M3 6v4h2.5L9 13V3L5.5 6H3z" fill="currentColor" />
                      <path
                        d="M11 5.5a3 3 0 0 1 0 5M12.5 4a5 5 0 0 1 0 8"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                      <path d="M3 6v4h2.5L9 13V3L5.5 6H3z" fill="currentColor" />
                      <path
                        d="M11 6l3 4M14 6l-3 4"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </button>
                {onVoiceChange && onSpeedChange && (
                  <button
                    type="button"
                    className={`composer-audio-caret ${audioMenuOpen ? 'on' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setAudioMenuOpen((o) => !o)}
                    title="Voice & speed"
                    aria-expanded={audioMenuOpen}
                  >
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                      <path
                        d="M2 4l3 3 3-3"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {audioMenuOpen && onVoiceChange && onSpeedChange && (
                  <div className="audio-popover" role="dialog" aria-label="Audio settings">
                    <div className="audio-row">
                      <span className="audio-label">Voice</span>
                      <div className="audio-voice-row">
                        <select
                          className="audio-voice"
                          value={voice ?? 'alloy'}
                          onChange={(e) => onVoiceChange(e.target.value as TtsVoice)}
                        >
                          {TTS_VOICES.map((v) => (
                            <option key={v} value={v}>
                              {v} — {TTS_VOICE_HINTS[v]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="audio-preview"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void previewVoice()}
                          disabled={previewing}
                          title="Hear this voice"
                          aria-label="Preview voice"
                        >
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                            <path d="M3 2l7 4-7 4z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <label className="audio-row">
                      <span className="audio-label">
                        Speed <span className="audio-speed-val">{(speed ?? 1).toFixed(2)}×</span>
                      </span>
                      <input
                        className="audio-speed"
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.05}
                        value={speed ?? 1}
                        onChange={(e) => onSpeedChange(Number(e.target.value))}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
            {busy && <span className="composer-hint">working…</span>}
            {busy && onStop ? (
              <button
                type="button"
                className="composer-send composer-stop"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onStop}
                title="Stop"
              >
                <svg width="14" height="14" viewBox="0 0 16 16">
                  <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                disabled={!canSend}
                onMouseDown={(e) => e.preventDefault()}
                onClick={submit}
                title="Send"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
