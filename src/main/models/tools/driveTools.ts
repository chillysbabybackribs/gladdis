import type { TabManager } from '../../TabManager'
import type { ToolOutcome } from '../browserTools'
import { cap, safeJson } from './toolUtils'
import { executeGrepInTab, summarizeNetworkCapture } from './perceiveTools'
import { clampInt, sleep, waitForTextStable } from './toolUtils'
import { formatDataSourceDiscovery } from '../../network/dataSourceDiscovery'
import type { AxSnapshotNode } from '../../extract/axTree'
import type { PageCapture } from '../../../../shared/extraction'
import type { SavedPage } from '../../extract/pageStore'
import { buildPageWireframe, formatPageWireframe } from '../../extract/pageWireframe'
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
  /** Cleaned DOM-order page extractor (navigate's orientation source). */
  extractor?: { run: (tabId: string) => Promise<PageCapture> }
  /** Persist a captured page to disk; returns the saved file paths. */
  savePage?: (cap: PageCapture, conversationId: string | null | undefined) => Promise<SavedPage>
}

export interface DriveToolsContext {
  tabId: string
  conversationId?: string | null
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

  // Orientation brief — land the model ready to ACT instead of forcing a wasted
  // "now tell me what's here" turn. Captures the four things a model needs after
  // a navigation (effective URL, load status, semantic handles, size) in this
  // one call. Best-effort: any probe failure must not fail navigation.
  let effectiveUrl: string | null = null
  let readyState: string | null = null
  let pageTextChars: number | null = null
  if (shouldWait) {
    try {
      const res = await deps.tabs.executeJavaScript(
        ctx.tabId,
        'return { u: location.href, r: document.readyState, n: (document.body && document.body.innerText) ? document.body.innerText.length : 0 }'
      )
      if (res.success && res.result && typeof res.result === 'object') {
        const r = res.result as { u?: unknown; r?: unknown; n?: unknown }
        effectiveUrl = typeof r.u === 'string' ? r.u : null
        readyState = typeof r.r === 'string' ? r.r : null
        pageTextChars = typeof r.n === 'number' ? r.n : null
      }
    } catch {
      /* leave nulls */
    }
  }

  // Did we land somewhere other than where we asked? (login wall, regional
  // redirect, canonicalization.) Surface it so the model doesn't act blind.
  const landedUrl = effectiveUrl ?? parsedUrl
  const redirected = !!effectiveUrl && stripHash(effectiveUrl) !== stripHash(parsedUrl)

  // Orientation from the DOM (PageExtractor), NOT the a11y tree. The a11y tree
  // fails on table-heavy pages (empty `row` nodes, footer-first, stories crowded
  // out); PageCapture.actions is the real interactive surface in document order,
  // with real names/hrefs. We capture the whole cleaned page ONCE, write it to
  // disk (so later reads/greps are local, no re-fetch), and return a compact
  // document-order wireframe + the saved file paths. All best-effort.
  let wireframe: ReturnType<typeof buildPageWireframe> | null = null
  let saved: SavedPage | null = null
  if (shouldWait && deps.extractor) {
    try {
      const cap: PageCapture = await deps.extractor.run(ctx.tabId)
      wireframe = buildPageWireframe(cap)
      if (deps.savePage) {
        try {
          saved = await deps.savePage(cap, ctx.conversationId)
        } catch {
          saved = null
        }
      }
    } catch {
      wireframe = null
    }
  }

  const sizeHint =
    pageTextChars === null
      ? ''
      : ` Page text: ~${pageTextChars.toLocaleString()} chars` +
        (pageTextChars > 50_000
          ? ' (heavy — prefer distinctive multi-word grep_page queries; expect many hits).'
          : pageTextChars < 4_000
            ? ' (light — broad grep_page terms are safe).'
            : '.')

