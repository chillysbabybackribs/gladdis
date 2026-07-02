import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
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
import { capturePageDigest, diffPageDigests, formatPageDiffLine, type PageDiff, type PageDigest } from './pageDiff'

/**
 * Same-page verification carried in the action result: diff the settled page
 * against the pre-action digest so the model reads "what changed" instead of
 * re-running read_a11y/grep_page after every action. Empty on navigation (the
 * after-state brief already ships the new page's targets) and on capture
 * failure — never a fake "no change".
 */
async function resolvePageDiff(
  deps: DriveToolsDeps,
  tabId: string,
  before: PageDigest | null,
  after: Record<string, unknown>
): Promise<{ line: string; diff?: PageDiff }> {
  if (!before || after.navigated === true) return { line: '' }
  const afterDigest = await capturePageDigest(deps.tabs, tabId)
  if (!afterDigest) return { line: '' }
  const diff = diffPageDigests(before, afterDigest)
  return { line: formatPageDiffLine(diff), diff }
}

export interface DriveToolsDeps {
  tabs: TabManager
  resolveAxRef?: (tabId: string, query: string) => AxSnapshotNode | null
  /**
   * Ref lookup that ignores snapshot validity. Returns the node a stale @aN
   * ref USED to point at (identity only — bounds untrusted), so the target can
   * be re-resolved live by its accessible name instead of hard-failing.
   */
  resolveAxRefStale?: (tabId: string, query: string) => AxSnapshotNode | null
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
      text: cap(`${header}${sizeHint}${thinHint}${savedText}${wireframeText}${dataSourceText}`, 24_000),
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
    const beforeDigest = await capturePageDigest(deps.tabs, ctx.tabId)
    const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
      await deps.tabs.cdpSend(ctx.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
      await deps.tabs.cdpSend(ctx.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    })
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `${navPrefix}act(key): pressed ${def.key}.${afterStateLine(after)}${pd.line}`,
        structuredContent: { kind, key: def.key, ...(pd.diff ? { pageDiff: pd.diff } : {}), after }
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
  const beforeDigest = await capturePageDigest(deps.tabs, ctx.tabId)

  if (kind === 'click') {
    const { network } = await deps.tabs.runWithPendingNetworkCapture(
      ctx.tabId,
      () => dispatchClick(deps.tabs, ctx.tabId, x, y)
    )
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `${navPrefix}act(click): ${describe} at (${x}, ${y}).${afterStateLine(after)}${pd.line}`,
        structuredContent: { kind, coordinates: { x, y }, match: matchInfo, ...(pd.diff ? { pageDiff: pd.diff } : {}), after }
      },
      network
    )
  }

  if (kind === 'type') {
    const text = String(args.text ?? '')
    let focusMiss: string | null = null
    const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
      await dispatchClick(deps.tabs, ctx.tabId, x, y)
      // Honesty check: Input.insertText goes to the focused element. If the
      // click left focus on something non-editable the text vanishes silently
      // and the model believes it typed. Only a POSITIVE "not editable" blocks
      // (probe failures / iframes / async focus get the benefit of the doubt).
      focusMiss = await detectFocusMiss(deps, ctx.tabId)
      if (focusMiss) return
      await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
    })
    if (focusMiss) {
      return {
        ok: false,
        text: `${navPrefix}act(type): clicking ${describe} at (${x}, ${y}) left focus on ${focusMiss}, which is not editable — the text was NOT typed. Target the field itself (a @ref from read_a11y) or use set_field.`
      }
    }
    const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
    const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `${navPrefix}act(type): focused ${describe} and typed ${text.length} chars at (${x}, ${y}).${afterStateLine(after)}${pd.line}`,
        structuredContent: { kind, text, coordinates: { x, y }, match: matchInfo, ...(pd.diff ? { pageDiff: pd.diff } : {}), after }
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
  const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
  return withOptionalNetworkCapture(
    {
      ok: true,
      text: `${navPrefix}act(select): chose "${option}" on ${describe} at (${x}, ${y}).${afterStateLine(after)}${pd.line}`,
      structuredContent: { kind, option, coordinates: { x, y }, match: matchInfo, ...(pd.diff ? { pageDiff: pd.diff } : {}), after }
    },
    network
  )
}

/**
 * Suggestion outcome after a value commit: `selected` when the probe found a
 * plausibly matching autocomplete option and clicked it (trusted CDP click),
 * `open` when options appeared but none matched the typed value — reported,
 * never guess-clicked.
 */
type FieldSuggestion = { selected: string; count: number } | { open: string[] }

type FieldCommitResult =
  | { ok: true; mode: string; via?: string; label?: string; suggestion?: FieldSuggestion }
  | { ok: false; reason: string }

/**
 * The shared "click the resolved target, then commit the value" core used by
 * set_field (single) and fill_form (batch). No network-capture wrapping here —
 * callers own that (fill_form wraps its whole loop once).
 */
