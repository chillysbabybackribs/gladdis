import { mkdir, writeFile, readdir, stat, rm } from 'fs/promises'
import { join } from 'path'
import type { PageCapture } from '../../../shared/extraction'

/**
 * Per-conversation on-disk store of captured pages. navigate captures the whole
 * cleaned page once (PageExtractor → PageCapture) and writes it here, so every
 * later "read/grep the page" is a local file op with no re-fetch. Ephemeral
 * working data (a scratch dir), not an archive — bounded and auto-pruned.
 */

export interface PageStoreConfig {
  /** Root dir for all captures, e.g. <userData>/gladdis-pages. */
  baseDir: string
  /** Max files kept per conversation before oldest are evicted. */
  maxFilesPerConversation?: number
  /** Max total bytes per conversation before oldest are evicted. */
  maxBytesPerConversation?: number
}

export interface SavedPage {
  /** Absolute path to the cleaned readable markdown. */
  markdownPath: string
  /** Absolute path to the DOM-order interactive elements JSON. */
  actionsPath: string
  slug: string
}

const DEFAULT_MAX_FILES = 40
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 // 20 MB per conversation

/** Filesystem-safe slug from a URL: host + path, deduped by a short hash. */
export function slugForUrl(url: string): string {
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname
    path = u.pathname + (u.search || '')
  } catch {
    host = 'page'
    path = url
  }
  const raw = `${host}${path}`
  const cleaned = raw
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  // Short deterministic suffix so /a and /a?b=1 don't collide after cleaning.
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  const suffix = (h >>> 0).toString(36).slice(0, 6)
  return `${cleaned || 'page'}-${suffix}`
}

function renderMarkdown(cap: PageCapture): string {
  const lines: string[] = []
  lines.push(`# ${cap.title || cap.url}`)
  lines.push('')
  lines.push(`<${cap.url}>`)
  if (cap.content?.byline) lines.push(`_${cap.content.byline}_`)
  lines.push('')
  if (cap.content?.headings?.length) {
    lines.push('## Outline')
    for (const h of cap.content.headings) {
      lines.push(`${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`)
    }
    lines.push('')
  }
  const body = cap.content?.markdown?.trim() || cap.content?.text?.trim() || ''
  if (body) {
    lines.push('## Content')
    lines.push(body)
  }
  return lines.join('\n')
}

/** Write a captured page to the conversation's dir; returns the file paths. */
export async function savePageCapture(
  cap: PageCapture,
  conversationId: string,
  config: PageStoreConfig
): Promise<SavedPage> {
  const dir = join(config.baseDir, sanitizeSegment(conversationId))
  await mkdir(dir, { recursive: true })

  const slug = slugForUrl(cap.url)
  const markdownPath = join(dir, `${slug}.md`)
  const actionsPath = join(dir, `${slug}.actions.json`)

  await writeFile(markdownPath, renderMarkdown(cap), 'utf8')
  await writeFile(
    actionsPath,
    JSON.stringify({ url: cap.url, title: cap.title, capturedAt: cap.capturedAt, actions: cap.actions ?? [] }, null, 2),
    'utf8'
  )

  await prune(dir, config)
  return { markdownPath, actionsPath, slug }
}

function sanitizeSegment(seg: string): string {
  return (seg || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'default'
}

/** Evict oldest files when the conversation dir exceeds the count/byte caps. */
async function prune(dir: string, config: PageStoreConfig): Promise<void> {
  const maxFiles = config.maxFilesPerConversation ?? DEFAULT_MAX_FILES
  const maxBytes = config.maxBytesPerConversation ?? DEFAULT_MAX_BYTES
  let entries: Array<{ path: string; mtimeMs: number; size: number }> = []
  try {
    const names = await readdir(dir)
    entries = await Promise.all(
      names.map(async (name) => {
        const p = join(dir, name)
        const s = await stat(p)
        return { path: p, mtimeMs: s.mtimeMs, size: s.size }
      })
    )
  } catch {
    return
  }
  // Oldest first.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
  let count = entries.length
  for (const e of entries) {
    if (count <= maxFiles && totalBytes <= maxBytes) break
    try {
      await rm(e.path, { force: true })
      count -= 1
      totalBytes -= e.size
    } catch {
      /* best effort */
    }
  }
}

/** Remove a conversation's entire capture dir (e.g. on conversation end). */
export async function clearConversationPages(conversationId: string, config: PageStoreConfig): Promise<void> {
  const dir = join(config.baseDir, sanitizeSegment(conversationId))
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}
