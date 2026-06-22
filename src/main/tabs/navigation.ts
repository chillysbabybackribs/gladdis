import { type WebContents } from 'electron'

import { DEFAULT_URL, SEARCH_URL, ABOUT_BLANK, HTTP_URL } from './constants'

export function normalizeAddress(input: string): string {
  const value = input.trim()
  if (!value) return DEFAULT_URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (isLikelyHostname(value)) return `https://${value}`
  return `${SEARCH_URL}${encodeURIComponent(value)}`
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

export function navigateTo(wc: WebContents, url: string, opts?: { wait?: boolean }): void {
  const normalized = normalizeAddress(url)
  wc.loadURL(normalized)
  if (opts?.wait !== false) void waitForNavigationSettled(wc)
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