  const header = shouldWait
    ? `Navigated to ${landedUrl}${redirected ? ` (redirected from ${parsedUrl})` : ''} — ${readyState ?? 'loaded'}.`
    : `Navigating to ${parsedUrl}.`
  const savedText = saved
    ? `\nSaved full page: ${saved.markdownPath} · ${saved.actionsPath} (read/grep locally, no re-fetch).`
    : ''
  // Thin/loading capture (client-rendered SPA whose real content hasn't rendered
  // yet). Point the model at wait_for_load instead of letting it give up.
  const looksUnrendered =
    shouldWait &&
    ((typeof pageTextChars === 'number' && pageTextChars < 200) ||
      /^\s*loading\b/i.test(wireframe?.lines?.[0] && wireframe.lines[0].kind === 'action' ? wireframe.lines[0].name : ''))
  const thinHint = looksUnrendered
    ? '\n⚠ This page looks like it is still rendering (very little text / a loading shell). If you need its content, call wait_for_load, then read/grep — do not give up.'
    : ''
  const wireframeText = wireframe ? `\n${formatPageWireframe(wireframe)}` : ''
  const dataSourceDiscovery = network ? deps.tabs.getNetworkAwareness(ctx.tabId) : null
  const dataSourceText = dataSourceDiscovery
    ? `\n${formatDataSourceDiscovery(dataSourceDiscovery, { label: 'NAVIGATION DATA DISCOVERY' })}`
    : ''