async function commitResolvedField(
  deps: DriveToolsDeps,
  tabId: string,
  target: ActTargetResolved,
  value: string,
  clear: boolean
): Promise<FieldCommitResult> {
  const selectorHint = typeof target.matchInfo.selector === 'string' ? target.matchInfo.selector : null
  await dispatchClick(deps.tabs, tabId, target.x, target.y)
  const setResult = target.node?.backendDOMNodeId
    ? await executeFieldCommitInResolvedFrame(deps.tabs, tabId, target.node, value, clear)
    : await deps.tabs.executeJavaScript(
      tabId,
      setFieldValueScript({ x: target.x, y: target.y, selector: selectorHint, useActiveElement: false }, value, clear)
    )
  if (!setResult.success) return { ok: false, reason: String(setResult.error) }
  const payload = setResult.result as { ok?: boolean; reason?: string; mode?: string; via?: string; label?: string } | null
  if (!payload || payload.ok !== true) {
    return { ok: false, reason: payload?.reason ?? 'no editable field at the resolved target' }
  }
  const committed: FieldCommitResult = {
    ok: true,
    mode: typeof payload.mode === 'string' ? payload.mode : 'field',
    ...(typeof payload.via === 'string' ? { via: payload.via } : {}),
    ...(typeof payload.label === 'string' ? { label: payload.label } : {})
  }
  // Suggestion-driven widgets (Google Flights "Where from?", location/airport/
  // typeahead comboboxes) keep their own state: setting the input's value is
  // NOT the commit — selecting a suggestion is. Without this step the field
  // reports ✓ while the widget ignored the value.
  if (committed.mode !== 'select') {
    const suggestion = await commitSuggestionIfOpen(deps, tabId, value)
    if (suggestion) return { ...committed, suggestion }
  }
  return committed
}

/**
 * After a value commit: detect an open autocomplete/combobox suggestion list,
 * click the best plausibly-matching option with a trusted CDP click, and
 * report what was chosen. Fields with no combobox indicators pay one cheap
 * probe round-trip (no wait); combobox fields wait event-driven (MutationObserver)
 * up to ~1.2s for async suggestions. Options that don't relate to the typed
 * value are surfaced, never guess-clicked.
 */
async function commitSuggestionIfOpen(
  deps: DriveToolsDeps,
  tabId: string,
  value: string
): Promise<FieldSuggestion | null> {
  if (!value.trim()) return null
  type SuggestionProbeResult = { kind?: string; x?: number; y?: number; text?: string; count?: number; options?: unknown[] }
  let probe: SuggestionProbeResult | null = null
  try {
    const res = await deps.tabs.executeJavaScript(tabId, suggestionProbeScript(value, 1200))
    probe = res.success && res.result && typeof res.result === 'object' ? (res.result as SuggestionProbeResult) : null
  } catch {
    return null
  }
  if (!probe) return null
  if (probe.kind === 'match' && Number.isFinite(probe.x) && Number.isFinite(probe.y)) {
    await dispatchClick(deps.tabs, tabId, Number(probe.x), Number(probe.y))
    return { selected: String(probe.text ?? ''), count: Number(probe.count ?? 1) }
  }
  if (probe.kind === 'open' && Array.isArray(probe.options) && probe.options.length > 0) {
    return { open: probe.options.slice(0, 5).map((o) => String(o)) }
  }
  return null
}

export async function runSetField(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const value = String(args.value ?? '')
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const clear = args.clear === undefined ? true : !!args.clear
  const hasTarget =
    (typeof args.ref === 'string' && args.ref.trim()) ||
    (typeof args.query === 'string' && args.query.trim()) ||
    (Number.isFinite(Number(args?.coords?.x)) && Number.isFinite(Number(args?.coords?.y)))

  let x: number | null = null
  let y: number | null = null
  let describe = 'the focused field'
  let matchInfo: Record<string, unknown> = { target: 'activeElement' }
  let network: Awaited<ReturnType<TabManager['runWithPendingNetworkCapture']>>['network'] = null
  let mode = 'field'
  let via: string | undefined
  let payloadLabel: string | undefined
  let suggestion: FieldSuggestion | undefined
  const beforeDigest = await capturePageDigest(deps.tabs, ctx.tabId)

  if (hasTarget) {
    const target = await resolveActTarget(deps, ctx.tabId, args)
    if (!target.ok) return { ok: false, text: `set_field: ${target.text}` }
    ;({ x, y, describe, matchInfo } = target)
    const wrapped = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, () =>
      commitResolvedField(deps, ctx.tabId, target, value, clear)
    )
    network = wrapped.network
    const committed = wrapped.value as FieldCommitResult
    if (!committed.ok) {
      return { ok: false, text: `set_field: could not set the field — ${committed.reason}.` }
    }
    ;({ mode } = committed)
    via = committed.via
    payloadLabel = committed.label
    suggestion = committed.suggestion
  } else {
    // No target: commit into the currently focused field. Models routinely call
    // set_field right after clicking/focusing a field with only {value, clear} —
    // honor that intent instead of erroring (was the single largest set_field
    // failure mode). The script still fails safe when nothing editable is focused.
    const setResult = await deps.tabs.executeJavaScript(
      ctx.tabId,
      setFieldValueScript({ x: null, y: null, selector: null, useActiveElement: true }, value, clear)
    )
    if (!setResult.success) {
      return { ok: false, text: `set_field: could not set the field — ${setResult.error}.` }
    }
    const payload = setResult.result as { ok?: boolean; reason?: string; mode?: string; via?: string; label?: string } | null
    if (!payload || payload.ok !== true) {
      return { ok: false, text: `set_field: could not set the field — ${payload?.reason ?? 'no editable field at the resolved target'}.` }
    }
    mode = typeof payload.mode === 'string' ? payload.mode : 'field'
    via = typeof payload.via === 'string' ? payload.via : undefined
    payloadLabel = typeof payload.label === 'string' ? payload.label : undefined
    if (mode !== 'select') {
      suggestion = (await commitSuggestionIfOpen(deps, ctx.tabId, value)) ?? undefined
    }
  }

  const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
  const where = x !== null && y !== null ? ` at (${x}, ${y})` : ''
  const label = payloadLabel && !hasTarget ? ` ("${payloadLabel}")` : ''
  const suggestionNote = suggestion
    ? 'selected' in suggestion
      ? ` Committed suggestion "${suggestion.selected}" (best of ${suggestion.count}).`
      : ` Suggestions opened but none matched the value — the widget may not have accepted it; click one to commit: ${suggestion.open.map((o) => `"${o}"`).join(' | ')}.`
    : ''
  const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
  return withOptionalNetworkCapture(
    {
      ok: true,
      text: `set_field: set ${describe}${label} to ${value.length} chars via ${mode}${where}.${suggestionNote}${afterStateLine(after)}${pd.line}`,
      structuredContent: {
        value,
        clear,
        mode,
        ...(via ? { resolvedVia: via } : {}),
        ...(suggestion ? { suggestion } : {}),
        ...(pd.diff ? { pageDiff: pd.diff } : {}),
        ...(x !== null && y !== null ? { coordinates: { x, y } } : {}),
        match: matchInfo,
        after
      }
    },
    network
  )
}

