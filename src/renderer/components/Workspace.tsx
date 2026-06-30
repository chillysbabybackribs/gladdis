import { useEffect, useRef, useState } from 'react'
import { ChatPanel } from './ChatPanel'
import { BrowserPanel } from './BrowserPanel'
import { Splitter, DRAWER_MIN } from './Splitter'
import { TerminalDock, type TerminalDockPos } from './TerminalDock'
import { TerminalToggle } from './TerminalToggle'
import { NotepadToggle } from './NotepadToggle'
import { NotepadDock, type NotepadDockPos } from './NotepadDock'
import { useTerminal } from '../hooks/useTerminal'
import AgentBuilderModal from './AgentBuilderModal'
import { MemoryController } from './MemoryController'
import { TitleBar } from './TitleBar'
import type { AppCommand, SavedAgent } from '../../../shared/types'

const LEFT_KEY = 'gladdis:drawer:left'
const RIGHT_KEY = 'gladdis:drawer:right'
const LEFT_FRAC_KEY = 'gladdis:drawer:left:frac'
const RIGHT_FRAC_KEY = 'gladdis:drawer:right:frac'
const LEFT_ZOOM_KEY = 'gladdis:chat:left:zoom'
const RIGHT_ZOOM_KEY = 'gladdis:chat:right:zoom'
const BROWSER_ZOOM_KEY = 'gladdis:browser:zoom'
const TERMINAL_DOCK_KEY = 'gladdis:terminal:dock'
const TERMINAL_LAST_DOCK_KEY = 'gladdis:terminal:lastDock'
const TERMINAL_HEIGHT_KEY = 'gladdis:terminal:height'
const NOTEPAD_DOCK_KEY = 'gladdis:notepad:dock'
const NOTEPAD_LAST_DOCK_KEY = 'gladdis:notepad:lastDock'

const DEFAULT_LEFT_FRAC = 0.16
const DEFAULT_RIGHT_FRAC = 0.16
const DEFAULT_TERMINAL_HEIGHT = 280
const ZOOM_MIN = 0.85
const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.1
const ZOOM_DEFAULT = 1
// Browser zoom uses a wider range than the chat zoom — web pages legitimately
// need to go smaller (data-dense dashboards) and larger (text-heavy reading)
// than chat ever should. Same 10% step so the menu feels identical.
const BROWSER_ZOOM_MIN = 0.5
const BROWSER_ZOOM_MAX = 2.5
const BROWSER_ZOOM_STEP = 0.1
const BROWSER_ZOOM_DEFAULT = 1

type TerminalDockState = 'closed' | TerminalDockPos
type NotepadDockState = 'closed' | NotepadDockPos

function loadTerminalDock(): TerminalDockState {
  const v = safeGetItem(TERMINAL_DOCK_KEY)
  return v === 'bottom' || v === 'left' || v === 'right' ? v : 'closed'
}
function loadLastDock(): TerminalDockPos {
  const v = safeGetItem(TERMINAL_LAST_DOCK_KEY)
  return v === 'left' || v === 'right' ? v : 'bottom'
}
function loadTerminalHeight(): number {
  const v = parseFloat(safeGetItem(TERMINAL_HEIGHT_KEY) ?? '')
  return Number.isFinite(v) && v >= 120 ? v : DEFAULT_TERMINAL_HEIGHT
}
function loadNotepadDock(): NotepadDockState {
  const v = safeGetItem(NOTEPAD_DOCK_KEY)
  return v === 'left' || v === 'right' || v === 'bottom' ? v : 'closed'
}
function loadLastNotepadDock(): NotepadDockPos {
  const v = safeGetItem(NOTEPAD_LAST_DOCK_KEY)
  return v === 'left' || v === 'bottom' ? v : 'right'
}

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

function loadBool(key: string, fallback: boolean): boolean {
  const v = safeGetItem(key)
  return v === null ? fallback : v === '1'
}
function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return ZOOM_DEFAULT
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100))
}
function clampBrowserZoom(v: number): number {
  if (!Number.isFinite(v)) return BROWSER_ZOOM_DEFAULT
  return Math.min(BROWSER_ZOOM_MAX, Math.max(BROWSER_ZOOM_MIN, Math.round(v * 100) / 100))
}
function loadFrac(key: string, fallback: number): number {
  const v = parseFloat(safeGetItem(key) ?? '')
  return Number.isFinite(v) ? v : fallback
}
function loadZoom(key: string): number {
  return clampZoom(parseFloat(safeGetItem(key) ?? String(ZOOM_DEFAULT)))
}
function loadBrowserZoom(): number {
  return clampBrowserZoom(
    parseFloat(safeGetItem(BROWSER_ZOOM_KEY) ?? String(BROWSER_ZOOM_DEFAULT))
  )
}

