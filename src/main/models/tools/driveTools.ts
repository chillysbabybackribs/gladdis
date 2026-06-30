import type { TabManager } from '../../TabManager'
import type { ToolOutcome } from '../browserTools'
import { cap, safeJson } from './toolUtils'
import { executeGrepInTab } from './perceiveTools'
import { clampInt } from './toolUtils'

export interface DriveToolsDeps {
  tabs: TabManager
}

export interface DriveToolsContext {
  tabId: string
}

/** CDP key descriptors for the non-printing keys the agent can press. */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
}

export async function runExecuteInBrowser(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const res = await deps.tabs.executeJavaScript(ctx.tabId, String(args.code ?? ''))
  return res.success
    ? {
        ok: true,
        text: cap(safeJson(res.result)),
        structuredContent: {
          code: String(args.code ?? ''),
          result: normalizeStructuredValue(res.result)
        }
      }
    : { ok: false, text: `Error: ${res.error}` }
}

export async function runNavigate(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const rawUrl = String(args.url ?? '').trim()
  if (!rawUrl) {
    return { ok: false, text: 'navigate: "url" is required.' }
  }

  const shouldWait = args.wait === undefined ? true : !!args.wait
  const timeoutMs = clampInt(args.timeout_ms, 500, 8_000, 2_000)

  deps.tabs.navigate(ctx.tabId, rawUrl)
  if (shouldWait) {
    await deps.tabs.waitForNavigationSettled(ctx.tabId, timeoutMs)
  }

  // Free calibration signal for the model's next read: how text-heavy this page
  // is, measured at settle. Lets it size grep_page queries up-front (large →
  // distinctive phrases, expect many hits; small → broaden safely) instead of
  // guessing blind. Best-effort only — a read failure must not fail navigation.
  let pageTextChars: number | null = null
  if (shouldWait) {
    try {
      const res = await deps.tabs.executeJavaScript(
        ctx.tabId,
        'return (document.body && document.body.innerText) ? document.body.innerText.length : 0'
      )
      if (res.success && typeof res.result === 'number') pageTextChars = res.result
    } catch {
      pageTextChars = null
    }
  }

  const sizeHint =
    pageTextChars === null
      ? ''
      : ` Page text: ~${pageTextChars.toLocaleString()} chars` +
        (pageTextChars > 50_000
          ? ' (heavy — use distinctive multi-word grep_page queries; expect many hits).'
          : pageTextChars < 4_000
            ? ' (light — broad grep_page terms are safe).'
            : '.')

  return {
    ok: true,
    text:
      (shouldWait
        ? `Navigated to ${rawUrl} (waited up to ${timeoutMs}ms).`
        : `Navigating to ${rawUrl}.`) + sizeHint,
    structuredContent: {
      url: rawUrl,
      wait: shouldWait,
      timeoutMs,
      pageTextChars
    }
  }
}

export async function runClickXY(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const x = Number(args.x)
  const y = Number(args.y)
  await dispatchClick(deps.tabs, ctx.tabId, x, y)
  return { ok: true, text: `Clicked at (${x}, ${y}).`, structuredContent: { x, y } }
}

export async function runTypeText(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const text = String(args.text ?? '')
  await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
  return { ok: true, text: `Typed ${text.length} chars.`, structuredContent: { text, charsTyped: text.length } }
}

