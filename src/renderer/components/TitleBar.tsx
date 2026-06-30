import { useEffect, useState } from 'react'
import { CalendarDropdown } from './CalendarDropdown'
import { AppMenuBar } from './AppMenuBar'

export function TitleBar() {
  const [fullScreen, setFullScreen] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [hasWorkspace, setHasWorkspace] = useState(false)

  useEffect(() => {
    void window.gladdis.win.isFullScreen().then(setFullScreen)
    return window.gladdis.win.onFullScreenChanged((next) => {
      setFullScreen(next)
      setTransitioning(true)
    })
  }, [])

  useEffect(() => {
    if (!transitioning) return
    const timer = window.setTimeout(() => setTransitioning(false), 280)
    return () => window.clearTimeout(timer)
  }, [transitioning])

  useEffect(() => {
    void window.gladdis.workspace.get().then((ws) => setHasWorkspace(!!ws.folder))
    return window.gladdis.workspace.onUpdated((ws) => setHasWorkspace(!!ws.folder))
  }, [])

  return (
    <header
      className={`titlebar${fullScreen ? ' titlebar-fullscreen' : ''}${transitioning ? ' titlebar-transitioning' : ''}`}
      onDoubleClick={() => window.gladdis.win.toggleMaximize()}
    >
      <AppMenuBar hasWorkspace={hasWorkspace} />

      {/* Flex spacer — fills middle, stays draggable */}
      <div className="titlebar-gap" />

      {/* Center: clock — overlaid, drag passes through */}
      <div className="titlebar-center">
        <CalendarDropdown />
      </div>

      {/* Right: window controls — not draggable */}
      <div className="win-controls">
        <button className="win-btn" title="Minimize" onClick={() => window.gladdis.win.minimize()}>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <rect x="0" y="5" width="11" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
        </button>

        <button
          className="win-btn"
          title={fullScreen ? 'Exit full screen' : 'Full screen'}
          onClick={() => window.gladdis.win.toggleMaximize()}
        >
          {fullScreen ? (
            <svg width="11" height="11" viewBox="0 0 11 11">
              <path d="M1 4H4V1M7 1V4H10M10 7H7V10M4 10V7H1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11">
              <path d="M1 4V1H4M7 1H10V4M10 7V10H7M4 10H1V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          )}
        </button>

        <button className="win-btn win-btn-close" title="Close" onClick={() => window.gladdis.win.close()}>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  )
}