  return withOptionalNetworkCapture(
    {
      ok: true,
      text: `${header}${sizeHint}${thinHint}${savedText}${wireframeText}${dataSourceText}`,
      structuredContent: {
        url: landedUrl,
        requestedUrl: parsedUrl,
        redirected,
        readyState,
        wait: shouldWait,
        timeoutMs,
        pageTextChars,
        ...(looksUnrendered ? { looksUnrendered: true } : {}),
        ...(saved ? { savedMarkdownPath: saved.markdownPath, savedActionsPath: saved.actionsPath } : {}),
        ...(wireframe ? { wireframe } : {}),
        ...(dataSourceDiscovery ? { dataSourceDiscovery } : {})
      }
    },
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

/**
 * `act` — the single fused action verb (target spec §2.2).
 *
 * Collapses the older point-action helpers into one
 * primitive: resolve a target (ref > query > coords), dispatch trusted input,
 * and ALWAYS return fresh post-action `after` state (contract C1) so the model
 * re-grounds for free without a separate perception turn.
 *
 * Resolution is exact (literal node + literal coordinate), never inferred
 * (C3). A target that no longer resolves returns ok:false with a re-orient
 * hint rather than acting on a guess (C6).
 */
export async function runAct(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const kind = String(args.kind ?? '').trim().toLowerCase()
  if (kind !== 'click' && kind !== 'type' && kind !== 'key' && kind !== 'select') {
    return { ok: false, text: 'act: "kind" must be one of click, type, key, select.' }
  }

  // ── Optional navigate-then-act fusion ──────────────────────────────────────
  // `act({ navigate: url, ... })` loads the URL, WAITS for the page to settle
  // (the "wait in between"), then runs the action against the settled page —
  // saving the navigate→act round-trip. It is fail-safe: if navigation fails, or
  // the target does not resolve on the settled page, the action does NOT click a
  // guess — it returns ok:false with the landed URL and a re-orient hint, so the
  // navigation's effect is still known and the model recovers cleanly.
  let navPrefix = ''
  if (args.navigate !== undefined) {
    const navPrelude = await runActNavigatePrelude(deps, args, ctx, kind)
    if (!navPrelude.ok) return navPrelude.outcome
    navPrefix = navPrelude.prefix
  }

  // URL before the action — compared in captureAfterState to decide whether the
  // act caused a navigation (and thus needs a fresh element digest, contract C1).
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null

  // ── key: no element target; dispatch a key event at the current focus ──────
  if (kind === 'key') {
    const key = String(args.key ?? '')
    const def = KEY_MAP[key.toLowerCase()]
    if (!def) {
      return { ok: false, text: `act(key): unknown key "${key}". Supported: ${Object.keys(KEY_MAP).join(', ')}.` }
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
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `${navPrefix}act(key): pressed ${def.key}.${afterStateLine(after)}`,
        structuredContent: { kind, key: def.key, after }
      },
      network
    )
  }

  // ── click / type / select: resolve an element target first ─────────────────
  const target = await resolveActTarget(deps, ctx.tabId, args)
  if (!target.ok) {
    // Fail-safe: if this was a navigate-then-act and the target is not on the
    // settled page, report the successful navigation + the miss + a re-orient
    // hint rather than clicking a guess. navPrefix already names the landed URL.
    return { ok: false, text: `${navPrefix}act(${kind}): ${target.text}` }
  }
  const { x, y, describe, matchInfo } = target

  if (kind === 'click') {
    const { network } = await deps.tabs.runWithPendingNetworkCapture(
      ctx.tabId,
      () => dispatchClick(deps.tabs, ctx.tabId, x, y)
    )
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `${navPrefix}act(click): ${describe} at (${x}, ${y}).${afterStateLine(after)}`,
        structuredContent: { kind, coordinates: { x, y }, match: matchInfo, after }
      },
      network
    )
  }

  if (kind === 'type') {
    const text = String(args.text ?? '')
    const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
      await dispatchClick(deps.tabs, ctx.tabId, x, y)
      await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
    })
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `${navPrefix}act(type): focused ${describe} and typed ${text.length} chars at (${x}, ${y}).${afterStateLine(after)}`,
        structuredContent: { kind, text, coordinates: { x, y }, match: matchInfo, after }
      },
      network
    )
  }

  // kind === 'select': focus a <select>, then commit the chosen option via DOM.
  const option = String(args.option ?? '')
  if (!option) {
    return { ok: false, text: 'act(select): "option" (the visible label or value to choose) is required.' }
  }
  const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
    await dispatchClick(deps.tabs, ctx.tabId, x, y)
  })
  const selectResult = await deps.tabs.executeJavaScript(
    ctx.tabId,
    selectOptionScript(x, y, option)
  )
  if (!selectResult.success) {
    return { ok: false, text: `act(select): could not choose "${option}" — ${selectResult.error}.` }
  }
  const selectPayload = selectResult.result as { ok?: boolean; reason?: string } | null
  if (!selectPayload || selectPayload.ok !== true) {
    const reason = selectPayload?.reason ?? 'no <select> at the resolved target'
    return { ok: false, text: `act(select): could not choose "${option}" — ${reason}.` }
  }
  const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
  return withOptionalNetworkCapture(
    {
      ok: true,
      text: `${navPrefix}act(select): chose "${option}" on ${describe} at (${x}, ${y}).${afterStateLine(after)}`,
      structuredContent: { kind, option, coordinates: { x, y }, match: matchInfo, after }
    },
    network
  )
}

export async function runSetField(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const value = String(args.value ?? '')
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const target = await resolveActTarget(deps, ctx.tabId, args)
  if (!target.ok) return { ok: false, text: `set_field: ${target.text}` }
  const { x, y, describe, matchInfo } = target
  const clear = args.clear === undefined ? true : !!args.clear

  const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
    await dispatchClick(deps.tabs, ctx.tabId, x, y)
  })
  const setResult = await deps.tabs.executeJavaScript(ctx.tabId, setFieldValueScript(x, y, value, clear))
  if (!setResult.success) {
    return { ok: false, text: `set_field: could not set the field — ${setResult.error}.` }
  }
  const payload = setResult.result as { ok?: boolean; reason?: string; mode?: string } | null
  if (!payload || payload.ok !== true) {
    return { ok: false, text: `set_field: could not set the field — ${payload?.reason ?? 'no editable field at the resolved target'}.` }
  }

  const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
  const mode = typeof payload.mode === 'string' ? payload.mode : 'field'
  return withOptionalNetworkCapture(
    {
      ok: true,
      text: `set_field: set ${describe} to ${value.length} chars via ${mode} at (${x}, ${y}).${afterStateLine(after)}`,
      structuredContent: {
        value,
        clear,
        mode,
        coordinates: { x, y },
        match: matchInfo,
        after
      }
    },
    network
  )
}

