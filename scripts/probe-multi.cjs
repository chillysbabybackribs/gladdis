const { app, BrowserWindow, session } = require('electron')
const P='persist:gladdis-probe3'
const Qs=['react useEffect cleanup','rust borrow checker explained','python asyncio gather']
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function one(engine,q){
  const url= engine==='ddg'
    ? `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`
    : `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`
  const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{partition:P,sandbox:true,contextIsolation:true}})
  try{ await w.webContents.loadURL(url); await sleep(2500)
    const s=await w.webContents.executeJavaScript(`({bot:/not a bot|Verifying you/.test(document.body?document.body.innerText:''),n:document.querySelectorAll('article[data-testid="result"]').length||document.querySelectorAll('a.result__a').length||document.querySelectorAll('.snippet[data-type="web"]').length})`,true).catch(e=>({err:e.message}))
    console.log(`[multi] ${engine} "${q}" -> ${JSON.stringify(s)}`)
  } finally { if(!w.isDestroyed())w.destroy() }
}
app.whenReady().then(async()=>{session.fromPartition(P); for(const q of Qs){await one('ddg',q);await one('brave',q)} app.quit()}).catch(e=>{console.log(e);app.quit()})
app.on('window-all-closed',()=>{})
