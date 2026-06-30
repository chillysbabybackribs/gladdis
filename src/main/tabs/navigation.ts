import { type WebContents } from 'electron'

import { DEFAULT_URL, SEARCH_URL, ABOUT_BLANK, HTTP_URL } from './constants'

/**
 * URL-bar smart input: "github" → https://github.com, "rust async" → DDG SERP.
 * This is the right behavior for a human typing into the address bar.
 *
 * IMPORTANT: do NOT call this from programmatic (agent / tool) navigation paths.
 * The SERP-fallback arm would silently load DuckDuckGo's results page into the
 * VISIBLE tab whenever a tool passed a non-URL string (e.g. the model called
 * `navigate({ url: "cursor docs" })`), which is exactly the "DDG initial search
 * page with the query typed and searched" leak users see. Tool callers must use
 * {@link ensureNavigableUrl} and surface a clean error instead.
 */
export function normalizeAddress(input: string): string {
  const value = input.trim()
  if (!value) return DEFAULT_URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (isLikelyHostname(value)) return `https://${value}`
  return `${SEARCH_URL}${encodeURIComponent(value)}`
}

/**
 * Strict URL-or-throw used by every programmatic navigation. Accepts
 * about:blank and any http/https URL; rejects everything else so a bad input
 * cannot silently land in the DDG SERP fallback of {@link normalizeAddress}.
 */
export function ensureNavigableUrl(input: string): string {
  const value = input.trim()
  if (value === ABOUT_BLANK) return value
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString()
    }
  } catch {
    /* fall through to the explicit error below */
  }
  throw new Error(
    `navigate: ${JSON.stringify(input)} is not a navigable http(s) URL. ` +
      `Use search() if you meant to look it up.`
  )
}

export function isLikelyHostname(value: string): boolean {
  if (/\s/.test(value)) return false
  if (value === 'localhost') return true
  if (/^localhost:\d+$/i.test(value)) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/.test(value)) return true
  return /^[^\s/]+\.[^\s/]+(?:\/.*)?$/.test(value)
}

export function isNavigableUrl(url: string): boolean {
  return url === ABOUT_BLANK || HTTP_URL.test(url)
}

export function waitForNavigationSettled(
  wc: WebContents,
  timeoutMs = 10_000
): Promise<void> {
  return new Promise((resolve) => {
    let sawLoad = wc.isLoading()
    let loadSettled = false
    let domSettled = false
    let settleTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(graceTimer)
      clearTimeout(settleTimer)
      wc.off('did-start-loading', onStart)
      wc.off('did-stop-loading', onLoadSettled)
      wc.off('did-finish-load', onLoadSettled)
      wc.off('did-fail-load', onLoadSettled)
      wc.off('dom-ready', onDomReady)
    }

    const finish = () => {
      cleanup()
      resolve()
    }

    const maybeFinish = () => {
      if (loadSettled && domSettled) finish()
    }

    const onStart = () => {
      sawLoad = true
    }

    const onLoadSettled = () => {
      loadSettled = true
      maybeFinish()
    }

    const onDomReady = () => {
      domSettled = true
      maybeFinish()
    }

    const timeoutTimer = setTimeout(finish, timeoutMs)
    const graceTimer = setTimeout(() => {
      if (!sawLoad && !wc.isLoading()) {
        loadSettled = true
        domSettled = true
        finish()
      }
    }, 250)

    wc.once('did-start-loading', onStart)
    wc.once('did-stop-loading', onLoadSettled)
    wc.once('did-finish-load', onLoadSettled)
    wc.once('did-fail-load', onLoadSettled)
    wc.once('dom-ready', onDomReady)
  })
}

export interface NavigateToOptions {
  wait?: boolean
  timeoutMs?: number
  /**
   * Opt-in URL-bar behavior: rewrite non-URL input as a DuckDuckGo SERP and
   * bare hostnames as https URLs (see {@link normalizeAddress}). Default false
   * so every programmatic / tool-driven navigation gets the strict
   * {@link ensureNavigableUrl} validation instead.
   */
  smartAddressBarInput?: boolean
}

export async function navigateTo(
  wc: WebContents,
  url: string,
  opts?: NavigateToOptions
): Promise<void> {
  const normalized = opts?.smartAddressBarInput
    ? normalizeAddress(url)
    : ensureNavigableUrl(url)
  const settlePromise =
    opts?.wait === false ? Promise.resolve() : waitForNavigationSettled(wc, opts?.timeoutMs)
  wc.loadURL(normalized)
  await settlePromise
}

export function goBack(wc: WebContents): void {
  wc.navigationHistory.goBack()
}

export function goForward(wc: WebContents): void {
  wc.navigationHistory.goForward()
}

export function reloadPage(wc: WebContents): void {
  wc.reload()
}
