import type { ThreadItem } from './protocol'

export interface CodexToolPolicyViolation {
  kind: 'native-browser-tool'
  reason: string
  guidance: string
}

const GLADDIS_BROWSER_GUIDANCE =
  'Use the gladdis dynamic tools for browser viewing/testing: search, fetch_page, browse_task, read_page, read_a11y, grep_page, or screenshot.'

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
  for (const tokens of commandSegments(command)) {
    const violation = segmentViolation(tokens)
    if (violation) return violation
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

function segmentViolation(tokens: string[]): CodexToolPolicyViolation | null {
  const commandIndex = firstCommandTokenIndex(tokens)
  if (commandIndex < 0) return null
  const commandName = basename(tokens[commandIndex]).toLowerCase()

  if (isShell(commandName)) {
    const nested = shellCommandArgument(tokens.slice(commandIndex + 1))
    return nested ? nativeBrowserCommandReason(nested) : null
  }

  if (isChromeCommand(commandName)) {
    return {
      kind: 'native-browser-tool',
      reason: 'External Chrome/Chromium commands bypass Gladdis\'s embedded browser.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (commandName === 'npx' && isPlaywrightBrowserAction(tokens.slice(commandIndex + 1))) {
    return {
      kind: 'native-browser-tool',
      reason: 'Playwright visual/browser runs use a separate browser instead of Gladdis\'s embedded Chromium.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (commandName === 'playwright' && isPlaywrightBrowserAction(tokens.slice(commandIndex))) {
    return {
      kind: 'native-browser-tool',
      reason: 'Playwright visual/browser runs use a separate browser instead of Gladdis\'s embedded Chromium.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if (
    commandName === 'puppeteer' ||
    ((commandName === 'node' || commandName === 'tsx') &&
      tokens.slice(commandIndex + 1).some((token) => /\bpuppeteer\b/i.test(token)))
  ) {
    return {
      kind: 'native-browser-tool',
      reason: 'Puppeteer controls a separate browser instead of Gladdis\'s embedded Chromium.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if ((commandName === 'xdg-open' || commandName === 'open') && tokens.slice(commandIndex + 1).some(isHttpUrl)) {
    return {
      kind: 'native-browser-tool',
      reason: 'Opening URLs through the OS bypasses the embedded browser tab.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  if ((commandName === 'curl' || commandName === 'wget') && tokens.slice(commandIndex + 1).some(isDevToolsPortUrl)) {
    return {
      kind: 'native-browser-tool',
      reason: 'DevTools-port probing bypasses Gladdis\'s browser authority.',
      guidance: GLADDIS_BROWSER_GUIDANCE
    }
  }

  return null
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null

  const pushToken = () => {
    if (token) {
      current.push(token)
      token = ''
    }
  }
  const pushSegment = () => {
    pushToken()
    if (current.length > 0) {
      segments.push(current)
      current = []
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else token += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      pushToken()
      continue
    }
    if (ch === ';' || ch === '|') {
      pushSegment()
      if (ch === '|' && command[i + 1] === '|') i++
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      pushSegment()
      i++
      continue
    }
    token += ch
  }
  pushSegment()
  return segments
}

function firstCommandTokenIndex(tokens: string[]): number {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    const name = basename(token).toLowerCase()
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      i++
      continue
    }
    if (name === 'sudo' || name === 'command') {
      i++
      continue
    }
    if (name === 'env') {
      i++
      continue
    }
    return i
  }
  return -1
}

function shellCommandArgument(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-c' || tokens[i] === '-lc' || tokens[i] === '-ic') return tokens[i + 1] ?? null
  }
  return null
}

function isShell(commandName: string): boolean {
  return commandName === 'bash' || commandName === 'sh' || commandName === 'zsh'
}

function isChromeCommand(commandName: string): boolean {
  return (
    commandName === 'google-chrome' ||
    commandName === 'google-chrome-stable' ||
    commandName === 'chromium' ||
    commandName === 'chromium-browser' ||
    commandName === 'chrome'
  )
}

function isPlaywrightBrowserAction(tokens: string[]): boolean {
  const start = tokens.findIndex((token) => basename(token).toLowerCase() === 'playwright')
  if (start < 0) return false
  const action = tokens[start + 1]?.toLowerCase()
  return action === 'screenshot' || action === 'open' || action === 'codegen' || action === 'test' || action === 'show-report'
}

function isHttpUrl(token: string): boolean {
  return /^https?:\/\//i.test(token)
}

function isDevToolsPortUrl(token: string): boolean {
  return /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):9222(?:\/|$)/i.test(token)
}

function basename(token: string): string {
  return token.split(/[\\/]/).pop() ?? token
}