/** Field labels in fill_form that are @aN refs target the a11y snapshot directly. */
const FILL_FORM_MAX_FIELDS = 20

export async function runFillForm(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const fieldsArg = args.fields
  if (!fieldsArg || typeof fieldsArg !== 'object' || Array.isArray(fieldsArg)) {
    return { ok: false, text: 'fill_form: "fields" must be an object mapping each field\'s label (or @aN ref) to its value, e.g. {"Where to?": "Tokyo"}.' }
  }
  const entries = Object.entries(fieldsArg as Record<string, unknown>).map(
    ([field, value]) => [field, String(value ?? '')] as const
  )
  if (entries.length === 0) {
    return { ok: false, text: 'fill_form: "fields" is empty — provide at least one label → value pair.' }
  }
  if (entries.length > FILL_FORM_MAX_FIELDS) {
    return { ok: false, text: `fill_form: too many fields (${entries.length} > ${FILL_FORM_MAX_FIELDS}). Split into two calls.` }
  }
  const clear = args.clear === undefined ? true : !!args.clear
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const beforeDigest = await capturePageDigest(deps.tabs, ctx.tabId)

  // Fill in the given order; one failed field does NOT stop the rest — the
  // model gets a per-field ledger and only re-targets the misses.
  const results: Array<Record<string, unknown>> = []
  const { network } = await deps.tabs.runWithPendingNetworkCapture(ctx.tabId, async () => {
    for (const [field, value] of entries) {
      const trimmed = field.trim()
      const targetArgs = isAxRefQuery(trimmed) ? { ref: trimmed } : { query: field }
      const target = await resolveActTarget(deps, ctx.tabId, targetArgs)
      if (!target.ok) {
        results.push({ field, ok: false, reason: target.text })
        continue
      }
      const commit = await commitResolvedField(deps, ctx.tabId, target, value, clear)
      if (!commit.ok) {
        results.push({ field, ok: false, reason: commit.reason, match: target.matchInfo })
      } else {
        results.push({
          field,
          ok: true,
          mode: commit.mode,
          ...(commit.via ? { resolvedVia: commit.via } : {}),
          ...(commit.suggestion && 'selected' in commit.suggestion ? { suggestion: commit.suggestion.selected } : {}),
          ...(commit.suggestion && 'open' in commit.suggestion ? { suggestionsOpen: commit.suggestion.open } : {}),
          match: target.matchInfo
        })
      }
    }
  })

  const failed = results.filter((r) => r.ok !== true)
  const filled = results.length - failed.length

  // Bounded scan for required-but-still-empty fields the model did not name —
  // the form's own contract, surfaced before a doomed submit.
  let requiredUnfilled: Array<{ label: string; tag: string }> = []
  try {
    const scan = await deps.tabs.executeJavaScript(ctx.tabId, REQUIRED_UNFILLED_SCRIPT)
    if (scan.success && Array.isArray(scan.result)) {
      requiredUnfilled = (scan.result as Array<{ label?: unknown; tag?: unknown }>).map((r) => ({
        label: String(r.label ?? ''),
        tag: String(r.tag ?? '')
      }))
    }
  } catch {
    /* best-effort */
  }

  // Submit only when asked AND every field committed (fail-safe: never submit
  // a half-filled form).
  let submitText: string | null = null
  let submitted = false
  const unconfirmed = results.filter((r) => Array.isArray(r.suggestionsOpen))
  if (args.submit === true) {
    if (failed.length > 0) {
      submitText = `submit skipped: ${failed.length} field(s) failed — fix or drop them first.`
    } else if (unconfirmed.length > 0) {
      submitText = `submit skipped: ${unconfirmed.map((r) => `"${r.field}"`).join(', ')} opened suggestions that did not match the value — the widget may not hold it. Commit a suggestion first, then submit.`
    } else if (requiredUnfilled.length > 0) {
      submitText = `submit skipped: required field(s) still empty (${requiredUnfilled.map((r) => `"${r.label}"`).join(', ')}) — fill them first or submit explicitly.`
    } else {
      const submitOutcome = await runSubmit(deps, {}, ctx)
      submitted = submitOutcome.ok
      submitText = submitOutcome.ok ? submitOutcome.text : `submit failed: ${submitOutcome.text}`
    }
  }

  const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
  const lines = [`fill_form: ${filled}/${results.length} fields set.`]
  for (const r of results) {
    if (r.ok !== true) {
      lines.push(`  ✗ "${r.field}" — ${r.reason}`)
      continue
    }
    const suggested = typeof r.suggestion === 'string' ? `; committed suggestion "${r.suggestion}"` : ''
    const openNote = Array.isArray(r.suggestionsOpen)
      ? `; suggestions opened but none matched — may not be committed: ${(r.suggestionsOpen as string[]).map((o) => `"${o}"`).join(' | ')}`
      : ''
    lines.push(`  ✓ "${r.field}" (${r.mode}${r.resolvedVia ? `, via ${r.resolvedVia}` : ''}${suggested}${openNote})`)
  }
  if (requiredUnfilled.length > 0) {
    lines.push(`  Required but still empty: ${requiredUnfilled.map((r) => `"${r.label}" (${r.tag})`).join(', ')}`)
  }
  if (submitText) lines.push(`  ${submitText}`)

  const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
  return withOptionalNetworkCapture(
    {
      // Partial fills DID change the page — report ok with explicit per-field
      // failures so the model repairs the misses instead of redoing the batch.
      ok: filled > 0,
      text: `${lines.join('\n')}${afterStateLine(after)}${pd.line}`,
      structuredContent: {
        results,
        filled,
        failedCount: failed.length,
        requiredUnfilled,
        submitted,
        ...(pd.diff ? { pageDiff: pd.diff } : {}),
        after
      }
    },
    network
  )
}

