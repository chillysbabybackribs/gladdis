import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/theme.css'
import './styles/app.css'

let bootDismissed = false

function revealShell(): void {
  if (bootDismissed) return
  bootDismissed = true
  const boot = document.getElementById('shell-boot')
  const root = document.getElementById('root')
  root?.classList.add('shell-ready')
  if (boot) {
    boot.classList.add('shell-boot--hide')
    boot.addEventListener('transitionend', () => boot.remove(), { once: true })
  }
  window.gladdis.shell.ready()
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Two rAF ticks: let React commit and the browser paint before we fade the boot
// splash and tell main it's safe to show the native window.
requestAnimationFrame(() => {
  requestAnimationFrame(revealShell)
})
