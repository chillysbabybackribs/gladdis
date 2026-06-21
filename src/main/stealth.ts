import { Session } from 'electron'

/**
 * Anti-detection / stealth layer for the embedded Chromium browser.
 *
 * Two parts, applied at two seams:
 *  1. configureStealthSession(session) — once per partition: present as current
 *     real Chrome (User-Agent + Accept-Language) and attach the matching Sec-CH-UA
 *     client-hint headers that real Chrome sends. A UA that claims "Chrome" with no
 *     client hints is itself the tell sites flag ("this browser is not secure").
 *  2. STEALTH_INIT_SCRIPT — the page-world patch script. It is handed to each
 *     tab's CDPSession (via its initScripts arg) which registers it through
 *     Page.addScriptToEvaluateOnNewDocument *after Page.enable* in the attach
 *     sequence, so it runs before any page script on every document and isn't
 *     racing domain enablement.
 *
 * Ported from ~/Desktop/browser2.0/src/main/browser.ts (verified working there).
 */

/**
 * The Chrome version we ADVERTISE (UA + Sec-CH-UA), pinned to a current real
 * Chrome stable — NOT process.versions.chrome (Electron's bundled Chromium runs
 * behind real Chrome and the gap is what trips "this browser may not be secure").
 * The render engine is still the bundled Chromium; we only present as current.
 * Bump this toward real Chrome stable if that class of block returns.
 */
const ADVERTISED_CHROME_VERSION = '149.0.7827.53'
const ACCEPT_LANGUAGE = 'en-US,en'

function browserUserAgent(): string {
  const major = ADVERTISED_CHROME_VERSION.split('.')[0] || '149'
  const v = `${major}.0.0.0`
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`
}

/**
 * The Client Hint headers real Chrome sends on every request. MUST stay
 * consistent with the UA's Chrome major + platform, or the mismatch is the tell.
 */
function browserClientHints(): Record<string, string> {
  const major = ADVERTISED_CHROME_VERSION.split('.')[0] || '139'
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`
  const platform =
    process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"'
  return {
    'Sec-CH-UA': brands,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': platform
  }
}

/**
 * Present as current real Chrome at the session layer and add the matching
 * Sec-CH-UA client hints to outgoing requests (only when absent, so we never
 * clobber hints Chromium already set). Idempotent per session via a tag.
 */
export function configureStealthSession(session: Session): void {
  const tagged = session as Session & { __gladdisStealth?: boolean }
  if (tagged.__gladdisStealth) return
  tagged.__gladdisStealth = true

  session.setUserAgent(browserUserAgent(), ACCEPT_LANGUAGE)

  const clientHints = browserClientHints()
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const [name, value] of Object.entries(clientHints)) {
      const present = Object.keys(headers).some((h) => h.toLowerCase() === name.toLowerCase())
      if (!present) headers[name] = value
    }
    callback({ requestHeaders: headers })
  })
}

