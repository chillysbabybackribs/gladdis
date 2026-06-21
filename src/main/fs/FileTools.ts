import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat
} from 'fs/promises'
import { execFile } from 'child_process'
import { createReadStream } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { createInterface } from 'readline'
import { promisify } from 'util'

/**
 * Raw filesystem operations the agent can drive. Whole-filesystem scope —
 * any path the OS user can reach — so every method resolves the path to an
 * absolute one and operates directly. Writes are auto-applied (create/
 * overwrite/edit happen immediately); the caller surfaces what changed.
 *
 * All methods throw on failure with a human-readable message; the tool
 * dispatch layer turns that into a structured tool_result.
 */

/** Hard cap on bytes returned from a read, so huge files can't blow up the model context. */
const MAX_READ_BYTES = 256 * 1024
/** Default first-pass file window. The model can request an explicit range or full read. */
const DEFAULT_READ_LINES = 120
/** Files at or below this size are cheaper to read once than to force another range call. */
const SMALL_FILE_FULL_LINES = 220
/** Cap on entries returned from a single list / search, to stay bounded. */
const MAX_ENTRIES = 1000
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const SEARCH_CONCURRENCY = 24
const DEFAULT_SEARCH_CONTEXT_LINES = 2
const MAX_SEARCH_CONTEXT_LINES = 8
const SEARCH_LANE_MULTIPLIER = 3
const MIN_SEARCH_LANE_LIMIT = 50
const execFileAsync = promisify(execFile)

interface DiffSummary {
  /** Lines that exist after but not before (added). */
  added: number
  /** Lines that existed before but not after (removed). */
  removed: number
  /** A compact unified-ish preview, capped. */
  preview: string
}

interface WriteResult {
  path: string
  created: boolean
  bytes: number
  diff: DiffSummary
}

interface EditResult {
  path: string
  replacements: number
  diff: DiffSummary
}

interface DirEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  size: number
}

interface SearchHit {
  path: string
  kind: 'content' | 'path'
  line: number
  text: string
  startLine: number
  endLine: number
  snippet: string
  score: number
}

interface ReadResult {
  path: string
  content: string
  truncated: boolean
  totalLines: number
  startLine: number
  endLine: number
  defaultWindow: boolean
}

export class FileTools {
  /**
   * Root that represents the user-chosen working folder.
   * Absolute paths still work anywhere the OS user can reach.
   */
  private root: string | null = null

  /** Repoint the working folder. Pass null to clear it (cwd-relative again). */
  setRoot(root: string | null): void {
    this.root = root?.trim() || null
  }

  /** The current working folder, or null when none is pinned. */
  getRoot(): string | null {
    return this.root
  }

