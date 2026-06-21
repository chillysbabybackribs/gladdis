/**
 * Is Brave's empty render caused by show:false specifically, or does Brave
 * just block this embedded Chromium regardless? Test hidden vs visible, twice.
 *
 * Run: npx electron scripts/probe-brave.cjs
 */
const { app, BrowserWindow, session } = require('electron')
const PARTITION = 'persist:gladdis-probe2'
const QUERY = process.argv[2] || 'typescript generics tutorial'
function log(...a) { console.log('[brave]', ...a) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function probe(show) {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(QUERY)}&source=web`
  const win = new BrowserWindow({
    show, width: 1280, height: 900, skipTaskbar: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    const wc = win.webContents
    await wc.loadURL(url)
    await sleep(3500) // generous: let any JS render
    const snap = await wc.executeJavaScript(`({
      readyState: document.readyState,
      bodyLen: document.body ? document.body.innerText.length : -1,
      title: document.title,
      href: location.href,
      snippetWeb: document.querySelectorAll('.snippet[data-type="web"], div[data-type="web"]').length,
      anchorsHttp: document.querySelectorAll('a[href^="http"]').length,
      bodyHead: document.body ? document.body.innerText.slice(0, 200).replace(/\\s+/g,' ') : ''
    })`, true).catch((e) => ({ err: e.message }))
    log(`show=${show}:`, JSON.stringify(snap))
    return snap
  } finally {
    if (!win.isDestroyed()) { win.webContents.stop(); win.destroy() }
  }
}

app.whenReady().then(async () => {
  log(`chrome ${process.versions.chrome}`)
  session.fromPartition(PARTITION)
  await probe(false) // hidden (production behavior)
  await sleep(500)
  await probe(true)  // visible
  await sleep(500)
  await probe(false) // hidden again — consistency
  app.quit()
}).catch((e) => { log('fail', e); app.quit() })
app.on('window-all-closed', () => {})