/**
 * Core stealth patches, injected before any page script. Mask the highest-signal,
 * lowest-risk automation markers bot walls actually probe. Intentionally
 * conservative — no canvas noise (which can break legitimate rendering). Every
 * override routes through fakeNative() so its .toString() reads "[native code]".
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  try {
    Object.defineProperty(window, '__gladdisStealthRan', { value: true, configurable: true });
    const chromeFullVersion = '${ADVERTISED_CHROME_VERSION}';
    const chromeMajorVersion = '${ADVERTISED_CHROME_VERSION.split('.')[0]}';
    const chromeReducedVersion = chromeMajorVersion + '.0.0.0';
    const chromePlatform = '${
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
    }';
    const nativeToString = Function.prototype.toString;
    const patched = new WeakMap();
    const fakeNative = (fn, name) => {
      try {
        patched.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }');
      } catch (e) {}
      return fn;
    };
    const ts = function toString() {
      if (patched.has(this)) return patched.get(this);
      return nativeToString.call(this);
    };
    Function.prototype.toString = fakeNative(ts, 'toString');

    const defineGetter = (obj, prop, getter) => {
      Object.defineProperty(obj, prop, {
        get: fakeNative(getter, 'get ' + prop),
        configurable: true,
        enumerable: true,
      });
    };

    // 1. navigator.webdriver — the canonical automation tell.
    defineGetter(Navigator.prototype, 'webdriver', () => undefined);

    // 2. window.chrome — give a plausible surface even if a bare one exists.
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: {}, configurable: true, writable: true });
    }
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.app) {
      window.chrome.app = { isInstalled: false, InstallState: {}, RunningState: {} };
    }
    if (!window.chrome.csi) window.chrome.csi = fakeNative(function csi() { return {}; }, 'csi');
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = fakeNative(function loadTimes() { return {}; }, 'loadTimes');
    }

    // 3. navigator.languages — present a clean, deduped value.
    defineGetter(Navigator.prototype, 'languages', () => Object.freeze(['en-US', 'en']));

    // 4. navigator.plugins / mimeTypes — build off real prototypes so instanceof passes.
    const pluginData = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
    ];
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const makeArrayLike = (proto, items, byName) => {
        const arr = Object.create(proto);
        items.forEach((it, i) => { arr[i] = it; });
        Object.defineProperty(arr, 'length', { value: items.length });
        arr.item = fakeNative(function item(i) { return items[i] || null; }, 'item');
        arr.namedItem = fakeNative(function namedItem(n) { return byName[n] || null; }, 'namedItem');
        return arr;
      };
      const mimeByName = {};
      const plugByName = {};
      const plugins = pluginData.map((p) => {
        const plugin = Object.create(Plugin.prototype);
        defineGetter(plugin, 'name', () => p.name);
        defineGetter(plugin, 'filename', () => p.filename);
        defineGetter(plugin, 'description', () => p.desc);
        plugByName[p.name] = plugin;
        return plugin;
      });
      const mime = Object.create(MimeType.prototype);
      defineGetter(mime, 'type', () => 'application/pdf');
      defineGetter(mime, 'suffixes', () => 'pdf');
      defineGetter(mime, 'description', () => 'Portable Document Format');
      mimeByName['application/pdf'] = mime;
      const pluginArray = makeArrayLike(PluginArray.prototype, plugins, plugByName);
      const mimeArray = makeArrayLike(MimeTypeArray.prototype, [mime], mimeByName);
      defineGetter(Navigator.prototype, 'plugins', () => pluginArray);
      defineGetter(Navigator.prototype, 'mimeTypes', () => mimeArray);
    }

    // 5. permissions.query('notifications') — align with Notification.permission.
    const origQuery = window.navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = fakeNative(function query(params) {
        return params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : origQuery.call(navigator.permissions, params);
      }, 'query');
    }

    // 6. navigator.vendor — real Chrome reports "Google Inc.".
    if (navigator.vendor !== 'Google Inc.') {
      defineGetter(Navigator.prototype, 'vendor', () => 'Google Inc.');
    }

    // 7. navigator.userAgentData — keep JS-side hints aligned with request headers.
    if (navigator.userAgentData) {
      const brands = Object.freeze([
        { brand: 'Chromium', version: chromeMajorVersion },
        { brand: 'Google Chrome', version: chromeMajorVersion },
        { brand: 'Not?A_Brand', version: '99' },
      ]);
      const fullVersionList = Object.freeze([
        { brand: 'Chromium', version: chromeFullVersion },
        { brand: 'Google Chrome', version: chromeFullVersion },
        { brand: 'Not?A_Brand', version: '99.0.0.0' },
      ]);
      const lowEntropy = Object.freeze({ brands, mobile: false, platform: chromePlatform });
      const highEntropy = {
        architecture: 'x86',
        bitness: '64',
        brands,
        fullVersionList,
        mobile: false,
        model: '',
        platform: chromePlatform,
        platformVersion: '',
        uaFullVersion: chromeFullVersion,
        wow64: false,
      };
      const userAgentData = Object.freeze({
        ...lowEntropy,
        getHighEntropyValues: fakeNative(function getHighEntropyValues(hints) {
          const result = { ...lowEntropy };
          for (const hint of hints || []) {
            if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) result[hint] = highEntropy[hint];
          }
          return Promise.resolve(result);
        }, 'getHighEntropyValues'),
        toJSON: fakeNative(function toJSON() { return lowEntropy; }, 'toJSON'),
      });
      defineGetter(Navigator.prototype, 'userAgentData', () => userAgentData);
    }

    // 8. navigator.userAgent / appVersion — match the reduced Chrome UA.
    const chromeUserAgent =
      navigator.userAgent.replace(/(?:Chrome|Chromium)\\/\\d+\\.\\d+\\.\\d+\\.\\d+/, 'Chrome/' + chromeReducedVersion)
        .replace(/\\sElectron\\/\\d+\\.\\d+\\.\\d+/, '');
    defineGetter(Navigator.prototype, 'userAgent', () => chromeUserAgent);
    defineGetter(Navigator.prototype, 'appVersion', () => chromeUserAgent.replace(/^Mozilla\\//, ''));

    // 9. WebGL UNMASKED_VENDOR/RENDERER — software-GL strings are a strong tell.
    const patchGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const realGetParameter = proto.getParameter;
      proto.getParameter = fakeNative(function getParameter(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return realGetParameter.call(this, p);
      }, 'getParameter');
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);
  } catch (e) {
    // Never let a stealth patch throw into the page.
  }
})();
`
