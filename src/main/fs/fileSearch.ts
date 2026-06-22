import { execFile } from 'child_process'
import { basename, relative, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const MAX_SEARCH_RESULTS = 1000
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
export const DEFAULT_SEARCH_CONTEXT_LINES = 2
export const MAX_SEARCH_CONTEXT_LINES = 8
const SEARCH_LANE_MULTIPLIER = 3
const MIN_SEARCH_LANE_LIMIT = 50

const RG_IGNORE_GLOBS = [
  '!node_modules/**',
  '!.git/**',
  '!.cache/**',
  '!dist/**',
  '!out/**',
  '!.next/**',
  '!build/**'
]

export interface SearchHit {
  path: string
  kind: 'content' | 'path'
  line: number
  text: string
  startLine: number
  endLine: number
  snippet: string
  score: number
}

export interface SearchResult {
  root: string
  hits: SearchHit[]
  truncated: boolean
}

/**
 * Run rg twice in parallel — once for content matches, once (for fixed-string
 * queries) for file-name/path matches — then merge and rank through a shared
 * scoring pass. rg already parallelizes across files internally, so no worker
 * pool is needed; the two lanes just overlap their process time.
 */
export async function searchWithRipgrep(
  root: string,
  query: string,
  glob: string | undefined,
  context: number,
  limit: number,
  regex: boolean
): Promise<SearchResult> {
  const laneLimit = searchLaneLimit(limit)
  const [content, paths] = await Promise.all([
    searchContentWithRipgrep(root, query, glob, context, laneLimit, regex),
    regex
      ? Promise.resolve({ hits: [] as SearchHit[], truncated: false })
      : searchPathsWithRipgrep(root, query, glob, laneLimit)
  ])
  return finalizeSearch(root, query, limit, regex, content, paths)
}

async function searchContentWithRipgrep(
  root: string,
  query: string,
  glob: string | undefined,
  context: number,
  laneLimit: number,
  regex: boolean
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const args: string[] = [
    '--json',
    '--color', 'never',
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--context', String(context),
    '--max-count', String(laneLimit),
    '--max-filesize', String(MAX_SEARCH_FILE_BYTES)
  ]
  for (const ignore of RG_IGNORE_GLOBS) args.push('--glob', ignore)
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
    // rg exits 1 when there are no matches; that's not an error for us.
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
  const args: string[] = ['--files', root]
  for (const ignore of RG_IGNORE_GLOBS) args.push('--glob', ignore)
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

/**
 * rg emits both `match` and `context` events; we use `context` lines to
 * materialise a snippet block around each `match` so the model gets visual
 * context without a second file read.
 */
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

function shouldIgnoreCase(query: string): boolean {
  return !/[A-Z]/.test(query)
}

function searchLaneLimit(limit: number): number {
  return Math.min(MAX_SEARCH_RESULTS, Math.max(limit * SEARCH_LANE_MULTIPLIER, MIN_SEARCH_LANE_LIMIT))
}

/**
 * Score and merge hits from both lanes. Path-matched files boost their
 * content matches (they're more likely the target the user meant), and
 * matches near the top of a file slightly outrank deep ones because most
 * intent in a source file lives in its first 200 lines.
 */
function finalizeSearch(
  root: string,
  query: string,
  limit: number,
  regex: boolean,
  ...lanes: Array<{ hits: SearchHit[]; truncated: boolean }>
): SearchResult {
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

  // Token-level partial credit: for multi-word queries each ≥2-char token
  // contributes a small boost so "config tsconfig" still ranks tsconfig.json
  // even though the file name doesn't contain the literal pair.
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
