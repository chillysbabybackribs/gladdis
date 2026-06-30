const owner = 'chillysbabybackribs'
const repo = 'gladdis'
const releaseStatus = document.getElementById('release-status')
const appImageButton = document.getElementById('download-appimage')
const debButton = document.getElementById('download-deb')
const checksumButton = document.getElementById('download-checksums')
const checksumStatus = document.getElementById('checksum-status')
const verifyCommand = document.getElementById('verify-command')
const appImageCommand = document.getElementById('appimage-command')
const debCommand = document.getElementById('deb-command')

function setButtonState(button, asset) {
  if (!button || !asset) {
    return
  }

  button.href = asset.browser_download_url
  button.removeAttribute('aria-disabled')
  button.classList.remove('button-disabled')
}

function setCommandText(element, text) {
  if (!element) {
    return
  }

  element.textContent = text
}

function formatPublishedAt(value) {
  if (!value) {
    return 'date unavailable'
  }

  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

function setReleaseCommands(appImage, deb, checksums) {
  const checksumName = checksums?.name || 'SHA256SUMS.txt'
  const appImageName = appImage?.name || 'Gladys-*.AppImage'
  const debName = deb?.name || 'Gladys-*.deb'

  setCommandText(
    verifyCommand,
    `sha256sum -c ${checksumName} --ignore-missing`
  )
  setCommandText(
    appImageCommand,
    `chmod +x ${appImageName} && ./${appImageName}`
  )
  setCommandText(debCommand, `sudo apt install ./${debName}`)
}

async function loadLatestRelease() {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json'
        }
      }
    )

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`)
    }

    const release = await response.json()
    const appImage = release.assets.find((asset) => asset.name.endsWith('.AppImage'))
    const deb = release.assets.find((asset) => asset.name.endsWith('.deb'))
    const checksums = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt')

    setButtonState(appImageButton, appImage)
    setButtonState(debButton, deb)
    setButtonState(checksumButton, checksums)
    setReleaseCommands(appImage, deb, checksums)

    if (releaseStatus) {
      releaseStatus.textContent = `Latest Linux release: ${release.tag_name} published ${formatPublishedAt(release.published_at)}.`
    }

    if (checksumStatus) {
      checksumStatus.textContent = checksums
        ? 'Release checksums are published alongside the Linux installers.'
        : 'This release does not include a checksum bundle yet.'
    }
  } catch (error) {
    if (releaseStatus) {
      releaseStatus.textContent =
        'No published Linux release was found yet. Tagging a release will light up these download buttons.'
    }
    if (checksumStatus) {
      checksumStatus.textContent =
        'Checksums will appear here once a Linux release has been published.'
    }
    console.error(error)
  }
}

void loadLatestRelease()

function initMobilePreviewVideo() {
  const shell = document.querySelector('.hero-mobile-video-shell')
  const video = document.querySelector('[data-mobile-video]')
  const cover = document.querySelector('[data-mobile-video-cover]')

  if (!shell || !video || !cover) {
    return
  }

  cover.addEventListener('click', async () => {
    try {
      await video.play()
      shell.classList.add('is-playing')
    } catch (error) {
      console.error(error)
    }
  })
}

initMobilePreviewVideo()

// ── Interactive Gladys UI preview ──────────────────────────────────────────
// A click-around mock of the real three-pane app: the DuckDuckGo search toggle
// flips, and either composer can be typed in. It never runs anything — sending
// surfaces a "download to run" affordance instead.
function initInteractivePreview() {
  const demo = document.querySelector('.demo-frame')
  if (!demo) return

  // DuckDuckGo Search / Duck.ai segmented toggle.
  const segButtons = Array.from(demo.querySelectorAll('[data-ddg]'))
  const ddgInput = demo.querySelector('.gd-ddg-input')
  segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      segButtons.forEach((other) => other.classList.toggle('active', other === btn))
      if (ddgInput) {
        ddgInput.placeholder =
          btn.dataset.ddg === 'ai' ? 'Ask Duck.ai anything' : 'Search privately'
      }
    })
  })

  // Each composer's send/Enter is a demo affordance: flash the hint, never submit.
  function wireComposer(box) {
    const sendBtn = box.querySelector('[data-demo-send]')
    const hint = box.querySelector('[data-demo-hint]')
    const input = box.querySelector('.gd-composer-input')
    let hintTimer = null

    function flashHint() {
      if (!hint) return
      hint.hidden = false
      if (hintTimer) clearTimeout(hintTimer)
      hintTimer = setTimeout(() => {
        hint.hidden = true
      }, 2600)
    }

    if (sendBtn) sendBtn.addEventListener('click', flashHint)
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          flashHint()
        }
      })
    }

  }

  demo.querySelectorAll('.gd-composer').forEach(wireComposer)

  // Bottom rail: toggle the side panels and the embedded terminal.
  const leftAgent = demo.querySelector('.gd-agent:not(.gd-agent-right)')
  const rightAgent = demo.querySelector('.gd-agent-right')

  demo.querySelectorAll('[data-rail]').forEach((btn) => {
    const side = btn.dataset.rail
    const panel = side === 'right' ? rightAgent : leftAgent
    const openGlyph = side === 'right' ? '›' : '‹'
    const closedGlyph = side === 'right' ? '‹' : '›'
    btn.addEventListener('click', () => {
      if (!panel) return
      const collapsed = panel.toggleAttribute('hidden')
      btn.textContent = collapsed ? closedGlyph : openGlyph
    })
  })

  // Terminal: slide it up over the browser, pushing the page up.
  const terminal = demo.querySelector('[data-terminal]')
  const termToggle = demo.querySelector('[data-terminal-toggle]')
  const termClose = demo.querySelector('[data-terminal-close]')

  function setTerminal(open) {
    if (!terminal) return
    terminal.hidden = !open
    if (termToggle) termToggle.classList.toggle('active', open)
  }

  if (termToggle) {
    termToggle.addEventListener('click', () => setTerminal(terminal.hidden))
  }
  if (termClose) {
    termClose.addEventListener('click', () => setTerminal(false))
  }
}

initInteractivePreview()

// ── Panel resize handles ────────────────────────────────────────────────────
// Drag the left or right divider to resize the chat panels, exactly like the
// real Electron app. The browser column fills the remaining space via flex:1.
function initPanelResize() {
  const demo = document.querySelector('.demo-frame')
  if (!demo) return

  const body = demo.querySelector('.gd-body')
  const leftAgent = demo.querySelector('.gd-agent:not(.gd-agent-right)')
  const rightAgent = demo.querySelector('.gd-agent-right')

  function wire(resizer, panel, growsRight) {
    if (!resizer || !panel) return

    let startX = 0
    let startWidth = 0

    function onMove(e) {
      const dx = e.clientX - startX
      const bodyW = body.getBoundingClientRect().width
      const raw = growsRight ? startWidth + dx : startWidth - dx
      const clamped = Math.max(140, Math.min(raw, bodyW * 0.46))
      panel.style.flex = `0 0 ${clamped}px`
    }

    function onUp() {
      resizer.classList.remove('dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault()
      startX = e.clientX
      startWidth = panel.getBoundingClientRect().width
      resizer.classList.add('dragging')
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  }

  wire(demo.querySelector('[data-resizer="left"]'), leftAgent, true)
  wire(demo.querySelector('[data-resizer="right"]'), rightAgent, false)
}

initPanelResize()
