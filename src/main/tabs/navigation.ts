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
    const done = () => {
      clearTimeout(timer)
      clearTimeout(graceTimer)
      wc.off('did-start-loading', onStart)
      wc.off('did-stop-loading', done)
      wc.off('did-finish-load', done)
      wc.off('did-fail-load', done)
      resolve()
    }
    const onStart = () => {
      sawLoad = true
    }
    const maybeDone = () => {
      if (!sawLoad && !wc.isLoading()) done()
    }
    const timer = setTimeout(done, timeoutMs)
    const graceTimer = setTimeout(maybeDone, 250)
    wc.once('did-start-loading', onStart)
    wc.once('did-stop-loading', done)
    wc.once('did-finish-load', done)
    wc.once('did-fail-load', done)
  })
}

export function navigateTo(wc: WebContents, url: string): void {
  const normalized = normalizeAddress(url)
  wc.loadURL(normalized)
  void waitForNavigationSettled(wc)
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