function DrawerChevron({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const points =
    side === 'left'
      ? open
        ? '11 5 7 9 11 13'
        : '7 5 11 9 7 13'
      : open
        ? '7 5 11 9 7 13'
        : '11 5 7 9 11 13'

  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d={`M${points}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Three-column workspace: a retractable chat/agent drawer on each side of the
 * center native-Chromium browser.
 *
 *   [ ChatPanel "left" ] | splitter | [ BrowserPanel (flex-1) ] | splitter | [ ChatPanel "right" ]
 *
 * Each drawer collapses to 0 width with a CSS width transition; the center
 * browser is flex-1 so it fills whatever space is left, and its native view
 * tracks the resulting hole via useSlotBounds (inside BrowserPanel). Open/closed
 * state and width fractions persist to localStorage. The left drawer opens by
 * default (mirrors gladdis's chat-on-the-left); the right opens on demand.
 */
export function Workspace() {
  const rowRef = useRef<HTMLDivElement>(null)
  const [leftFooterSlot, setLeftFooterSlot] = useState<HTMLDivElement | null>(null)
  const [rightFooterSlot, setRightFooterSlot] = useState<HTMLDivElement | null>(null)
  const [leftFooterTokenSlot, setLeftFooterTokenSlot] = useState<HTMLDivElement | null>(null)
  const [rightFooterTokenSlot, setRightFooterTokenSlot] = useState<HTMLDivElement | null>(null)
  const [leftOpen, setLeftOpen] = useState(() => loadBool(LEFT_KEY, true))
  const [rightOpen, setRightOpen] = useState(() => loadBool(RIGHT_KEY, false))
  const [leftFrac, setLeftFrac] = useState(() => loadFrac(LEFT_FRAC_KEY, DEFAULT_LEFT_FRAC))
  const [rightFrac, setRightFrac] = useState(() => loadFrac(RIGHT_FRAC_KEY, DEFAULT_RIGHT_FRAC))
  const [leftZoom, setLeftZoom] = useState(() => loadZoom(LEFT_ZOOM_KEY))
  const [rightZoom, setRightZoom] = useState(() => loadZoom(RIGHT_ZOOM_KEY))
  const [browserZoom, setBrowserZoom] = useState(loadBrowserZoom)
  const [terminalDock, setTerminalDockState] = useState<TerminalDockState>(loadTerminalDock)
  const [notepadDock, setNotepadDockState] = useState<NotepadDockState>(loadNotepadDock)
  const [isAgentBuilderOpen, setIsAgentBuilderOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<SavedAgent | null>(null)
  const [terminalHeight, setTerminalHeight] = useState<number>(loadTerminalHeight)
  const [lastDock, setLastDock] = useState<TerminalDockPos>(loadLastDock)
  const [lastNotepadDock, setLastNotepadDock] = useState<NotepadDockPos>(loadLastNotepadDock)
  const terminalHostRef = useRef<HTMLDivElement>(null)
  const terminalHandle = useTerminal(terminalHostRef)

  const leftWidth = leftOpen ? `${Math.max(DRAWER_MIN, leftFrac) * 100}%` : '0px'
  const rightWidth = rightOpen ? `${Math.max(DRAWER_MIN, rightFrac) * 100}%` : '0px'

  // Sending the terminal to a side dock guarantees that side's drawer is open
  // (otherwise the terminal would render into a width:0 column and vanish).
  // Closing the dock or moving it elsewhere leaves drawer state untouched.
  const setTerminalDock = (next: TerminalDockState) => {
    if (next !== 'closed' && next === notepadDock) {
      setNotepadDockState('closed')
      safeSetItem(NOTEPAD_DOCK_KEY, 'closed')
    }
    setTerminalDockState(next)
    safeSetItem(TERMINAL_DOCK_KEY, next)
    if (next !== 'closed') {
      setLastDock(next)
      safeSetItem(TERMINAL_LAST_DOCK_KEY, next)
    }
    if (next === 'left' && !leftOpen) {
      setLeftOpen(true)
      safeSetItem(LEFT_KEY, '1')
    }
    if (next === 'right' && !rightOpen) {
      setRightOpen(true)
      safeSetItem(RIGHT_KEY, '1')
    }
  }

  const setNotepadDock = (next: NotepadDockState) => {
    if (next !== 'closed' && next === terminalDock) {
      setTerminalDockState('closed')
      safeSetItem(TERMINAL_DOCK_KEY, 'closed')
    }
    setNotepadDockState(next)
    safeSetItem(NOTEPAD_DOCK_KEY, next)
    if (next !== 'closed') {
      setLastNotepadDock(next)
      safeSetItem(NOTEPAD_LAST_DOCK_KEY, next)
    }
    if (next === 'left' && !leftOpen) {
      setLeftOpen(true)
      safeSetItem(LEFT_KEY, '1')
    }
    if (next === 'right' && !rightOpen) {
      setRightOpen(true)
      safeSetItem(RIGHT_KEY, '1')
    }
  }

  // Drawer toggle interactions with the terminal:
  //   • Opening a drawer occupied by the terminal -> kick terminal to bottom
  //     so the chat reappears (sticky-last preserved on dock state).
  //   • Closing a drawer occupied by the terminal -> kick to bottom too, so
  //     the user never loses their shell session by hitting the chevron.
  const toggleLeft = () => {
    setLeftOpen((open) => {
      const next = !open
      safeSetItem(LEFT_KEY, next ? '1' : '0')
      if (terminalDock === 'left') setTerminalDock('bottom')
      if (notepadDock === 'left') setNotepadDock('closed')
      return next
    })
  }
  const toggleRight = () => {
    setRightOpen((open) => {
      const next = !open
      safeSetItem(RIGHT_KEY, next ? '1' : '0')
      if (terminalDock === 'right') setTerminalDock('bottom')
      if (notepadDock === 'right') setNotepadDock('closed')
      return next
    })
  }
  const onLeftFrac = (f: number) => {
    setLeftFrac(f)
    safeSetItem(LEFT_FRAC_KEY, String(f))
  }
  const onRightFrac = (f: number) => {
    setRightFrac(f)
    safeSetItem(RIGHT_FRAC_KEY, String(f))
  }
  // Chat zoom is driven by the native View > Chat Left / Chat Right menus.
  // Functional updaters keep this independent of the AppCommand effect's deps
  // so the handler always sees the freshest zoom for the side being adjusted.
  const applyChatZoom = (panel: 'left' | 'right', action: 'in' | 'out' | 'reset') => {
    const setter = panel === 'left' ? setLeftZoom : setRightZoom
    const key = panel === 'left' ? LEFT_ZOOM_KEY : RIGHT_ZOOM_KEY
    setter((current) => {
      const next =
        action === 'reset'
          ? ZOOM_DEFAULT
          : clampZoom(current + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP))
      safeSetItem(key, String(next))
      return next
    })
  }
  // Browser zoom — single value shared across every tab. Mirrors the chat
  // zoom shape, with one extra hop: we ping main via the preload bridge so
  // the WebContentsView's zoomFactor is updated for both the active tab and
  // any future tab. Functional updater for the same dep-stability reason.
  const applyBrowserZoom = (action: 'in' | 'out' | 'reset') => {
    setBrowserZoom((current) => {
      const next =
        action === 'reset'
          ? BROWSER_ZOOM_DEFAULT
          : clampBrowserZoom(
              current + (action === 'in' ? BROWSER_ZOOM_STEP : -BROWSER_ZOOM_STEP)
            )
      safeSetItem(BROWSER_ZOOM_KEY, String(next))
      window.gladdis.browser.setZoom(next)
      return next
    })
  }

  const toggleTerminal = () => {
    setTerminalDock(terminalDock === 'closed' ? lastDock : 'closed')
  }

  const toggleNotepad = () => {
    setNotepadDock(notepadDock === 'closed' ? lastNotepadDock : 'closed')
  }

  const openTerminal = () => {
    setTerminalDock(terminalDock === 'closed' ? lastDock : terminalDock)
  }

  const runTerminalCommand = async (command: string) => {
    openTerminal()
    const id = await terminalHandle.ensurePty()
    if (!id) return
    terminalHandle.focus()
    window.gladdis.terminal.write(id, `${command}\r`)
  }

  const editAgent = (agent: SavedAgent) => {
    setEditingAgent(agent)
    setIsAgentBuilderOpen(true)
  }

  useEffect(() => {
    const off = window.gladdis.app.onCommand((command: AppCommand) => {
      if (command.type === 'terminal:run') {
        void runTerminalCommand(command.command)
        return
      }
      if (command.type === 'agents:create') {
        setEditingAgent(null)
        setIsAgentBuilderOpen(true)
        return
      }
      if (command.type === 'agents:edit') {
        // Resolve the id to the live agent, then open the builder to edit it.
        void window.gladdis.agents.list().then((list) => {
          const agent = list.find((candidate) => candidate.id === command.agentId)
          if (agent) editAgent(agent)
        })
        return
      }
      if (command.type === 'chat:zoom') {
        applyChatZoom(command.panel, command.action)
        return
      }
      if (command.type === 'browser:zoom') {
        applyBrowserZoom(command.action)
        return
      }
    })
    return off
  }, [lastDock, terminalDock, terminalHandle])

  // Push the persisted browser zoom to main once on mount so the first tab
  // (created at startup) and any new tabs use it. Main re-applies on
  // did-finish-load too, so cross-origin nav can't quietly snap to 100%.
  useEffect(() => {
    window.gladdis.browser.setZoom(browserZoom)
    // Intentionally empty deps — this is a one-shot sync, subsequent updates
    // already round-trip through applyBrowserZoom -> browser.setZoom().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.gladdis.layout.setBrowserVisible(!isAgentBuilderOpen)
    return () => window.gladdis.layout.setBrowserVisible(true)
  }, [isAgentBuilderOpen])

  // Restore drawer openness when notepad was left docked to a side panel.
  useEffect(() => {
    if (notepadDock === 'left' && !leftOpen) {
      setLeftOpen(true)
      safeSetItem(LEFT_KEY, '1')
    }
    if (notepadDock === 'right' && !rightOpen) {
      setRightOpen(true)
      safeSetItem(RIGHT_KEY, '1')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTerminalHeightChange = (h: number) => {
    setTerminalHeight(h)
    safeSetItem(TERMINAL_HEIGHT_KEY, String(h))
  }

  // Bottom dock pushes the BROWSER up, never the chats. We do that by mounting
  // <TerminalDock dock="bottom"/> inside .workspace-center and applying its
  // height as paddingBottom only to that column. The drawers are siblings of
  // .workspace-center inside .workspace-main-row, so their height is untouched.
  // The native WebContentsView shrinks automatically because .browser-stage is
  // flex:1 inside .browser inside .workspace-center, and useSlotBounds reports
  // the new rect to TabManager.

  const bottomDockActive = terminalDock === 'bottom' || notepadDock === 'bottom'
  const leftDockActive = terminalDock === 'left' && leftOpen
  const rightDockActive = terminalDock === 'right' && rightOpen
  const leftNotepadActive = notepadDock === 'left' && leftOpen
  const rightNotepadActive = notepadDock === 'right' && rightOpen
  const bottomTerminalActive = terminalDock === 'bottom'
  const bottomNotepadActive = notepadDock === 'bottom'

  return (
    <div className="workspace">
      <TitleBar />

      {/* Singleton xterm canvas lives inside this hidden host div. TerminalSlot
          adopts the xterm container via appendChild so the same shell session
          and the same scrollback survive moving between dock positions. */}
      <div
        id="gladdis-terminal-host"
        ref={terminalHostRef}
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          width: 0,
          height: 0,
          left: -99999,
          top: -99999,
          overflow: 'hidden'
        }}
      />

      <div className="workspace-main">
        <div className="workspace-main-row" ref={rowRef}>
          {/* Left drawer */}
          <div
            className={`drawer drawer-left ${leftOpen ? 'open' : 'closed'}`}
            style={{ width: leftWidth }}
          >
            {leftDockActive ? (
              <>
                <div style={{ display: 'none' }}>
                  <ChatPanel
                    panelId="left"
                    zoom={leftZoom}
                    footerSlot={null}
                    footerTokenSlot={null}
                    onCreateAgent={() => {
                      setEditingAgent(null)
                      setIsAgentBuilderOpen(true)
                    }}
                    onEditAgent={editAgent}
                  />
                </div>
                <TerminalDock
                  dock="left"
                  handle={terminalHandle}
                  onClose={() => setTerminalDock('closed')}
                  onDockChange={setTerminalDock}
                />
              </>
            ) : leftNotepadActive ? (
              <NotepadDock
                dock="left"
                onClose={() => setNotepadDock('closed')}
                onDockChange={setNotepadDock}
              />
            ) : (
              <ChatPanel
                panelId="left"
                zoom={leftZoom}
                footerSlot={leftOpen ? leftFooterSlot : null}
                footerTokenSlot={leftOpen ? leftFooterTokenSlot : null}
                onCreateAgent={() => {
                  setEditingAgent(null)
                  setIsAgentBuilderOpen(true)
                }}
                onEditAgent={editAgent}
              />
            )}
          </div>
          {leftOpen && <Splitter containerRef={rowRef} onFraction={onLeftFrac} side="left" />}

          {/* Center native browser — fills the remaining space. The bottom
              terminal dock is positioned absolutely inside this column so it
              only shortens the browser, never the adjacent chat drawers. */}
          <div
            className={`workspace-center ${bottomDockActive ? 'has-bottom-terminal' : ''}`}
            style={
              bottomDockActive ? { paddingBottom: `${terminalHeight}px` } : undefined
            }
          >
            <BrowserPanel />
            {bottomTerminalActive && (
              <TerminalDock
                dock="bottom"
                handle={terminalHandle}
                onClose={() => setTerminalDock('closed')}
                onDockChange={setTerminalDock}
                height={terminalHeight}
                onHeightChange={onTerminalHeightChange}
              />
            )}
            {bottomNotepadActive && (
              <NotepadDock
                dock="bottom"
                onClose={() => setNotepadDock('closed')}
                onDockChange={setNotepadDock}
                height={terminalHeight}
                onHeightChange={onTerminalHeightChange}
              />
            )}
          </div>

          {/* Right drawer */}
          {rightOpen && (
            <Splitter containerRef={rowRef} onFraction={onRightFrac} side="right" />
          )}
          <div
            className={`drawer drawer-right ${rightOpen ? 'open' : 'closed'}`}
            style={{ width: rightWidth }}
          >
            {rightDockActive ? (
              <>
                <div style={{ display: 'none' }}>
                  <ChatPanel
                    panelId="right"
                    zoom={rightZoom}
                    footerSlot={null}
                    footerTokenSlot={null}
                    onCreateAgent={() => {
                      setEditingAgent(null)
                      setIsAgentBuilderOpen(true)
                    }}
                    onEditAgent={editAgent}
                  />
                </div>
                <TerminalDock
                  dock="right"
                  handle={terminalHandle}
                  onClose={() => setTerminalDock('closed')}
                  onDockChange={setTerminalDock}
                />
              </>
            ) : rightNotepadActive ? (
              <NotepadDock
                dock="right"
                onClose={() => setNotepadDock('closed')}
                onDockChange={setNotepadDock}
              />
            ) : (
              <ChatPanel
                panelId="right"
                zoom={rightZoom}
                footerSlot={rightOpen ? rightFooterSlot : null}
                footerTokenSlot={rightOpen ? rightFooterTokenSlot : null}
                onCreateAgent={() => {
                  setEditingAgent(null)
                  setIsAgentBuilderOpen(true)
                }}
                onEditAgent={editAgent}
              />
            )}
          </div>
        </div>
      </div>

      <footer className="workspace-footer" aria-label="Chat controls">
        <div
          className={`footer-chat-controls left ${leftOpen ? 'is-open' : ''}`}
          style={{ width: leftOpen ? leftWidth : undefined }}
        >
          <button
            className={`footer-chat-toggle ${leftOpen ? 'is-open' : ''}`}
            title={leftOpen ? 'Hide left chat' : 'Show left chat'}
            aria-label={leftOpen ? 'Hide left chat' : 'Show left chat'}
            aria-expanded={leftOpen}
            onClick={toggleLeft}
          >
            <DrawerChevron side="left" open={leftOpen} />
          </button>
          {leftOpen && !leftDockActive && !leftNotepadActive && (
            <>
              <div className="footer-token-slot" ref={setLeftFooterTokenSlot} />
              <div className="footer-action-slot" ref={setLeftFooterSlot} />
            </>
          )}
        </div>
        <div className="workspace-footer-spacer" />
        <div className="footer-center-controls">
          <NotepadToggle open={notepadDock !== 'closed'} onClick={toggleNotepad} />
          <TerminalToggle open={terminalDock !== 'closed'} onClick={toggleTerminal} />
        </div>
        <div className="workspace-footer-spacer" />
        <div
          className={`footer-chat-controls right ${rightOpen ? 'is-open' : ''}`}
          style={{ width: rightOpen ? rightWidth : undefined }}
        >
          {rightOpen && !rightDockActive && !rightNotepadActive && (
            <>
              <div className="footer-action-slot right" ref={setRightFooterSlot} />
              <div className="footer-token-slot" ref={setRightFooterTokenSlot} />
            </>
          )}
          <button
            className={`footer-chat-toggle ${rightOpen ? 'is-open' : ''}`}
            title={rightOpen ? 'Hide right chat' : 'Show right chat'}
            aria-label={rightOpen ? 'Hide right chat' : 'Show right chat'}
            aria-expanded={rightOpen}
            onClick={toggleRight}
          >
            <DrawerChevron side="right" open={rightOpen} />
          </button>
        </div>
      </footer>
      <AgentBuilderModal
        isOpen={isAgentBuilderOpen}
        agent={editingAgent}
        onClose={() => {
          setIsAgentBuilderOpen(false)
          setEditingAgent(null)
        }}
      />
      <MemoryController />
    </div>
  )
}