export async function runSubmit(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const hasExplicitTarget =
    (typeof args.ref === 'string' && args.ref.trim()) ||
    (typeof args.query === 'string' && args.query.trim()) ||
    (Number.isFinite(Number(args?.coords?.x)) && Number.isFinite(Number(args?.coords?.y)))

  if (hasExplicitTarget) {
    const target = await resolveActTarget(deps, ctx.tabId, args)
    if (!target.ok) return { ok: false, text: `submit: ${target.text}` }
    const { x, y, describe, matchInfo } = target
    const { network } = await deps.tabs.runWithPendingNetworkCapture(
      ctx.tabId,
      () => dispatchClick(deps.tabs, ctx.tabId, x, y)
    )
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `submit: activated ${describe} at (${x}, ${y}).${afterStateLine(after)}`,
        structuredContent: {
          mode: 'target',
          coordinates: { x, y },
          match: matchInfo,
          after
        }
      },
      network
    )
  }

  const { value: submitPayload, network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
    const submitResult = await deps.tabs.executeJavaScript(ctx.tabId, submitIntentScript())
    if (!submitResult.success) return { ok: false, reason: submitResult.error ?? 'submit script failed' }
    return submitResult.result as { ok?: boolean; mode?: string; label?: string; reason?: string } | null
  })
  if (submitPayload?.ok === true) {
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    const label = typeof submitPayload.label === 'string' && submitPayload.label ? ` "${submitPayload.label}"` : ''
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `submit: used ${submitPayload.mode ?? 'submit'}${label}.${afterStateLine(after)}`,
        structuredContent: {
          mode: submitPayload.mode ?? 'submit',
          ...(submitPayload.label ? { label: submitPayload.label } : {}),
          after
        }
      },
      network
    )
  }

  const enterOutcome = await runAct(deps, { kind: 'key', key: 'Enter' }, ctx)
  if (!enterOutcome.ok) {
    return { ok: false, text: 'submit: could not find a submittable form and Enter fallback also failed.' }
  }
  return {
    ...enterOutcome,
    text: enterOutcome.text.replace(/^act\(key\): pressed Enter\./, 'submit: pressed Enter as a fallback.')
  }
}

export async function runOpenResult(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const rawIndex = clampInt(args.index, 1, 50, 1)
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const hasRef = typeof args.ref === 'string' && args.ref.trim()
  const hasCoords = Number.isFinite(Number(args?.coords?.x)) && Number.isFinite(Number(args?.coords?.y))
  let target: ActTargetResolved | { ok: false; text: string }

  if (rawIndex > 1 && (hasRef || hasCoords)) {
    return { ok: false, text: 'open_result: `index` only applies to query-based matches. For ref/coords use the default index of 1.' }
  }

  if (typeof args.query === 'string' && args.query.trim()) {
    target = await resolveLiveQueryTarget(deps, ctx.tabId, args, rawIndex - 1)
  } else {
    target = await resolveActTarget(deps, ctx.tabId, args)
  }
  if (!target.ok) return { ok: false, text: `open_result: ${target.text}` }
  const { x, y, describe, matchInfo } = target

  const { network } = await deps.tabs.runWithPendingNetworkCapture(
    ctx.tabId,
    () => dispatchClick(deps.tabs, ctx.tabId, x, y)
  )
  const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
  return withOptionalNetworkCapture(
    {
      ok: true,
      text: `open_result: opened result ${rawIndex} via ${describe} at (${x}, ${y}).${afterStateLine(after)}`,
      structuredContent: {
        ...(typeof args.query === 'string' && args.query.trim() ? { query: args.query.trim(), index: rawIndex } : {}),
        coordinates: { x, y },
        match: matchInfo,
        after
      }
    },
    network
  )
}

