import type { TabManager } from '../../TabManager'
import type { ToolOutcome } from '../browserTools'
import { cap, safeJson } from './toolUtils'
import { executeGrepInTab, summarizeNetworkCapture } from './perceiveTools'
import { clampInt } from './toolUtils'
import type { AxSnapshotNode } from '../../extract/axTree'
import {
  axNodeCenter,
  axRefTargetError,
  describeAxRefMatch,
  isAxRefQuery,
  refreshAxNodeBounds
} from '../../extract/axRef'

export interface DriveToolsDeps {
  tabs: TabManager
  resolveAxRef?: (tabId: string, query: string) => AxSnapshotNode | null
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
  const { value: res, network } = await deps.tabs.runWithPendingNetworkCapture(
    ctx.tabId,
    () => deps.tabs.executeJavaScript(ctx.tabId, String(args.code ?? ''))
  )
  if (!res.success) return { ok: false, text: `Error: ${res.error}` }
  return withOptionalNetworkCapture(
    {
      ok: true,
      text: cap(safeJson(res.result)),
      structuredContent: {
        code: String(args.code ?? ''),
        result: normalizeStructuredValue(res.result)
      }
    },
    network
  )
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

  // Strict parse BEFORE handing off to TabManager. Without this, a model that
  // mistakenly called navigate({ url: "cursor docs" }) used to silently load
  // the DDG SERP for "cursor docs" into the visible tab (via the URL-bar
  // smart-input fallback). Surface the mistake as an actionable tool error
  // instead so the model retries with search().
  let parsedUrl: string
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('non-http(s) scheme')
    }
    parsedUrl = parsed.toString()
  } catch {
    return {
      ok: false,
      text: `navigate: ${JSON.stringify(rawUrl)} is not an http(s) URL. Use search() if you meant to look it up.`
    }
  }

  const shouldWait = args.wait === undefined ? true : !!args.wait
  const timeoutMs = clampInt(args.timeout_ms, 500, 8_000, 2_000)
  const armed = deps.tabs.takeArmedNetworkCapture(ctx.tabId)
  let network = null
  if (armed) {
    network = await deps.tabs.navigateWithNetworkCapture(ctx.tabId, parsedUrl, {
      ...armed,
      waitForNavigation: shouldWait,
      timeoutMs,
      quietWindowMs: shouldWait ? undefined : 250
    })
  } else {
    await deps.tabs.navigate(ctx.tabId, parsedUrl, { wait: shouldWait, timeoutMs })
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

  return withOptionalNetworkCapture(
    {
      ok: true,
      text:
        (shouldWait
          ? `Navigated to ${parsedUrl} (waited up to ${timeoutMs}ms).`
          : `Navigating to ${parsedUrl}.`) + sizeHint,
      structuredContent: {
        url: parsedUrl,
        wait: shouldWait,
        timeoutMs,
        pageTextChars
      }
    },
    network
  )
}

export async function runClickXY(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const refArg = typeof args.ref === 'string' ? args.ref.trim() : ''
  if (refArg) {
    const resolved = await resolveAxRefTarget(deps, ctx.tabId, refArg)
    if (!resolved.ok) {
      return { ok: false, text: `click_xy: ${resolved.text}` }
    }
    const { node, x, y } = resolved
    const { network } = await deps.tabs.runWithPendingNetworkCapture(
      ctx.tabId,
      () => dispatchClick(deps.tabs, ctx.tabId, x, y)
    )
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `click_xy successful. ${describeAxRefMatch(node)} at coordinate (${x}, ${y}).`,
        structuredContent: {
          x,
          y,
          ref: node.ref,
          role: node.role,
          name: node.name,
          ...(node.frameLabel ? { frameLabel: node.frameLabel } : {})
        }
      },
      network
    )
  }

  const x = Number(args.x)
  const y = Number(args.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      ok: false,
      text: 'click_xy: provide numeric x and y, or ref from read_a11y (e.g. @a1).'
    }
  }
  const { network } = await deps.tabs.runWithPendingNetworkCapture(
    ctx.tabId,
    () => dispatchClick(deps.tabs, ctx.tabId, x, y)
  )
  return withOptionalNetworkCapture(
    { ok: true, text: `Clicked at (${x}, ${y}).`, structuredContent: { x, y } },
    network
  )
}