const UPLOAD_MAX_FILES = 10

/**
 * `upload_file` — attach local files to an <input type=file> via CDP
 * DOM.setFileInputFiles. This is the FS→page bridge no keyboard/click path can
 * provide: the OS file-picker dialog is unreachable from injected input, but
 * owning the browser lets us set the input's FileList directly (fires the same
 * change events as a real user selection). Hidden inputs are valid targets —
 * real upload UIs almost always hide the input behind a styled button/label.
 */
export async function runUploadFile(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const rawPaths: unknown[] = Array.isArray(args.paths) ? args.paths : args.path !== undefined ? [args.path] : []
  const paths = rawPaths.map((p) => String(p ?? '').trim()).filter(Boolean)
  if (paths.length === 0) {
    return { ok: false, text: 'upload_file: provide "path" (or "paths") — the local file(s) to attach.' }
  }
  if (paths.length > UPLOAD_MAX_FILES) {
    return { ok: false, text: `upload_file: too many files (${paths.length} > ${UPLOAD_MAX_FILES}).` }
  }
  for (const p of paths) {
    try {
      const st = await stat(p)
      if (!st.isFile()) return { ok: false, text: `upload_file: ${p} is not a regular file.` }
    } catch {
      return { ok: false, text: `upload_file: local file not found: ${p}` }
    }
  }

  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const hasTarget =
    (typeof args.ref === 'string' && args.ref.trim()) ||
    (typeof args.query === 'string' && args.query.trim()) ||
    (Number.isFinite(Number(args?.coords?.x)) && Number.isFinite(Number(args?.coords?.y)))

  let anchor: { x: number | null; y: number | null; selector: string | null } = { x: null, y: null, selector: null }
  if (hasTarget) {
    const target = await resolveActTarget(deps, ctx.tabId, args)
    if (!target.ok) return { ok: false, text: `upload_file: ${target.text}` }
    anchor = {
      x: target.x,
      y: target.y,
      selector: typeof target.matchInfo.selector === 'string' ? target.matchInfo.selector : null
    }
  }

  const locate = await deps.tabs.executeJavaScript(ctx.tabId, locateFileInputScript(anchor, !hasTarget))
  if (!locate.success) {
    return { ok: false, text: `upload_file: could not locate a file input — ${locate.error}.` }
  }
  const found = locate.result as { ok?: boolean; selector?: string; label?: string; count?: number; reason?: string } | null
  if (!found || found.ok !== true || !found.selector) {
    return { ok: false, text: `upload_file: ${found?.reason ?? 'no <input type=file> found on this page (top frame)'}.` }
  }

  // Resolve the selector to a CDP nodeId and set its FileList directly.
  const doc = (await deps.tabs.cdpSend(ctx.tabId, 'DOM.getDocument', { depth: 1 })) as {
    root?: { nodeId?: number }
  }
  const rootNodeId = doc?.root?.nodeId
  if (typeof rootNodeId !== 'number') {
    return { ok: false, text: 'upload_file: DOM.getDocument returned no root node.' }
  }
  const q = (await deps.tabs.cdpSend(ctx.tabId, 'DOM.querySelector', {
    nodeId: rootNodeId,
    selector: found.selector
  })) as { nodeId?: number }
  if (!q?.nodeId) {
    return { ok: false, text: `upload_file: the located input (${found.selector}) did not resolve to a DOM node — the page may have re-rendered; retry.` }
  }
  await deps.tabs.cdpSend(ctx.tabId, 'DOM.setFileInputFiles', { files: paths, nodeId: q.nodeId })

  const after = await captureAfterState(deps, ctx.tabId, beforeUrl)
  const names = paths.map((p) => basename(p)).join(', ')
  const labelText = found.label ? ` ("${found.label}")` : ''
  return {
    ok: true,
    text: `upload_file: attached ${names} to the file input${labelText}. The page received the normal change event — look for its upload/preview UI in the after-state.${afterStateLine(after)}`,
    structuredContent: {
      files: paths,
      inputSelector: found.selector,
      ...(found.label ? { inputLabel: found.label } : {}),
      after
    }
  }
}