/**
 * act's `navigate` mode: load args.navigate, then WAIT for the page to settle
 * before the caller resolves + dispatches the action. Reuses runNavigate (URL
 * validation, network-arm handling, orientation capture) and waitForTextStable
 * (the shared settle poll). Returns a short text prefix naming the landed URL so
 * the eventual result records that the navigation happened; on a bad URL or
 * failed load it returns ok:false with runNavigate's own error, and the action
 * is never attempted.
 *
 * Note: a navigate-then-act can only target by `query`/`coords` — a read_a11y
 * @ref or a wireframe idx cannot exist until AFTER this load, so there is
 * nothing stale to pass in. The settle-wait + resolveActTarget's fail-safe
 * (ok:false, no guess-click) are what keep resolving-on-an-unseen-page honest.
 */
async function runActNavigatePrelude(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext,
  kind: string
): Promise<{ ok: true; prefix: string } | { ok: false; outcome: ToolOutcome }> {
  const url = args.navigate
  // Settle budget: default 3s (inline settle, not a rescue), bounded 0–15s.
  const settleMs = clampInt(args.settle_ms, 0, 15_000, 3_000)

  const navOutcome = await runNavigate(deps, { url, wait: true }, ctx)
  if (!navOutcome.ok) {
    // Bad URL / failed load — surface runNavigate's error verbatim; do not act.
    return { ok: false, outcome: { ok: false, text: `act(${kind}) navigate: ${navOutcome.text}` } }
  }

  if (settleMs > 0) {
    await waitForTextStable((code) => deps.tabs.executeJavaScript(ctx.tabId, code), settleMs)
  }

  const nav = (navOutcome.structuredContent ?? {}) as { url?: unknown; redirected?: unknown }
  const landed = typeof nav.url === 'string' ? nav.url : String(url)
  const redirected = nav.redirected === true ? ' (redirected)' : ''
  return { ok: true, prefix: `Navigated to ${landed}${redirected}, settled. ` }
}

interface ActTargetResolved {
  ok: true
  x: number
  y: number
  describe: string
  matchInfo: Record<string, unknown>
}

/** Resolve an act() element target: ref > query > coords. */
async function resolveActTarget(
  deps: DriveToolsDeps,
  tabId: string,
  args: Record<string, any>
): Promise<ActTargetResolved | { ok: false; text: string }> {
  const refArg = typeof args.ref === 'string' ? args.ref.trim() : ''
  const queryArg = typeof args.query === 'string' ? args.query.trim() : ''
  const hasCoords = Number.isFinite(Number(args?.coords?.x)) && Number.isFinite(Number(args?.coords?.y))

  // ref (preferred): resolve against the latest read_a11y snapshot.
  if (refArg || isAxRefQuery(queryArg, args.type)) {
    const refQuery = refArg || queryArg
    const resolved = await resolveAxRefTarget(deps, tabId, refQuery)
    if (!resolved.ok) return { ok: false, text: resolved.text }
    const { node, x, y } = resolved
    return {
      ok: true,
      x,
      y,
      describe: describeAxRefMatch(node),
      matchInfo: {
        ref: node.ref,
        role: node.role,
        name: node.name,
        ...(node.frameLabel ? { frameLabel: node.frameLabel } : {})
      }
    }
  }

  // query: resolve via the live grep engine (text/regex/selector).
  if (queryArg) {
    return resolveLiveQueryTarget(deps, tabId, args, 0)
  }

  // coords (last resort): explicit, no resolution.
  if (hasCoords) {
    const x = Math.round(Number(args.coords.x))
    const y = Math.round(Number(args.coords.y))
    return { ok: true, x, y, describe: `coordinate (${x}, ${y})`, matchInfo: { x, y } }
  }

  return {
    ok: false,
    text: 'provide a target: ref (@a1 from read_a11y), query (text/selector), or coords {x,y}.'
  }
}

