import type { ChatRequest, ChatStreamEvent } from '../../../shared/types'
import type { BrowserTools } from './browserTools'
import { extractLocalPreviewUrl, isUserFacingLocalPreviewRequest } from './routing'

const SCREENSHOT_PAINT_DELAY_MS = 800

/**
 * Mixed Codex tasks often need filesystem/shell work first, then a
 * user-facing browser result. When the user's request explicitly asks to view
 * a local preview and Codex reports a localhost URL, this bridge makes the
 * final hand-off visible: navigate Gladdis's active tab to the URL, then snap
 * a confirmation screenshot so the chat shows what shipped.
 *
 * Pure functions (no class state) — moved out of ChatService so the service
 * stays focused on per-turn orchestration.
 */
export async function openCodexLocalPreviewIfRequested(args: {
  req: ChatRequest
  userText: string
  output: string
  tools: BrowserTools
  emit: (event: ChatStreamEvent) => void
}): Promise<void> {
  const { req, userText, output, tools, emit } = args
  if (!isUserFacingLocalPreviewRequest(userText)) return
  const url = extractLocalPreviewUrl(output)
  if (!url) return

  const tabId = tools.tabs.liveTabId(req.tabId)
  const callId = `codex-local-preview-${Date.now()}`
  emit({
    requestId: req.requestId,
    type: 'tool_call',
    tool: 'navigate',
    args: { url, owner: 'gladdis', reason: 'codex-local-preview' },
    callId
  })
  tools.tabs.navigate(tabId, url)
  emit({
    requestId: req.requestId,
    type: 'tool_result',
    callId,
    ok: true,
    preview: `Opened ${url} in the browser.`
  })
  emit({
    requestId: req.requestId,
    type: 'delta',
    text: `\nOpened the local preview in the browser: ${url}\n`
  })
  await captureLocalPreviewScreenshot({
    requestId: req.requestId,
    tabId,
    url,
    tools,
    emit
  })
}

async function captureLocalPreviewScreenshot(args: {
  requestId: string
  tabId: string
  url: string
  tools: BrowserTools
  emit: (event: ChatStreamEvent) => void
}): Promise<void> {
  const { requestId, tabId, url, tools, emit } = args
  const callId = `codex-local-preview-screenshot-${Date.now()}`
  emit({
    requestId,
    type: 'tool_call',
    tool: 'screenshot_confirmation',
    args: { url, fullPage: false, reason: 'local-preview-confirmation' },
    callId
  })
  try {
    // Give the WebContentsView a beat to commit the navigation and paint.
    await sleep(SCREENSHOT_PAINT_DELAY_MS)
    const imageBase64 = await tools.tabs.capturePagePng(tabId, false)
    const bytes = Math.round((imageBase64.length * 3) / 4)
    const kb = Math.max(1, Math.round(bytes / 1024))
    emit({
      requestId,
      type: 'tool_result',
      callId,
      ok: true,
      preview: `Captured visible screenshot confirmation for ${url} (${kb} KB).`,
      imageDataUrl: `data:image/png;base64,${imageBase64}`
    })
    emit({
      requestId,
      type: 'delta',
      text: `Screenshot confirmation captured for the local preview.\n`
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit({
      requestId,
      type: 'tool_result',
      callId,
      ok: false,
      preview: `Screenshot confirmation failed: ${message}`
    })
    emit({
      requestId,
      type: 'delta',
      text: `Screenshot confirmation failed: ${message}\n`
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