/**
 * In-page locator: pick THE file input, either associated with the resolved
 * target (direct / label→control / descendant / same-form single) or — with no
 * target — the page's only file input. Hidden inputs are eligible by design.
 * Returns a unique selector the main process re-resolves via CDP.
 */
function locateFileInputScript(
  anchor: { x: number | null; y: number | null; selector: string | null },
  noTarget: boolean
): string {
  return `
    /* gladdis:upload_locate */
    const uniq = (el) => {
      if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      const parts = [];
      let n = el;
      while (n && n !== document.body && parts.length < 10) {
        const parent = n.parentElement;
        if (!parent) break;
        const idx = Array.prototype.indexOf.call(parent.children, n) + 1;
        parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + idx + ')');
        n = parent;
      }
      return 'body > ' + parts.join(' > ');
    };
    const labelOf = (el) => {
      const lab = el.labels && el.labels[0] ? (el.labels[0].innerText || '').trim() : '';
      return (el.getAttribute('aria-label') || lab || el.name || el.id || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    };
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    if (all.length === 0) return { ok: false, reason: 'no <input type=file> on this page (top frame). If the uploader lives in an iframe, use diagnose_target' };

    if (${noTarget ? 'true' : 'false'}) {
      if (all.length > 1) {
        const opts = all.map((el) => '"' + (labelOf(el) || uniq(el)) + '"').join(', ');
        return { ok: false, reason: all.length + ' file inputs found (' + opts + ') — target one via query/ref', count: all.length };
      }
      return { ok: true, selector: uniq(all[0]), label: labelOf(all[0]), count: 1 };
    }

    const sel = ${JSON.stringify(anchor.selector)};
    const px = ${anchor.x === null ? 'null' : Math.round(anchor.x)};
    const py = ${anchor.y === null ? 'null' : Math.round(anchor.y)};
    let cand = null;
    if (sel) { try { cand = document.querySelector(sel); } catch { /* fall through */ } }
    if (!cand && px !== null) cand = document.elementFromPoint(px, py);
    if (!cand) return { ok: false, reason: 'the resolved target is not in the DOM anymore — re-orient and retry' };

    // Association ladder: the target itself → its label's control → a file
    // input inside it → the single file input of its form.
    let input = null;
    if (cand.matches && cand.matches('input[type="file"]')) input = cand;
    if (!input && cand.closest) {
      const lab = cand.closest('label');
      if (lab && lab.control && lab.control.matches && lab.control.matches('input[type="file"]')) input = lab.control;
    }
    if (!input && cand.querySelector) input = cand.querySelector('input[type="file"]');
    if (!input && cand.closest) {
      const form = cand.closest('form');
      if (form) {
        const inForm = form.querySelectorAll('input[type="file"]');
        if (inForm.length === 1) input = inForm[0];
      }
    }
    if (!input && all.length === 1) input = all[0];
    if (!input) return { ok: false, reason: 'the target does not lead to a file input — target the upload control (its label/button) or the input itself' };
    return { ok: true, selector: uniq(input), label: labelOf(input), count: all.length };
  `
}

const REQUIRED_UNFILLED_SCRIPT = `
  /* gladdis:required_scan */
  const out = [];
  const nodes = document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]');
  for (const el of nodes) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    let empty;
    if (el instanceof HTMLSelectElement) empty = !el.value;
    else if ('value' in el) empty = !(el.value || '').trim();
    else empty = !(el.textContent || '').trim();
    if (!empty) continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '(unlabeled)';
    out.push({ label: label, tag: el.tagName.toLowerCase() });
    if (out.length >= 8) break;
  }
  return out;
`