  /** Resolve a caller-supplied path against the workspace root (or cwd). */
  private resolve(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.root ?? process.cwd(), path)
  }

  /** Read a UTF-8 file, optionally a 1-based inclusive line range. */
  async read(
    path: string,
    startLine?: number,
    endLine?: number,
    full = false
  ): Promise<ReadResult> {
    const abs = this.resolve(path)
    if (startLine != null || endLine != null) return readLineRange(abs, startLine, endLine)
    if (!full) {
      const preview = await readLineRange(abs, 1, SMALL_FILE_FULL_LINES, true)
      if (preview.totalLines <= SMALL_FILE_FULL_LINES) {
        return { ...preview, endLine: preview.totalLines, defaultWindow: false }
      }
      const previewLines = preview.content.split('\n').slice(0, DEFAULT_READ_LINES)
      return {
        ...preview,
        content: previewLines.join('\n'),
        endLine: DEFAULT_READ_LINES,
        defaultWindow: true
      }
    }
    const buf = await readFile(abs)
    let truncated = false
    let text: string
    if (buf.byteLength > MAX_READ_BYTES) {
      text = buf.subarray(0, MAX_READ_BYTES).toString('utf8')
      truncated = true
    } else {
      text = buf.toString('utf8')
    }
    const lines = text.split('\n')
    const totalLines = lines.length
    return {
      path: abs,
      content: text,
      truncated,
      totalLines,
      startLine: 1,
      endLine: totalLines,
      defaultWindow: false
    }
  }

  /** Create or overwrite a file (parent dirs created as needed). */
  async write(path: string, content: string): Promise<WriteResult> {
    const abs = this.resolve(path)
    const prior = await this.tryReadString(abs)
    const created = prior == null
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return {
      path: abs,
      created,
      bytes: Buffer.byteLength(content, 'utf8'),
      diff: diffSummary(prior ?? '', content)
    }
  }

  /**
   * Exact string replacement inside an existing file. By default the match
   * must be unique (replaceAll=false → exactly one occurrence), mirroring a
   * surgical edit; replaceAll replaces every occurrence.
   */
  async edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    const abs = this.resolve(path)
    const prior = await this.tryReadString(abs)
    if (prior == null) throw new Error(`File does not exist: ${abs}`)
    if (oldString === newString) throw new Error('oldString and newString are identical')

    const occurrences = countOccurrences(prior, oldString)
    if (occurrences === 0) throw new Error('oldString not found in file')
    if (!replaceAll && occurrences > 1) {
      throw new Error(
        `oldString is not unique (${occurrences} matches). Add surrounding context or set replaceAll.`
      )
    }
    const next = replaceAll
      ? prior.split(oldString).join(newString)
      : prior.replace(oldString, newString)

    await writeFile(abs, next, 'utf8')
    return {
      path: abs,
      replacements: replaceAll ? occurrences : 1,
      diff: diffSummary(prior, next)
    }
  }

  /** List a directory's immediate entries (sorted dirs-first then name). */
  async list(path: string): Promise<{ path: string; entries: DirEntry[]; truncated: boolean }> {
    const abs = this.resolve(path)
    const names = await readdir(abs)
    const entries: DirEntry[] = []
    for (const name of names.slice(0, MAX_ENTRIES)) {
      try {
        const st = await stat(join(abs, name))
        entries.push({
          name,
          type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
          size: st.isFile() ? st.size : 0
        })
      } catch {
        entries.push({ name, type: 'other', size: 0 })
      }
    }
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    )
    return { path: abs, entries, truncated: names.length > MAX_ENTRIES }
  }

  /**
   * Search source files by content and, for fixed-string queries, by file
   * path/name in parallel. Lowercase queries stay broad; queries containing
   * uppercase letters become case-sensitive for better symbol precision.
   * `glob` restricts which file names are scanned (a simple * / ? glob, no
   * path separators). Bounded by MAX_ENTRIES hits and a directory-skip list
   * for the usual heavy dirs.
   */
  async search(
    query: string,
    path = '.',
    glob?: string,
    contextLines = DEFAULT_SEARCH_CONTEXT_LINES,
    maxResults = MAX_ENTRIES,
    regex = false
  ): Promise<{ root: string; hits: SearchHit[]; truncated: boolean }> {
    const root = this.resolve(path)
    if (!query.trim()) return { root, hits: [], truncated: false }
    const limit = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(maxResults) || MAX_ENTRIES))
    const context = Math.max(0, Math.min(MAX_SEARCH_CONTEXT_LINES, Math.floor(contextLines) || 0))
    try {
      return await searchWithRipgrep(root, query, glob, context, limit, regex)
    } catch {
      return searchWithNode(root, query, glob, context, limit, regex)
    }
  }

  private async tryReadString(abs: string): Promise<string | null> {
    try {
      return await readFile(abs, 'utf8')
    } catch {
      return null
    }
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'out', '.next', 'build'])

async function searchWithNode(
  root: string,
  query: string,
  glob: string | undefined,
  context: number,
  limit: number,
  regex: boolean
): Promise<{ root: string; hits: SearchHit[]; truncated: boolean }> {
  const ignoreCase = shouldIgnoreCase(query)
  const laneLimit = searchLaneLimit(limit)
  const matcher = regex
    ? new RegExp(query, ignoreCase ? 'i' : '')
    : ignoreCase
      ? { test: (line: string) => line.toLowerCase().includes(query.toLowerCase()) }
      : { test: (line: string) => line.includes(query) }
  const re = glob ? globToRegExp(glob) : null
  const contentHits: SearchHit[] = []
  const pathHits: SearchHit[] = []
  const pending: Promise<void>[] = []
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (contentHits.length >= laneLimit && pathHits.length >= laneLimit) {
      truncated = true
      return
    }
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (contentHits.length >= laneLimit && pathHits.length >= laneLimit) {
        truncated = true
        return
      }
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        await walk(full)
      } else if (st.isFile()) {
        if (re && !re.test(name)) continue
        if (st.size > MAX_SEARCH_FILE_BYTES) continue
        if (!regex && pathHits.length < laneLimit) {
          const pathHit = buildPathHit(root, full, query)
          if (pathHit) pathHits.push(pathHit)
        } else if (!regex && pathHits.length >= laneLimit) {
          truncated = true
        }
        const scan = searchFile(full, matcher, contentHits, laneLimit, context, () => truncated = true)
        pending.push(scan)
        if (pending.length >= SEARCH_CONCURRENCY) await pending.shift()
      }
    }
  }

  await walk(root)
  await Promise.all(pending)
  return finalizeSearch(root, query, limit, regex, { hits: contentHits, truncated }, { hits: pathHits, truncated })
}