async function resolveLiveQueryTarget(
  deps: DriveToolsDeps,
  tabId: string,
  args: Record<string, any>,
  matchIndex: number
): Promise<ActTargetResolved | { ok: false; text: string }> {
  const queryArg = typeof args.query === 'string' ? args.query.trim() : ''
  if (!queryArg) {
    return { ok: false, text: 'query is required.' }
  }
  const explicitType = args.type || 'text'
  if (explicitType !== 'text' && explicitType !== 'regex' && explicitType !== 'selector') {
    return { ok: false, text: 'query "type" must be "text", "regex", or "selector".' }
  }
  const caseSensitive = !!args.caseSensitive
  const runResult = await executeGrepInTab(deps.tabs, tabId, queryArg, explicitType, caseSensitive, 2)
  if (!runResult.success) {
    return { ok: false, text: `search execution failed: ${runResult.error}` }
  }
  const matches = ((runResult.result as any[]) || []).filter(
    (m) => m.type !== 'error' && m.coordinates && m.visible
  )
  if (matches.length === 0) {
    return {
      ok: false,
      text: `no visible element matched "${queryArg}". Re-run read_a11y/grep_page to re-orient, then target a @ref.`
    }
  }
  if (matchIndex >= matches.length) {
    return {
      ok: false,
      text: `only ${matches.length} visible match(es) were found for "${queryArg}". Try a lower index or a sharper query.`
    }
  }
  const best = matches[matchIndex]
  let describe = `<${best.tagName || 'element'}>`
  if (best.selector) describe += ` (${best.selector})`
  if (best.matchedLine) describe += ` "${best.matchedLine}"`
  return {
    ok: true,
    x: best.coordinates.x,
    y: best.coordinates.y,
    describe,
    matchInfo: {
      ...(best.tagName ? { tagName: best.tagName } : {}),
      ...(best.selector ? { selector: best.selector } : {}),
      ...(best.matchedLine ? { matchedLine: best.matchedLine } : {}),
      matchIndex
    }
  }
}

/**
 * Contract C1: capture a fresh, cheap post-action snapshot in one round-trip.
 * Not a full a11y re-capture — just the signal the model needs to confirm the
 * state changed: url, title, readyState, and a bounded body-text length plus
 * the active element. Sampled live, so it is never stale.
 */
/**
 * A click that triggers navigation returns from dispatchClick BEFORE the new
 * page loads, so sampling immediately would see the old URL and never ship the
 * fresh-page digest (C1). Briefly wait for a navigation to start+settle:
 * resolve as soon as the URL changes and the document is interactive/complete,
 * or bail fast when nothing navigates so same-page clicks stay snappy.
 */
async function waitForActSettle(
  deps: DriveToolsDeps,
  tabId: string,
  beforeUrl: string | null,
  maxMs = 800
): Promise<void> {
  const deadline = Date.now() + maxMs
  // A navigation typically begins within a poll or two of the click. Give it a
  // short grace window to START; once we've seen a URL change we wait (longer)
  // for the new doc to become usable. If nothing has navigated within the grace
  // window, it was a same-page click — return so it stays snappy.
  const navStartGraceMs = 180
  let sawNavigation = false
  while (Date.now() < deadline) {
    let url: string | null = null
    let readyState: string | null = null
    try {
      const res = await deps.tabs.executeJavaScript(
        tabId,
        'return { u: location.href, r: document.readyState }'
      )
      if (res.success && res.result && typeof res.result === 'object') {
        const r = res.result as { u?: unknown; r?: unknown }
        url = typeof r.u === 'string' ? r.u : null
        readyState = typeof r.r === 'string' ? r.r : null
      }
    } catch {
      // The tab may be mid-swap during a navigation — that IS a navigation signal.
      sawNavigation = true
    }
    const navigated = !!url && !!beforeUrl && stripHash(url) !== stripHash(beforeUrl)
    if (navigated) {
      sawNavigation = true
      if (readyState === 'interactive' || readyState === 'complete') return
    } else if (!sawNavigation && Date.now() - (deadline - maxMs) >= navStartGraceMs) {
      return // same-page click — nothing started navigating in the grace window
    }
    await sleep(45)
  }
}