export async function runSubmit(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const beforeUrl = deps.tabs.getTabUrl(ctx.tabId) ?? null
  const beforeDigest = await capturePageDigest(deps.tabs, ctx.tabId)
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
    const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `submit: activated ${describe} at (${x}, ${y}).${afterStateLine(after)}${pd.line}`,
        structuredContent: {
          mode: 'target',
          coordinates: { x, y },
          match: matchInfo,
          ...(pd.diff ? { pageDiff: pd.diff } : {}),
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
    const pd = await resolvePageDiff(deps, ctx.tabId, beforeDigest, after)
    const label = typeof submitPayload.label === 'string' && submitPayload.label ? ` "${submitPayload.label}"` : ''
    return withOptionalNetworkCapture(
      {
        ok: true,
        text: `submit: used ${submitPayload.mode ?? 'submit'}${label}.${afterStateLine(after)}${pd.line}`,
        structuredContent: {
          mode: submitPayload.mode ?? 'submit',
          ...(submitPayload.label ? { label: submitPayload.label } : {}),
          ...(pd.diff ? { pageDiff: pd.diff } : {}),
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
  node?: AxSnapshotNode
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
    if (!resolved.ok) {
      // Self-heal a stale ref: the snapshot that minted @aN is gone (navigation
      // or TTL), but its identity may survive. Re-resolve the node's accessible
      // name against the LIVE page — same as if the model had retried with
      // query=<name> — so recovery costs zero extra turns. Fails safe: no live
      // name match → the original error, enriched with what the ref was.
      const stale = deps.resolveAxRefStale?.(tabId, refQuery)
      const staleName = stale?.name?.trim()
      if (staleName) {
        const relive = await resolveLiveQueryTarget(deps, tabId, { query: staleName, type: 'text' }, 0)
        if (relive.ok) {
          return {
            ...relive,
            describe: `${relive.describe} (ref ${refQuery} was stale — re-resolved live by its name "${staleName}")`,
            matchInfo: { ...relive.matchInfo, staleRef: refQuery, reResolvedByName: staleName }
          }
        }
        return {
          ok: false,
          text: `${resolved.text} That ref was ${stale!.role} "${staleName}", which no longer matches anything visible on the current page.`
        }
      }
      return { ok: false, text: resolved.text }
    }
    const { node, x, y } = resolved
    return {
      ok: true,
      x,
      y,
      describe: describeAxRefMatch(node),
      node,
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

/**
 * The set_field commit script. Resolving "which element is the field" from a
 * single hit-test pixel was the tool's top real-world failure (the grep match
 * centers on the LABEL text, whose pixel is often not over the control), so
 * this runs a ladder instead: matched selector → elementsFromPoint stack →
 * label→control association → aria-labelledby reverse lookup → field inside
 * the hit container → post-click focus. `useActiveElement` (the no-target
 * mode) skips the ladder and commits into the focused field directly.
 */
function setFieldValueScript(
  target: { x: number | null; y: number | null; selector: string | null; useActiveElement: boolean },
  value: string,
  clear: boolean
): string {
  return `
    /* gladdis:set_field */
    const EDITABLE = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable], [role="textbox"]';
    const isEditable = (n) => !!(n && n.matches && (n.matches(EDITABLE) || n.isContentEditable));
    const toEditable = (n) => {
      if (!n) return null;
      if (isEditable(n)) return n;
      return n.closest ? n.closest(EDITABLE) : null;
    };
    const deepActive = () => {
      let a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a && a !== document.body ? a : null;
    };

    let el = null;
    let via = '';
    if (${target.useActiveElement ? 'true' : 'false'}) {
      el = toEditable(deepActive());
      via = 'focused element';
      if (!el) return { ok: false, reason: 'no target was given and no editable field is focused — pass a @ref (from read_a11y) or a query naming the field' };
    } else {
      const px = ${target.x === null ? 'null' : Math.round(target.x)};
      const py = ${target.y === null ? 'null' : Math.round(target.y)};
      const sel = ${JSON.stringify(target.selector)};
      // 1. The grep-matched selector — the literal node, no pixel involved.
      if (sel) {
        try {
          const cand = document.querySelector(sel);
          el = toEditable(cand);
          if (!el && cand && cand.querySelector) el = cand.querySelector(EDITABLE);
          if (el) via = 'selector';
        } catch { /* invalid selector — fall through */ }
      }
      // 2. The full element stack under the point (not just the topmost).
      if (!el && px !== null && typeof document.elementsFromPoint === 'function') {
        for (const cand of document.elementsFromPoint(px, py)) {
          el = toEditable(cand);
          if (el) { via = 'hit-test'; break; }
        }
      }
      const hit = px !== null ? document.elementFromPoint(px, py) : null;
      // 3. Hit a <label>? Its control IS the field (covers for= and wrapping).
      if (!el && hit && hit.closest) {
        const lab = hit.closest('label');
        if (lab && lab.control && isEditable(lab.control)) { el = lab.control; via = 'label'; }
      }
      // 4. Hit text that labels a control via aria-labelledby.
      if (!el && hit && hit.closest) {
        const withId = hit.closest('[id]');
        if (withId) {
          for (const cand of document.querySelectorAll(EDITABLE)) {
            const attr = cand.getAttribute('aria-labelledby');
            if (attr && attr.split(/\\s+/).includes(withId.id)) { el = cand; via = 'aria-labelledby'; break; }
          }
        }
      }
      // 5. Hit a wrapper (combobox shell) with the real field inside.
      if (!el && hit && hit.querySelector) {
        const inner = hit.querySelector(EDITABLE);
        if (inner) { el = inner; via = 'descendant'; }
      }
      // 6. The click we just dispatched may have focused the real field.
      if (!el) { el = toEditable(deepActive()); if (el) via = 'post-click focus'; }
      if (!el) return { ok: false, reason: 'no editable field at the resolved target — the match landed on text/decoration, not the control. Run read_a11y and target the field\\'s own @ref' };
    }

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
      return { ok: true, mode: 'select', via, label: label || el.options[chosen].text || el.name || '' };
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
      return { ok: true, mode: 'value', via, label: label || el.name || el.id || '' };
    }

    if (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('role') === 'textbox')) {
      const prior = el.textContent || '';
      const finalValue = clearExisting ? nextValue : prior + nextValue;
      el.focus();
      el.textContent = finalValue;
      fire('input');
      fire('change');
      return { ok: true, mode: 'contenteditable', via, label: label || el.id || el.innerText.slice(0, 40) };
    }

    return { ok: false, reason: 'resolved element is not a supported field type' };
  `
}

/**
 * In-page probe run right after a value commit, while the field still holds
 * focus. Detects a suggestion listbox (ARIA link from the field, or visible
 * [role=option]s), waits event-driven for async suggestions ONLY when the
 * field carries combobox indicators, scores options against the typed value,
 * and returns the best match's live center coordinates for a trusted click.
 */
function suggestionProbeScript(value: string, waitMs: number): string {
  return `
    /* gladdis:suggestion_probe */
    const VALUE = ${JSON.stringify(value)};
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    const field = a && a !== document.body ? a : null;
    const combo = field && field.closest
      ? field.closest('[role="combobox"], [aria-autocomplete]:not([aria-autocomplete="none"]), [aria-haspopup="listbox"]')
      : null;
    const idSet = new Set();
    for (const el of [field, combo]) {
      if (!el || !el.getAttribute) continue;
      for (const attr of ['aria-controls', 'aria-owns']) {
        const v = el.getAttribute(attr);
        if (v) for (const id of v.split(/[\\s\\u00a0]+/)) { if (id) idSet.add(id); }
      }
    }
    const linkedIds = [...idSet];
    const isCombo = !!combo || linkedIds.length > 0;
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const collect = () => {
      const pools = [];
      for (const id of linkedIds) { const n = document.getElementById(id); if (n) pools.push(n); }
      if (pools.length === 0) pools.push(document);
      const out = [];
      const seen = new Set();
      for (const pool of pools) {
        for (const o of pool.querySelectorAll('[role="option"], [role="listbox"] li')) {
          if (seen.has(o) || !visible(o)) continue;
          seen.add(o);
          out.push(o);
          if (out.length >= 30) return out;
        }
      }
      return out;
    };
    let opts = collect();
    if (opts.length === 0 && !isCombo) return { kind: 'none' };
    if (opts.length === 0) {
      opts = await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { obs.disconnect(); } catch { /* already gone */ }
          clearTimeout(timer);
          resolve(collect());
        };
        const obs = new MutationObserver(() => { if (collect().length > 0) finish(); });
        obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
        const timer = setTimeout(finish, ${Math.round(waitMs)});
      });
    }
    if (opts.length === 0) return { kind: 'none' };
    const clean = (s) => (s || '').replace(/[\\s\\u00a0]+/g, ' ').trim();
    const texts = opts.map((o) => clean(o.innerText || o.textContent).slice(0, 80));
    const want = clean(VALUE).toLowerCase();
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < opts.length; i++) {
      const t = texts[i].toLowerCase();
      if (!t) continue;
      let score = 0;
      if (t === want) score = 5;
      else if (t.startsWith(want)) score = 4;
      else if (want && t.includes(want)) score = 3;
      else if (t && want.includes(t)) score = 2;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx === -1) return { kind: 'open', options: texts.filter(Boolean).slice(0, 5) };
    const r = opts[bestIdx].getBoundingClientRect();
    return {
      kind: 'match',
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: texts[bestIdx],
      count: opts.length
    };
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

const FOCUSED_EDITABLE_PROBE = `
  /* gladdis:focus_probe */
  const EDITABLE = 'input:not([type="hidden"]):not([disabled]), textarea, select, [contenteditable], [role="textbox"]';
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  // Focus inside an iframe is opaque from here — report unknown, not a miss.
  if (a && a.tagName === 'IFRAME') return { editable: null, focus: 'iframe' };
  const editable = !!(a && a !== document.body && a.matches && (a.matches(EDITABLE) || a.isContentEditable));
  const focus = a && a !== document.body
    ? a.tagName.toLowerCase() + (a.id ? '#' + a.id : '')
    : '<body>';
  return { editable, focus };
`

/**
 * After a click that should focus a field: null when focus looks typeable (or
 * cannot be judged), otherwise a short description of what wrongly holds
 * focus. Retries once after a beat for apps that move focus asynchronously.
 */
async function detectFocusMiss(deps: DriveToolsDeps, tabId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let probe: { editable?: boolean | null; focus?: string } | null = null
    try {
      const res = await deps.tabs.executeJavaScript(tabId, FOCUSED_EDITABLE_PROBE)
      probe = res.success && res.result && typeof res.result === 'object'
        ? (res.result as { editable?: boolean | null; focus?: string })
        : null
    } catch {
      return null
    }
    if (!probe || probe.editable !== false) return null
    if (attempt === 0) await sleep(120)
    else return probe.focus || 'nothing'
  }
  return null
}

/** Trusted mouse click via CDP (move + press + release). */
async function dispatchClick(tabs: TabManager, tabId: string, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

const SET_FIELD_ON_NODE_FN = `function(nextValue, clearExisting) {
  const EDITABLE = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable], [role="textbox"]';
  const isEditable = (n) => !!(n && n.matches && (n.matches(EDITABLE) || n.isContentEditable));
  const toEditable = (n) => {
    if (!n) return null;
    if (isEditable(n)) return n;
    return n.closest ? n.closest(EDITABLE) : null;
  };
  const deepActive = (doc) => {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== doc.body ? a : null;
  };

  const root = this instanceof Element ? this : null;
  const doc = (root && root.ownerDocument) || document;
  let el = toEditable(root);
  let via = el ? 'resolved node' : '';
  if (!el && root && root.querySelector) {
    el = root.querySelector(EDITABLE);
    if (el) via = 'resolved descendant';
  }
  if (!el && root && root.closest) {
    const lab = root.closest('label');
    if (lab && lab.control && isEditable(lab.control)) {
      el = lab.control;
      via = 'resolved label';
    }
  }
  if (!el) {
    el = toEditable(deepActive(doc));
    if (el) via = 'focused element';
  }
  if (!el) return { ok: false, reason: 'no editable field at the resolved target' };

  const tag = (el.tagName || '').toLowerCase();
  const isSelect = tag === 'select';
  const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder'))) || '';

  if (isSelect) {
    const want = String(nextValue);
    const wantLc = want.toLowerCase();
    let chosen = -1;
    for (let i = 0; i < el.options.length; i++) {
      const o = el.options[i];
      if (o.value === want || o.text === want || o.text.trim().toLowerCase() === wantLc || o.value.toLowerCase() === wantLc) {
        chosen = i;
        break;
      }
    }
    if (chosen === -1) return { ok: false, reason: 'no option matched "' + want + '"' };
    el.selectedIndex = chosen;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, mode: 'select', via, label: label || el.options[chosen].text || '' };
  }

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  const current = 'value' in el ? String(el.value || '') : String(el.textContent || '');
  const finalValue = clearExisting ? String(nextValue) : current + String(nextValue);
  if (setter && 'value' in el) setter.call(el, finalValue);
  else if ('value' in el) el.value = finalValue;
  else el.textContent = finalValue;
  if (el.focus) el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, mode: 'value', via, label };
}`

async function executeFieldCommitInResolvedFrame(
  tabs: TabManager,
  tabId: string,
  node: AxSnapshotNode,
  value: string,
  clear: boolean
): Promise<{ success: true; result: unknown } | { success: false; error: string }> {
  if (typeof node.backendDOMNodeId !== 'number') {
    return { success: false, error: 'resolved target has no backend DOM node id' }
  }
  const sessionId = node.frameId ? tabs.cdpSessionIdForTarget(tabId, node.frameId) ?? undefined : undefined
  try {
    const resolved = (await tabs.cdpSend(
      tabId,
      'DOM.resolveNode',
      { backendNodeId: node.backendDOMNodeId },
      sessionId
    )) as { object?: { objectId?: string } }
    const objectId = resolved.object?.objectId
    if (!objectId) return { success: false, error: 'could not resolve the target DOM node' }
    const call = (await tabs.cdpSend(
      tabId,
      'Runtime.callFunctionOn',
      {
        functionDeclaration: SET_FIELD_ON_NODE_FN,
        objectId,
        arguments: [{ value }, { value: clear }],
        returnByValue: true
      },
      sessionId
    )) as { result?: { value?: unknown } }
    return { success: true, result: call.result?.value ?? null }
  } catch (error) {
    return { success: false, error: (error as Error)?.message ?? String(error) }
  }
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
      (method, params, sessionId) => deps.tabs.cdpSend(tabId, method, params, sessionId),
      node,
      {
        width: Math.round(viewport.clientWidth ?? 0),
        height: Math.round(viewport.clientHeight ?? 0)
      },
      node.frameId ? deps.tabs.cdpSessionIdForTarget(tabId, node.frameId) ?? undefined : undefined
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
