import type { TabManager } from '../../TabManager'
import type { ToolOutcome } from '../browserTools'
import { cap, safeJson } from './toolUtils'

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
    ? { ok: true, text: cap(safeJson(res.result)) }
    : { ok: false, text: `Error: ${res.error}` }
}

export async function runNavigate(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  deps.tabs.navigate(ctx.tabId, String(args.url ?? ''))
  return { ok: true, text: `Navigating to ${args.url}` }
}

export async function runClickXY(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const x = Number(args.x)
  const y = Number(args.y)
  await dispatchClick(deps.tabs, ctx.tabId, x, y)
  return { ok: true, text: `Clicked at (${x}, ${y}).` }
}

export async function runTypeText(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const text = String(args.text ?? '')
  await deps.tabs.cdpSend(ctx.tabId, 'Input.insertText', { text })
  return { ok: true, text: `Typed ${text.length} chars.` }
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
  return { ok: true, text: `Pressed ${key}.` }
}

export async function runCdpCommand(
  deps: DriveToolsDeps,
  args: Record<string, any>,
  ctx: DriveToolsContext
): Promise<ToolOutcome> {
  const method = String(args.method ?? '')
  const out = await deps.tabs.cdpSend(ctx.tabId, method, args.params ?? {})
  return { ok: true, text: cap(safeJson(out)) }
}

/** Trusted mouse click via CDP (move + press + release). */
async function dispatchClick(tabs: TabManager, tabId: string, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}