async function searchWithRipgrep(
  root: string,
  query: string,
  glob: string | undefined,
  context: number,
  limit: number,
  regex: boolean
): Promise<{ root: string; hits: SearchHit[]; truncated: boolean }> {
  const laneLimit = searchLaneLimit(limit)
  const [content, path] = await Promise.all([
    searchContentWithRipgrep(root, query, glob, context, laneLimit, regex),
    regex
      ? Promise.resolve({ hits: [] as SearchHit[], truncated: false })
      : searchPathsWithRipgrep(root, query, glob, laneLimit)
  ])
  return finalizeSearch(root, query, limit, regex, content, path)
}

async function searchContentWithRipgrep(
  root: string,
  query: string,
  glob: string | undefined,
  context: number,
  laneLimit: number,
  regex: boolean
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const args = [
    '--json',
    '--color', 'never',
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--context', String(context),
    '--max-count', String(laneLimit),
    '--max-filesize', String(MAX_SEARCH_FILE_BYTES),
    '--glob', '!node_modules/**',
    '--glob', '!.git/**',
    '--glob', '!.cache/**',
    '--glob', '!dist/**',
    '--glob', '!out/**',
    '--glob', '!.next/**',
    '--glob', '!build/**'
  ]
  if (!regex) args.push('--fixed-strings')
  args.push('--smart-case')
  if (glob) args.push('--glob', glob)
  args.push(query, root)

  let stdout = ''
  try {
    stdout = (await execFileAsync('rg', args, {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    })).stdout
  } catch (err) {
    const maybe = err as { code?: unknown; stdout?: unknown }
    if (maybe.code === 1) {
      stdout = typeof maybe.stdout === 'string' ? maybe.stdout : ''
    } else {
      throw err
    }
  }

  const hits: SearchHit[] = []
  const emittedLines = new Map<string, Map<number, string>>()
  let truncated = false
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'match' && event?.type !== 'context') continue
    const path = String(event.data?.path?.text ?? '')
    const lineNo = Number(event.data?.line_number ?? 0)
    const text = String(event.data?.lines?.text ?? '').replace(/\r?\n$/, '')
    if (!path || !lineNo) continue
    let fileLines = emittedLines.get(path)
    if (!fileLines) {
      fileLines = new Map<number, string>()
      emittedLines.set(path, fileLines)
    }
    fileLines.set(lineNo, text)
    if (event.type !== 'match') continue
    if (hits.length >= laneLimit) {
      truncated = true
      break
    }
    hits.push({
      path,
      kind: 'content',
      line: lineNo,
      text: text.slice(0, 240),
      startLine: Math.max(1, lineNo - context),
      endLine: lineNo + context,
      snippet: '',
      score: 0
    })
  }

  hydrateSearchSnippetsFromRipgrep(hits, emittedLines)
  return { hits, truncated }
}

async function searchPathsWithRipgrep(
  root: string,
  query: string,
  glob: string | undefined,
  laneLimit: number
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const args = [
    '--files',
    root,
    '--glob', '!node_modules/**',
    '--glob', '!.git/**',
    '--glob', '!.cache/**',
    '--glob', '!dist/**',
    '--glob', '!out/**',
    '--glob', '!.next/**',
    '--glob', '!build/**'
  ]
  if (glob) args.push('--glob', glob)

  const stdout = (await execFileAsync('rg', args, {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  })).stdout

  const hits: SearchHit[] = []
  let truncated = false
  for (const line of stdout.split('\n')) {
    const rawPath = line.trim()
    if (!rawPath) continue
    const fullPath = resolve(root, rawPath)
    const hit = buildPathHit(root, fullPath, query)
    if (!hit) continue
    hits.push(hit)
    if (hits.length >= laneLimit) {
      truncated = true
      break
    }
  }
  return { hits, truncated }
}

