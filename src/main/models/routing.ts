// Routing is now minimal: the model decides whether to search or drive the
// browser by choosing tools. The only surviving regexes serve the Codex
// local-preview handoff (open a localhost URL Codex produced in the visible tab)
// and stripping the optional "[Active page: …]" preamble the renderer prepends.
const REPO_SHELL_RE =
  /\b(?:repo|repository|codebase|source|src\/|shared\/|package\.json|typescript|react|electron|implement|fix|patch|edit|modify|refactor|test|typecheck|build|commit|git|file|folder|directory|shell|terminal|command|workspace)\b/i
const LOCAL_PREVIEW_INTENT_RE =
  /\b(?:browser|preview|view|show|look at|open|launch|dev server|local server|localhost|127\.0\.0\.1)\b/i
const LOCAL_PREVIEW_WORK_RE =
  /\b(?:app|site|page|ui|frontend|react|vite|dev server|server|localhost|127\.0\.0\.1)\b/i
const LOCAL_PREVIEW_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s<>)\]`'"]*)?/gi
const ACTIVE_PAGE_PREAMBLE_RE = /^\[Active page:[^\]]+\]\s*\n{2,}/i

export function hasActivePagePreamble(text: string): boolean {
  return ACTIVE_PAGE_PREAMBLE_RE.test(text.trim())
}

export function stripActivePagePreamble(text: string): string {
  return text
    .trim()
    .replace(ACTIVE_PAGE_PREAMBLE_RE, '')
    .trim()
}

export function isUserFacingLocalPreviewRequest(text: string): boolean {
  const t = stripActivePagePreamble(text)
  if (/^(?:explain|why|how)\b/i.test(t) && REPO_SHELL_RE.test(t)) return false
  return LOCAL_PREVIEW_INTENT_RE.test(t) && LOCAL_PREVIEW_WORK_RE.test(t)
}

export function extractLocalPreviewUrl(text: string): string | null {
  LOCAL_PREVIEW_URL_RE.lastIndex = 0
  const match = LOCAL_PREVIEW_URL_RE.exec(text)
  if (!match) return null
  return match[0].replace(/[.,;:!?`'"]+$/, '')
}