export async function runTypeText(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const text = String(args.text ?? '')
  const { network } = await deps.tabs.runWithPendingNetworkCapture(
    ctx.tabId,
    () => deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
  )
  return withOptionalNetworkCapture(
    { ok: true, text: `Typed ${text.length} chars.`, structuredContent: { text, charsTyped: text.length } },
    network
  )
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
  const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
    await deps.tabs.cdpSend(ctx.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
    await deps.tabs.cdpSend(ctx.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  })
  return withOptionalNetworkCapture(
    { ok: true, text: `Pressed ${key}.`, structuredContent: { key } },
    network
  )
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

  const explicitType = args.type || 'text'
  const type = isAxRefQuery(query, explicitType) ? 'ref' : explicitType
  if (type !== 'text' && type !== 'regex' && type !== 'selector' && type !== 'ref') {
    return { ok: false, text: 'grep_click: type must be "text", "regex", "selector", or "ref".' }
  }
  const caseSensitive = !!args.caseSensitive

  try {
    if (type === 'ref') {
      const resolved = await resolveAxRefTarget(deps, ctx.tabId, query)
      if (!resolved.ok) {
        return { ok: false, text: `grep_click: ${resolved.text}` }
      }
      const { node, x, y } = resolved
      const { network } = await deps.tabs.runWithPendingNetworkCapture(
        ctx.tabId,
        () => dispatchClick(deps.tabs, ctx.tabId, x, y)
      )
      return withOptionalNetworkCapture({
        ok: true,
        text: `grep_click successful. ${describeAxRefMatch(node)} at coordinate (${x}, ${y}).`,
        structuredContent: {
          query,
          type,
          caseSensitive,
          coordinates: { x, y },
          match: {
            ref: node.ref,
            role: node.role,
            name: node.name,
            ...(node.frameLabel ? { frameLabel: node.frameLabel } : {})
          }
        }
      }, network)
    }

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
    const { network } = await deps.tabs.runWithPendingNetworkCapture(
      ctx.tabId,
      () => dispatchClick(deps.tabs, ctx.tabId, x, y)
    )

    let matchDesc = `Matched element: <${bestMatch.tagName || 'unknown'}>`
    if (bestMatch.selector) matchDesc += ` (${bestMatch.selector})`
    if (bestMatch.matchedLine) matchDesc += ` with text "${bestMatch.matchedLine}"`

    return withOptionalNetworkCapture({
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
    }, network)
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

  const explicitType = args.type || 'text'
  const type = isAxRefQuery(query, explicitType) ? 'ref' : explicitType
  if (type !== 'text' && type !== 'regex' && type !== 'selector' && type !== 'ref') {
    return { ok: false, text: 'grep_type: type must be "text", "regex", "selector", or "ref".' }
  }
  const caseSensitive = !!args.caseSensitive

  try {
    if (type === 'ref') {
      const resolved = await resolveAxRefTarget(deps, ctx.tabId, query)
      if (!resolved.ok) {
        return { ok: false, text: `grep_type: ${resolved.text}` }
      }
      const { node, x, y } = resolved
      const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
        await dispatchClick(deps.tabs, ctx.tabId, x, y)
        await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
      })
      return withOptionalNetworkCapture({
        ok: true,
        text: `grep_type successful. ${describeAxRefMatch(node)} at coordinate (${x}, ${y}).`,
        structuredContent: {
          query,
          text,
          type,
          caseSensitive,
          coordinates: { x, y },
          match: {
            ref: node.ref,
            role: node.role,
            name: node.name,
            ...(node.frameLabel ? { frameLabel: node.frameLabel } : {})
          }
        }
      }, network)
    }

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
    const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
      await dispatchClick(deps.tabs, ctx.tabId, x, y)
      await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
    })

    let matchDesc = `Matched element: <${bestMatch.tagName || 'unknown'}>`
    if (bestMatch.selector) matchDesc += ` (${bestMatch.selector})`
    if (bestMatch.matchedLine) matchDesc += ` with text "${bestMatch.matchedLine}"`

    return withOptionalNetworkCapture({
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
    }, network)
  } catch (err: any) {
    return { ok: false, text: `grep_type error: ${err.message}` }
  }
}

function withOptionalNetworkCapture(
  outcome: ToolOutcome,
  network: Awaited<ReturnType<TabManager['runWithPendingNetworkCapture']>>['network']
): ToolOutcome {
  if (!network) return outcome
  const summary = summarizeNetworkCapture(network, { label: 'PRE-ACTION NETWORK' })
  return {
    ...outcome,
    text: `${outcome.text}\n${summary.text}`,
    structuredContent: {
      ...(outcome.structuredContent ?? {}),
      preActionNetwork: summary.structuredContent
    }
  }
}

/** Trusted mouse click via CDP (move + press + release). */
async function dispatchClick(tabs: TabManager, tabId: string, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

async function resolveAxRefTarget(
  deps: DriveToolsDeps,
  tabId: string,
  query: string
): Promise<{ ok: true; node: AxSnapshotNode; x: number; y: number } | { ok: false; text: string }> {
  if (!deps.resolveAxRef) {
    return { ok: false, text: axRefTargetError(query, 'read_a11y has not been called on this tab') }
  }
  const node = deps.resolveAxRef(tabId, query)
  if (!node) {
    return { ok: false, text: axRefTargetError(query, 'ref is missing or stale after navigation') }
  }
  if (node.states.includes('disabled')) {
    return { ok: false, text: `ref ${node.ref} is disabled.` }
  }

  let center = axNodeCenter(node)
  if (!center && typeof node.backendDOMNodeId === 'number') {
    const layout = (await deps.tabs.cdpSend(tabId, 'Page.getLayoutMetrics', {})) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
    }
    const viewport = layout.cssVisualViewport ?? layout.cssLayoutViewport ?? {}
    await refreshAxNodeBounds(
      (method, params) => deps.tabs.cdpSend(tabId, method, params),
      node,
      {
        width: Math.round(viewport.clientWidth ?? 0),
        height: Math.round(viewport.clientHeight ?? 0)
      }
    )
    center = axNodeCenter(node)
  }

  if (!center) {
    return { ok: false, text: axRefTargetError(query, `ref ${node.ref} has no clickable coordinates`) }
  }
  return { ok: true, node, x: center.x, y: center.y }
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