async function captureAfterState(
  deps: DriveToolsDeps,
  tabId: string,
  beforeUrl: string | null = null
): Promise<Record<string, unknown>> {
  await waitForActSettle(deps, tabId, beforeUrl)
  try {
    const res = await deps.tabs.executeJavaScript(tabId, AFTER_STATE_SCRIPT)
    if (res.success && res.result && typeof res.result === 'object') {
      const after = res.result as Record<string, unknown>
      // Contract C1, navigation case: when the act moved us to a new URL, the
      // model's prior page orientation is stale and it would otherwise burn a
      // re-orient read. So we ALSO ship a compact digest of the new page's top
      // interactive elements — enough to act again immediately. On a same-page
      // act (no URL change) the prior targets still hold, so we drop the list to
      // stay cheap and avoid context bloat.
      const afterUrl = typeof after.url === 'string' ? after.url : null
      const navigated = !!afterUrl && !!beforeUrl && stripHash(afterUrl) !== stripHash(beforeUrl)
      after.navigated = navigated
      if (!navigated && Array.isArray(after.elements)) delete after.elements
      return after
    }
  } catch {
    /* best-effort: a failed after-read must not fail the action */
  }
  return { url: deps.tabs.getTabUrl(tabId) ?? null, captured: false, navigated: false }
}

function stripHash(url: string): string {
  const i = url.indexOf('#')
  return i === -1 ? url : url.slice(0, i)
}

const AFTER_STATE_SCRIPT = `
  const active = document.activeElement;
  const activeDesc = active && active !== document.body
    ? (active.tagName.toLowerCase()
       + (active.id ? '#' + active.id : '')
       + (active.getAttribute && active.getAttribute('name') ? '[name=' + active.getAttribute('name') + ']' : ''))
    : null;
  // Compact digest of the top visible interactive elements, so a navigation can
  // hand the model something to act on without a separate read.
  function vis(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < (window.innerHeight || 800) && r.bottom > 0;
  }
  const seen = new Set();
  const elements = [];
  const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [onclick]');
  for (let i = 0; i < nodes.length && elements.length < 40; i++) {
    const el = nodes[i];
    if (!vis(el)) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('name') || '').replace(/[\\s\\u00a0]+/g, ' ').trim().slice(0, 80);
    if (!label) continue;
    const key = el.tagName + '|' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    elements.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      label: label,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    });
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyTextChars: (document.body && document.body.innerText) ? document.body.innerText.length : 0,
    activeElement: activeDesc,
    elements: elements,
    captured: true
  };
`

function afterStateLine(after: Record<string, unknown>): string {
  if (after.captured !== true) return ''
  const url = typeof after.url === 'string' ? after.url : ''
  const title = typeof after.title === 'string' && after.title ? ` — ${after.title}` : ''
  const active = typeof after.activeElement === 'string' && after.activeElement ? ` focus=${after.activeElement}` : ''
  let line = ` Now at ${url}${title} (${after.readyState}).${active}`
  // On a navigation, append the new page's top targets so the model can act
  // again without a separate read (contract C1).
  if (after.navigated === true && Array.isArray(after.elements) && after.elements.length) {
    const items = (after.elements as Array<Record<string, unknown>>)
      .slice(0, 20)
      .map((e) => `"${String(e.label)}" (${e.tag}@${e.x},${e.y})`)
      .join('; ')
    line += ` Page changed — top targets: ${items}.`
  }
  return line
}

