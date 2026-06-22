import type { ThreadItem } from './protocol'

export interface CodexToolPolicyViolation {
  kind: 'native-browser-tool'
  reason: string
  guidance: string
}

const GLADDIS_BROWSER_GUIDANCE =
  'Use the gladdis dynamic tools for browser viewing/testing: search, fetch_page, browse_task, read_page, grep_page, or screenshot.'

/**
 * Codex may use its native shell/file tools for repo work, but browser viewing
 * must stay inside Gladdis's embedded Chromium view. This catches external
 * browser automation before it becomes the app's de facto visual test path.
 */
export function findCodexToolPolicyViolation(item: ThreadItem): CodexToolPolicyViolation | null {
  if (item?.type !== 'commandExecution') return null
  const command = commandToText((item as any).command)
  if (!command) return null
  return nativeBrowserCommandReason(command)
}

export function nativeBrowserCommandReason(command: string): CodexToolPolicyViolation | null {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (!normalized) return null

  if (/\b(?:google-chrome(?:-stable)?|chromium(?:-browser)?|chrome)\b/i.test(normalized)) {
    return {
      kind: 'native-browser-tool',
      reason: 'External Chrome/Chromium commands bypass Gladdis\'s embedded browser.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (/\b(?:npx\s+)?playwright\s+(?:screenshot|open|codegen|test|show-report)\b/i.test(normalized)) {
    return {
      kind: 'native-browser-tool',
      reason: 'Playwright visual/browser runs use a separate browser instead of Gladdis\'s embedded Chromium.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (/\bpuppeteer\b/i.test(normalized)) {
    return {
      kind: 'native-browser-tool',
      reason: 'Puppeteer controls a separate browser instead of Gladdis\'s embedded Chromium.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (/\b(?:xdg-open|open)\s+https?:\/\//i.test(normalized)) {
    return {
      kind: 'native-browser-tool',
      reason: 'Opening URLs through the OS bypasses the embedded browser tab.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (/\b(?:curl|wget)\b[\s\S]*(?:127\.0\.0\.1|localhost):9222\b/i.test(normalized)) {
    return {
      kind: 'native-browser-tool',
      reason: 'DevTools-port probing bypasses Gladdis\'s browser authority.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  return null
}

function commandToText(command: unknown): string {
  if (typeof command === 'string') return command
  if (Array.isArray(command)) return command.map((part) => String(part)).join(' ')
  if (command && typeof command === 'object') {
    const record = command as Record<string, unknown>
    if (typeof record.command === 'string') return record.command
    if (Array.isArray(record.argv)) return record.argv.map((part) => String(part)).join(' ')
  }
  return ''
}
