import { describe, expect, it } from 'vitest'
import { nativeBrowserCommandReason } from './toolPolicy'

describe('Codex tool policy', () => {
  it('blocks native browser visualization tools', () => {
    expect(
      nativeBrowserCommandReason(
        'google-chrome-stable --headless=new --screenshot=/tmp/ui.png http://127.0.0.1:5174/'
      )?.kind
    ).toBe('native-browser-tool')
    expect(nativeBrowserCommandReason('npx playwright screenshot http://127.0.0.1:5174/ /tmp/ui.png')?.kind).toBe(
      'native-browser-tool'
    )
    expect(nativeBrowserCommandReason('node scripts/visual-check-with-puppeteer.js')?.kind).toBe(
      'native-browser-tool'
    )
    expect(nativeBrowserCommandReason('curl http://127.0.0.1:9222/json/version')?.kind).toBe(
      'native-browser-tool'
    )
    expect(nativeBrowserCommandReason('xdg-open http://127.0.0.1:5174/')?.kind).toBe(
      'native-browser-tool'
    )
    expect(nativeBrowserCommandReason('bash -lc "google-chrome-stable --headless http://127.0.0.1:5174"')?.kind).toBe(
      'native-browser-tool'
    )
  })

  it('allows normal repo/dev-server shell work', () => {
    const browserWarning = 'External Chrome' + '/Chromium commands bypass Gladdis'
    expect(nativeBrowserCommandReason('npm run build')).toBeNull()
    expect(nativeBrowserCommandReason('npm run dev -- --port 5174')).toBeNull()
    expect(nativeBrowserCommandReason('curl -I http://127.0.0.1:5174/')).toBeNull()
    expect(nativeBrowserCommandReason('rg -n "playwright" package.json src')).toBeNull()
    expect(nativeBrowserCommandReason(`rg -n "${browserWarning}" src`)).toBeNull()
    expect(nativeBrowserCommandReason('rg -n "chromium" src/main/models/codex/toolPolicy.ts')).toBeNull()
    expect(nativeBrowserCommandReason('bash -lc "rg -n chromium src/main/models/codex/toolPolicy.ts"')).toBeNull()
  })
})