/** In-page script: pick the option whose label/value matches on the <select> at (x,y). */
function selectOptionScript(x: number, y: number, option: string): string {
  return `
    const el = document.elementFromPoint(${x}, ${y});
    const sel = el && (el.closest ? el.closest('select') : null);
    if (!sel) return { ok: false, reason: 'no <select> at the resolved coordinate' };
    const want = ${JSON.stringify(option)};
    const wantLc = want.toLowerCase();
    let chosen = -1;
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i];
      if (o.value === want || o.text === want ||
          o.text.trim().toLowerCase() === wantLc || o.value.toLowerCase() === wantLc) {
        chosen = i; break;
      }
    }
    if (chosen === -1) return { ok: false, reason: 'no option matched "' + want + '"' };
    sel.selectedIndex = chosen;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: sel.options[chosen].value, label: sel.options[chosen].text };
  `
}

function setFieldValueScript(x: number, y: number, value: string, clear: boolean): string {
  return `
    const root = document.elementFromPoint(${x}, ${y});
    const el = root && root.closest
      ? root.closest('input, textarea, select, [contenteditable], [role="textbox"]')
      : null;
    if (!el) return { ok: false, reason: 'no editable field at the resolved coordinate' };

    const nextValue = ${JSON.stringify(value)};
    const clearExisting = ${clear ? 'true' : 'false'};
    const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder'))) || '';

    const fire = (name) => el.dispatchEvent(new Event(name, { bubbles: true }));

    if (el instanceof HTMLSelectElement) {
      const wantLc = nextValue.trim().toLowerCase();
      let chosen = -1;
      for (let i = 0; i < el.options.length; i++) {
        const o = el.options[i];
        const text = (o.text || '').trim().toLowerCase();
        const valueLc = (o.value || '').trim().toLowerCase();
        if (o.text === nextValue || o.value === nextValue || text === wantLc || valueLc === wantLc) {
          chosen = i;
          break;
        }
      }
      if (chosen === -1) return { ok: false, reason: 'no option matched "' + nextValue + '"' };
      el.selectedIndex = chosen;
      fire('input');
      fire('change');
      return { ok: true, mode: 'select', label: label || el.options[chosen].text || el.name || '' };
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const prior = el.value || '';
      const finalValue = clearExisting ? nextValue : prior + nextValue;
      el.focus();
      if (desc && typeof desc.set === 'function') desc.set.call(el, finalValue);
      else el.value = finalValue;
      fire('input');
      fire('change');
      return { ok: true, mode: 'value', label: label || el.name || el.id || '' };
    }

    if (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('role') === 'textbox')) {
      const prior = el.textContent || '';
      const finalValue = clearExisting ? nextValue : prior + nextValue;
      el.focus();
      el.textContent = finalValue;
      fire('input');
      fire('change');
      return { ok: true, mode: 'contenteditable', label: label || el.id || el.innerText.slice(0, 40) };
    }

    return { ok: false, reason: 'resolved element is not a supported field type' };
  `
}

function submitIntentScript(): string {
  return `
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const enabled = (el) => !(el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.disabled;
    const labelOf = (el) => ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('value') || el.getAttribute('name'))) || el.innerText || '').replace(/[\\s\\u00a0]+/g, ' ').trim();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const form = (active && active.closest('form')) || document.querySelector('form');
    if (!form) return { ok: false, reason: 'no form found near the current focus' };

    const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type]), [role="button"]');
    if (submitter instanceof HTMLElement && visible(submitter) && enabled(submitter)) {
      submitter.click();
      return { ok: true, mode: 'click', label: labelOf(submitter) };
    }

    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return { ok: true, mode: 'requestSubmit' };
    }

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return { ok: true, mode: 'submitEvent' };
  `
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