export async function runPressKey(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const key = String(args.key ?? '')
  const def = KEY_MAP[key.toLowerCase()]
  if (!def) {
    return { ok: false, text: `press_key: unknown key "${key}". Supported: ${Object.keys(KEY_MAP).join(', ')}.` }
  }
  const common = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    ...(def.text ? { text: def.text } : {})
  }
  await deps.tabs.cdpSend(ctx.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
  await deps.tabs.cdpSend(ctx.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  return { ok: true, text: `Pressed ${key}.`, structuredContent: { key } }
}

export async function runCdpCommand(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const method = String(args.method ?? '')
  const out = await deps.tabs.cdpSend(ctx.tabId, method, args.params ?? {})
  return {
    ok: true,
    text: cap(safeJson(out)),
    structuredContent: {
      method,
      ...(args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { params: args.params } : {}),
      result: normalizeStructuredValue(out)
    }
  }
}

export async function runGrepClick(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const query = args.query
  if (typeof query !== 'string' || !query.trim()) {
    return { ok: false, text: 'grep_click: query must be a non-empty string.' }
  }

  const type = args.type || 'auto'
  const caseSensitive = !!args.caseSensitive

  try {
    const runResult = await executeGrepInTab(deps.tabs, ctx.tabId, query, type, caseSensitive, 2)
    if (!runResult.success) {
      return { ok: false, text: `grep_click: search execution failed: ${runResult.error}` }
    }

    const matches = (runResult.result as any[]) || []
    const validMatches = matches.filter(m => m.type !== 'error' && m.coordinates && m.visible)

    if (validMatches.length === 0) {
      return { ok: false, text: `grep_click: no visible, clickable elements matched the query "${query}".` }
    }

    const bestMatch = validMatches[0]
    const { x, y } = bestMatch.coordinates
    await dispatchClick(deps.tabs, ctx.tabId, x, y)

    let matchDesc = `Matched element: <${bestMatch.tagName || 'unknown'}>`
    if (bestMatch.selector) matchDesc += ` (${bestMatch.selector})`
    if (bestMatch.matchedLine) matchDesc += ` with text "${bestMatch.matchedLine}"`

    return {
      ok: true,
      text: `grep_click successful. Found and clicked element. ${matchDesc} at coordinate (${x}, ${y}).`,
      structuredContent: {
        query,
        type,
        caseSensitive,
        coordinates: { x, y },
        match: {
          ...(bestMatch.tagName ? { tagName: bestMatch.tagName } : {}),
          ...(bestMatch.selector ? { selector: bestMatch.selector } : {}),
          ...(bestMatch.matchedLine ? { matchedLine: bestMatch.matchedLine } : {})
        }
      }
    }
  } catch (err: any) {
    return { ok: false, text: `grep_click error: ${err.message}` }
  }
}

export async function runGrepType(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const query = args.query
  if (typeof query !== 'string' || !query.trim()) {
    return { ok: false, text: 'grep_type: query must be a non-empty string.' }
  }
  const text = String(args.text ?? '')

  const type = args.type || 'auto'
  const caseSensitive = !!args.caseSensitive

  try {
    const runResult = await executeGrepInTab(deps.tabs, ctx.tabId, query, type, caseSensitive, 2)
    if (!runResult.success) {
      return { ok: false, text: `grep_type: search execution failed: ${runResult.error}` }
    }

    const matches = (runResult.result as any[]) || []
    const validMatches = matches.filter(m => m.type !== 'error' && m.coordinates && m.visible)

    if (validMatches.length === 0) {
      return { ok: false, text: `grep_type: no visible, targetable input elements matched the query "${query}".` }
    }

    const bestMatch = validMatches[0]
    const { x, y } = bestMatch.coordinates
    
    // First click to focus the element
    await dispatchClick(deps.tabs, ctx.tabId, x, y)
    
    // Then type the text
    await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })

    let matchDesc = `Matched element: <${bestMatch.tagName || 'unknown'}>`
    if (bestMatch.selector) matchDesc += ` (${bestMatch.selector})`
    if (bestMatch.matchedLine) matchDesc += ` with text "${bestMatch.matchedLine}"`

    return {
      ok: true,
      text: `grep_type successful. Focused element and typed text. ${matchDesc} at coordinate (${x}, ${y}).`,
      structuredContent: {
        query,
        text,
        type,
        caseSensitive,
        coordinates: { x, y },
        match: {
          ...(bestMatch.tagName ? { tagName: bestMatch.tagName } : {}),
          ...(bestMatch.selector ? { selector: bestMatch.selector } : {}),
          ...(bestMatch.matchedLine ? { matchedLine: bestMatch.matchedLine } : {})
        }
      }
    }
  } catch (err: any) {
    return { ok: false, text: `grep_type error: ${err.message}` }
  }
}

/** Trusted mouse click via CDP (move + press + release). */
async function dispatchClick(tabs: TabManager, tabId: string, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

function normalizeStructuredValue(value: unknown): Record<string, unknown> | string | number | boolean | null | unknown[] {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => normalizeStructuredValue(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeStructuredValue(item)])
    )
  }
  return String(value)
}
