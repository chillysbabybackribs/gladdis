/**
 * Standalone diagnostic: does a hidden BrowserWindow actually open, load a SERP,
 * and render results the way hiddenSearch.ts assumes?
 *
 * Mirrors hiddenSearch.ts's withHiddenWindow + runDdgSearch / runBraveSearch as
 * closely as possible, but logs every step so we can see WHERE it dies.
 *
 * Run:  npx electron scripts/probe-hidden-search.cjs
 * (headless CI: xvfb-run -a npx electron scripts/probe-hidden-search.cjs)
 */
const { app, BrowserWindow, session } = require('electron')

const PARTITION = 'persist:gladdis-probe' // separate partition so we don't touch real cookies
const QUERY = process.argv[2] || 'electron browserwindow show false load url'

function log(...a) { console.log('[probe]', ...a) }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitForResults(wc, timeoutMs) {
  const check = `!!(
    document.querySelector('article[data-testid="result"]') ||
    document.querySelector('[data-nrn="result"]') ||
    document.querySelector('li[data-layout="organic"]') ||
    document.querySelectorAll('a.result__a').length > 0
  )`
  const deadline = Date.now() + timeoutMs
  let polls = 0
  while (Date.now() < deadline) {
    polls++
    try {
      const found = await wc.executeJavaScript(check, true)
      if (found) { log(`  waitForResults: found after ${polls} polls`); return true }
    } catch (e) {
      log(`  waitForResults poll error: ${e.message}`)
    }
    await sleep(250)
  }
  log(`  waitForResults: TIMED OUT after ${polls} polls`)
  return false
}

async function probeEngine(label, url) {
  log(`\n=== ${label}: ${url} ===`)
  let win
  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      skipTaskbar: true,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    log(`  window created. isDestroyed=${win.isDestroyed()} id=${win.id}`)
    const wc = win.webContents

    // Observe lifecycle events
    wc.on('did-start-loading', () => log('  evt did-start-loading'))
    wc.on('did-stop-loading', () => log('  evt did-stop-loading'))
    wc.on('did-fail-load', (_e, code, desc, u) => log(`  evt did-fail-load code=${code} desc=${desc} url=${u}`))
    wc.on('render-process-gone', (_e, d) => log(`  evt render-process-gone reason=${d.reason}`))
    wc.on('did-finish-load', () => log('  evt did-finish-load'))

    const t0 = Date.now()
    await wc.loadURL(url)
    log(`  loadURL resolved in ${Date.now() - t0}ms. landedURL=${wc.getURL()} title="${wc.getTitle()}"`)

    const rendered = await waitForResults(wc, 6000)

    // Snapshot the DOM state regardless
    const snap = await wc.executeJavaScript(`({
      readyState: document.readyState,
      bodyLen: document.body ? document.body.innerText.length : -1,
      href: location.href,
      title: document.title,
      hasArticleResult: !!document.querySelector('article[data-testid="result"]'),
      hasResultA: document.querySelectorAll('a.result__a').length,
      hasSnippetWeb: document.querySelectorAll('.snippet[data-type="web"], div[data-type="web"]').length,
      anchorCount: document.querySelectorAll('a[href^="http"]').length
    })`, true).catch((e) => ({ snapError: e.message }))
    log(`  DOM snapshot:`, JSON.stringify(snap))
    log(`  RESULT: rendered=${rendered}`)
    return { label, rendered, snap, landedURL: wc.getURL() }
  } catch (e) {
    log(`  THREW: ${e.message}`)
    return { label, error: e.message }
  } finally {
    if (win && !win.isDestroyed()) { win.webContents.stop(); win.destroy() }
  }
}

app.whenReady().then(async () => {
  log(`electron ${process.versions.electron}, chrome ${process.versions.chrome}`)
  // touch the partition like the real app does
  session.fromPartition(PARTITION)

  const ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(QUERY)}&ia=web`
  const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(QUERY)}&source=web`

  // Run them the way the real code does: in PARALLEL
  log('\n##### PARALLEL (as production runs it) #####')
  const parallel = await Promise.allSettled([probeEngine('DDG-parallel', ddgUrl), probeEngine('BRAVE-parallel', braveUrl)])
  log('\nparallel summary:', JSON.stringify(parallel.map((p) => p.status === 'fulfilled' ? p.value : { rejected: String(p.reason) }), null, 2))

  app.quit()
}).catch((e) => { log('whenReady failed:', e); app.quit() })

app.on('window-all-closed', () => {}) // keep alive until we quit explicitly