function hydrateSearchSnippetsFromRipgrep(
  hits: SearchHit[],
  emittedLines: Map<string, Map<number, string>>
): void {
  for (const hit of hits) {
    const fileLines = emittedLines.get(hit.path)
    if (!fileLines) continue
    const snippetLines = Array.from(fileLines.entries())
      .filter(([lineNo]) => lineNo >= hit.startLine && lineNo <= hit.endLine)
      .sort((a, b) => a[0] - b[0])
    if (snippetLines.length === 0) continue
    hit.startLine = snippetLines[0][0]
    hit.endLine = snippetLines[snippetLines.length - 1][0]
    hit.snippet = snippetLines
      .map(([lineNo, text]) => `${lineNo}: ${text}`.slice(0, 320))
      .join('\n')
  }
}

async function readLineRange(
  abs: string,
  startLine?: number,
  endLine?: number,
  defaultWindow = false
): Promise<ReadResult> {
  const s = Math.max(1, startLine ?? 1)
  const e = Math.max(s, endLine ?? Number.MAX_SAFE_INTEGER)
  const lines: string[] = []
  let bytes = 0
  let totalLines = 0
  let truncated = false
  const rl = createInterface({
    input: createReadStream(abs, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    totalLines += 1
    if (totalLines < s || totalLines > e) continue
    const nextBytes = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + nextBytes > MAX_READ_BYTES) {
      truncated = true
      break
    }
    bytes += nextBytes
    lines.push(line)
  }
  return {
    path: abs,
    content: lines.join('\n'),
    truncated,
    totalLines,
    startLine: s,
    endLine: Math.min(e, Math.max(s, totalLines)),
    defaultWindow
  }
}

async function searchFile(
  path: string,
  matcher: { test: (line: string) => boolean },
  hits: SearchHit[],
  limit: number,
  contextLines: number,
  markTruncated: () => void
): Promise<void> {
  try {
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (hits.length >= limit) {
        markTruncated()
        return
      }
      const line = lines[i]
      if (matcher.test(line)) {
        const lineNo = i + 1
        const startLine = Math.max(1, lineNo - contextLines)
        const endLine = Math.min(lines.length, lineNo + contextLines)
        const snippet = lines
          .slice(startLine - 1, endLine)
          .map((snippetLine, idx) => `${startLine + idx}: ${snippetLine}`.slice(0, 320))
          .join('\n')
        hits.push({
          path,
          kind: 'content',
          line: lineNo,
          text: line.slice(0, 240),
          startLine,
          endLine,
          snippet,
          score: 0
        })
      }
    }
  } catch {
    /* unreadable / non-utf8-ish files are skipped like before */
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}

/** Translate a simple file-name glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function shouldIgnoreCase(query: string): boolean {
  return !/[A-Z]/.test(query)
}

function searchLaneLimit(limit: number): number {
  return Math.min(MAX_ENTRIES, Math.max(limit * SEARCH_LANE_MULTIPLIER, MIN_SEARCH_LANE_LIMIT))
}

function finalizeSearch(
  root: string,
  query: string,
  limit: number,
  regex: boolean,
  ...lanes: Array<{ hits: SearchHit[]; truncated: boolean }>
): { root: string; hits: SearchHit[]; truncated: boolean } {
  const matchedPaths = new Set(
    lanes
      .flatMap((lane) => lane.hits)
      .filter((hit) => hit.kind === 'path')
      .map((hit) => hit.path)
  )
  const deduped = new Map<string, SearchHit>()
  for (const hit of lanes.flatMap((lane) => lane.hits)) {
    const score =
      hit.kind === 'path'
        ? scorePathHit(root, hit.path, query)
        : scoreContentHit(root, hit, query, regex, matchedPaths.has(hit.path))
    const next = { ...hit, score }
    const key = `${next.kind}:${next.path}:${next.line}:${next.text}`
    const prior = deduped.get(key)
    if (!prior || next.score > prior.score) deduped.set(key, next)
  }
  const hits = Array.from(deduped.values())
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, limit)
  const truncated = lanes.some((lane) => lane.truncated) || deduped.size > limit
  return { root, hits, truncated }
}

function buildPathHit(root: string, fullPath: string, query: string): SearchHit | null {
  const score = scorePathHit(root, fullPath, query)
  if (score <= 0) return null
  const rel = displaySearchPath(root, fullPath)
  return {
    path: fullPath,
    kind: 'path',
    line: 0,
    text: rel,
    startLine: 1,
    endLine: 1,
    snippet: `path match: ${rel}`,
    score
  }
}

function scoreContentHit(
  root: string,
  hit: SearchHit,
  query: string,
  regex: boolean,
  pathMatched: boolean
): number {
  const text = hit.text
  const ignoreCase = shouldIgnoreCase(query)
  let score = scorePathHit(root, hit.path, query) / 2
  if (regex) {
    score += 140
  } else if (contains(text, query, false)) {
    score += 220
  } else if (contains(text, query, true)) {
    score += 150
  }
  if (pathMatched) score += 80
  score += Math.max(0, 36 - Math.floor(hit.line / 20))
  score += Math.max(0, 24 - Math.floor(text.length / 12))
  if (!regex && !ignoreCase && contains(text, query, false)) score += 20
  return score
}

function scorePathHit(root: string, fullPath: string, query: string): number {
  const ignoreCase = shouldIgnoreCase(query)
  const rel = displaySearchPath(root, fullPath)
  const file = basename(fullPath)
  const stem = file.replace(/\.[^.]+$/, '')
  let score = 0

  score += scoreCandidate(file, query, ignoreCase, 320, 240, 180)
  score += scoreCandidate(stem, query, ignoreCase, 280, 210, 150)
  score += scoreCandidate(rel, query, ignoreCase, 240, 180, 120)

  const tokens = query
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
  for (const token of tokens) {
    if (contains(file, token, ignoreCase)) score += 18
    if (contains(rel, token, ignoreCase)) score += 10
  }

  if (score > 0) score += Math.max(0, 24 - Math.floor(rel.length / 8))
  return score
}

function scoreCandidate(
  candidate: string,
  query: string,
  ignoreCase: boolean,
  exact: number,
  prefix: number,
  containsScore: number
): number {
  if (equals(candidate, query, ignoreCase)) return exact
  if (startsWith(candidate, query, ignoreCase)) return prefix
  if (contains(candidate, query, ignoreCase)) return containsScore
  return 0
}

function displaySearchPath(root: string, fullPath: string): string {
  const rel = relative(root, fullPath).replace(/\\/g, '/')
  return rel || basename(fullPath)
}

function equals(value: string, query: string, ignoreCase: boolean): boolean {
  return normalizeForMatch(value, ignoreCase) === normalizeForMatch(query, ignoreCase)
}

function startsWith(value: string, query: string, ignoreCase: boolean): boolean {
  return normalizeForMatch(value, ignoreCase).startsWith(normalizeForMatch(query, ignoreCase))
}

function contains(value: string, query: string, ignoreCase: boolean): boolean {
  return normalizeForMatch(value, ignoreCase).includes(normalizeForMatch(query, ignoreCase))
}

function normalizeForMatch(value: string, ignoreCase: boolean): string {
  return ignoreCase ? value.toLowerCase() : value
}

/** Cheap line-level diff: count adds/removes and render a capped preview. */
function diffSummary(before: string, after: string): DiffSummary {
  if (before === after) return { added: 0, removed: 0, preview: '(no change)' }
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  const beforeSet = new Map<string, number>()
  for (const l of a) beforeSet.set(l, (beforeSet.get(l) ?? 0) + 1)
  const afterSet = new Map<string, number>()
  for (const l of b) afterSet.set(l, (afterSet.get(l) ?? 0) + 1)

  let added = 0
  let removed = 0
  for (const [l, n] of afterSet) added += Math.max(0, n - (beforeSet.get(l) ?? 0))
  for (const [l, n] of beforeSet) removed += Math.max(0, n - (afterSet.get(l) ?? 0))

  // Preview: show up to a handful of added lines, then a tail marker.
  const addedLines: string[] = []
  for (const l of b) {
    if ((beforeSet.get(l) ?? 0) <= 0) {
      addedLines.push(`+ ${l}`)
      if (addedLines.length >= 12) break
    } else {
      beforeSet.set(l, (beforeSet.get(l) ?? 0) - 1)
    }
  }
  const preview = addedLines.length ? addedLines.join('\n') : `(${added} added, ${removed} removed)`
  return { added, removed, preview }
}
