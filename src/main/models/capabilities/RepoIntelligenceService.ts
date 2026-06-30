import * as fs from 'fs/promises'
import * as path from 'path'
import { FileTools } from '../../fs/FileTools'
import { RepoIndexService } from './RepoIndexService'

export interface RepoOverviewInput {
  workspaceRoot: string
  focus?: string
}

export interface RepoOverviewResult {
  summary: string
  structuredPayload: {
    workspaceRoot: string
    packageManager: string | null
    packageName: string | null
    scripts: string[]
    keyFiles: string[]
    topDirectories: string[]
    entryPoints: string[]
    focus?: string
  }
}

export interface RepoContextAccounting {
  chars: number
  estimatedTokens: number
}

export interface SearchRepoInput {
  workspaceRoot: string
  query: string
  path?: string
  glob?: string
  maxResults?: number
}

export interface RepoGrepTaskInput {
  workspaceRoot: string
  task: string
  path?: string
  glob?: string
  maxVariations?: number
  maxResults?: number
}

export interface SearchRepoResult {
  summary: string
  structuredPayload: {
    workspaceRoot: string
    query: string
    path?: string
    glob?: string
    totalHits: number
    hits: Array<{
      path: string
      kind: string
      line: number
      text: string
    }>
    suggestedSpans: Array<{
      path: string
      startLine: number
      endLine: number
    }>
    context: RepoContextAccounting & {
      hitCount: number
      suggestedSpanCount: number
    }
  }
}

export interface RepoGrepTaskResult {
  summary: string
  structuredPayload: {
    workspaceRoot: string
    task: string
    path?: string
    glob?: string
    variations: string[]
    hits: Array<{
      variation: string
      path: string
      kind: string
      line: number
      text: string
    }>
    spans: Array<{
      path: string
      startLine: number
      endLine: number
      totalLines: number
      truncated: boolean
      content: string
      matchedVariations: string[]
    }>
    context: RepoContextAccounting & {
      variationCount: number
      hitCount: number
      spanCount: number
    }
  }
}

export interface ReadSpanInput {
  path: string
  startLine?: number
  endLine?: number
}

export interface ReadSpansInput {
  workspaceRoot: string
  items: ReadSpanInput[]
}

export interface ReadSpansResult {
  summary: string
  structuredPayload: {
    workspaceRoot: string
    items: Array<{
      path: string
      startLine: number
      endLine: number
      totalLines: number
      truncated: boolean
      defaultWindow: boolean
      content: string
    }>
    context: RepoContextAccounting & {
      itemCount: number
      includedLines: number
    }
  }
}

export interface RelatedSpanInput {
  workspaceRoot: string
  paths: string[]
  query?: string
  maxResults?: number
}

const KEY_FILE_CANDIDATES = [
  'package.json',
  'tsconfig.json',
  'electron.vite.config.ts',
  'vite.config.ts',
  'README.md',
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/renderer/main.tsx',
  'src/renderer/App.tsx'
]

const ENTRYPOINT_CANDIDATES = [
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/renderer/main.tsx',
  'src/renderer/App.tsx'
]

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache'
])

export class RepoIntelligenceService {
  private readonly files = new FileTools()

  constructor(private readonly index = new RepoIndexService()) {}

  async repoOverview(input: RepoOverviewInput): Promise<RepoOverviewResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    this.touchIndex(workspaceRoot)
    const packageJson = await this.readPackageJson(workspaceRoot)
    const topDirectories = await this.readTopDirectories(workspaceRoot)
    const keyFiles = await this.findExisting(workspaceRoot, KEY_FILE_CANDIDATES)
    const entryPoints = await this.findExisting(workspaceRoot, ENTRYPOINT_CANDIDATES)
    const scripts = packageJson ? Object.keys(packageJson.scripts ?? {}).sort() : []
    const packageManager = await this.detectPackageManager(workspaceRoot)
    const packageName =
      packageJson && typeof packageJson.name === 'string' && packageJson.name.trim()
        ? packageJson.name.trim()
        : null

    const summaryLines = [
      `Workspace: ${workspaceRoot}`,
      packageName ? `Package: ${packageName}` : null,
      packageManager ? `Package manager: ${packageManager}` : null,
      scripts.length ? `Scripts: ${scripts.slice(0, 8).join(', ')}` : 'Scripts: none detected',
      topDirectories.length
        ? `Top directories: ${topDirectories.slice(0, 8).join(', ')}`
        : 'Top directories: none detected',
      entryPoints.length
        ? `Entrypoints: ${entryPoints.join(', ')}`
        : 'Entrypoints: none detected',
      keyFiles.length ? `Key files: ${keyFiles.join(', ')}` : 'Key files: none detected',
      input.focus ? `Focus: ${input.focus}` : null
    ].filter((line): line is string => Boolean(line))

    return {
      summary: summaryLines.join('\n'),
      structuredPayload: {
        workspaceRoot,
        packageManager,
        packageName,
        scripts,
        keyFiles,
        topDirectories,
        entryPoints,
        ...(input.focus ? { focus: input.focus } : {})
      }
    }
  }

  async searchRepo(input: SearchRepoInput): Promise<SearchRepoResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    this.touchIndex(workspaceRoot)
    this.files.setRoot(workspaceRoot)
    const searchPath = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
    const maxResults = Math.min(20, Math.max(1, input.maxResults ?? 8))
    const indexedHits = await this.index.search({
      workspaceRoot,
      query: input.query,
      path: input.path,
      glob: input.glob,
      maxResults
    })
    if (indexedHits.length > 0) {
      const hits = indexedHits.map((hit) => ({
        path: hit.path,
        kind: hit.kind,
        line: hit.line,
        text: hit.text
      }))
      const suggestedSpans = hits
        .filter((hit) => hit.line > 0)
        .slice(0, 3)
        .map((hit) => ({
          path: hit.path,
          startLine: Math.max(1, hit.line - 8),
          endLine: hit.line + 16
        }))
      const preview = hits
        .slice(0, 8)
        .map((hit) => `${hit.path}:${hit.line}${hit.text ? ` - ${hit.text}` : ''}`)
        .join('\n')
      const nextReads =
        suggestedSpans.length > 0
          ? `\nSuggested next read_spans call:\n${JSON.stringify({ items: suggestedSpans })}`
          : ''
      const summary = `Search query: ${input.query}\nPath: ${searchPath}\nIndex hits:\n${preview}${nextReads}`

      return {
        summary,
        structuredPayload: {
          workspaceRoot,
          query: input.query,
          ...(searchPath !== '.' ? { path: searchPath } : {}),
          ...(input.glob ? { glob: input.glob } : {}),
          totalHits: hits.length,
          hits,
          suggestedSpans,
          context: {
            chars: summary.length,
            estimatedTokens: estimateContextTokens(summary.length),
            hitCount: hits.length,
            suggestedSpanCount: suggestedSpans.length
          }
        }
      }
    }
    const result = await this.files.search(
      input.query,
      searchPath,
      input.glob,
      1,
      maxResults
    )
    const hits = result.hits.map((hit) => ({
      path: path.relative(workspaceRoot, hit.path) || path.basename(hit.path),
      kind: hit.kind,
      line: hit.line,
      text: hit.text
    }))
    const suggestedSpans = hits
      .filter((hit) => hit.line > 0)
      .slice(0, 3)
      .map((hit) => ({
        path: hit.path,
        startLine: Math.max(1, hit.line - 8),
        endLine: hit.line + 16
      }))
    const preview = hits
      .slice(0, 8)
      .map((hit) => `${hit.path}:${hit.line}${hit.text ? ` - ${hit.text}` : ''}`)
      .join('\n')
    const nextReads =
      suggestedSpans.length > 0
        ? `\nSuggested next read_spans call:\n${JSON.stringify({ items: suggestedSpans })}`
        : ''
    const summary =
      hits.length > 0
        ? `Search query: ${input.query}\nPath: ${searchPath}\nHits:\n${preview}${nextReads}`
        : `Search query: ${input.query}\nPath: ${searchPath}\nHits: none`

    return {
      summary,
      structuredPayload: {
        workspaceRoot,
        query: input.query,
        ...(searchPath !== '.' ? { path: searchPath } : {}),
        ...(input.glob ? { glob: input.glob } : {}),
        totalHits: hits.length,
        hits,
        suggestedSpans,
        context: {
          chars: summary.length,
          estimatedTokens: estimateContextTokens(summary.length),
          hitCount: hits.length,
          suggestedSpanCount: suggestedSpans.length
        }
      }
    }
  }

  async repoGrepTask(input: RepoGrepTaskInput): Promise<RepoGrepTaskResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    this.touchIndex(workspaceRoot)
    this.files.setRoot(workspaceRoot)
    const searchPath = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
    const maxVariations = Math.min(10, Math.max(1, input.maxVariations ?? 6))
    const maxResults = Math.min(10, Math.max(1, input.maxResults ?? 5))
    const variations = buildRepoGrepVariations(input.task, maxVariations)

    const searches = await Promise.all(
      variations.map(async (variation) => {
        const result = await this.searchRepo({
          workspaceRoot,
          query: variation,
          path: input.path,
          glob: input.glob,
          maxResults: Math.max(maxResults, 6)
        })
        return { variation, hits: result.structuredPayload.hits }
      })
    )

    const rankedHits = rankRepoGrepHits(searches, maxResults * 3)
    const spanMap = new Map<string, {
      path: string
      startLine: number
      endLine: number
      matchedVariations: Set<string>
    }>()
    for (const hit of rankedHits) {
      const startLine = hit.line > 0 ? Math.max(1, hit.line - 8) : 1
      const endLine = hit.line > 0 ? hit.line + 16 : 80
      const key = `${hit.path}:${startLine}:${endLine}`
      const prior = spanMap.get(key)
      if (prior) {
        prior.matchedVariations.add(hit.variation)
      } else {
        spanMap.set(key, {
          path: hit.path,
          startLine,
          endLine,
          matchedVariations: new Set([hit.variation])
        })
      }
    }

    const spanInputs = Array.from(spanMap.values()).slice(0, maxResults)
    const read = spanInputs.length > 0
      ? await this.readSpans({ workspaceRoot, items: spanInputs })
      : null
    const spans = read
      ? read.structuredPayload.items.map((item, index) => ({
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        totalLines: item.totalLines,
        truncated: item.truncated,
        content: item.content,
        matchedVariations: Array.from(spanInputs[index]?.matchedVariations ?? [])
      }))
      : []

    const hitLines = rankedHits
      .slice(0, maxResults * 2)
      .map((hit) => `${hit.path}:${hit.line} [${hit.variation}]${hit.text ? ` - ${hit.text}` : ''}`)
    const spanBlocks = spans.map((span) => {
      const meta =
        `=== ${span.path} (lines ${span.startLine}-${span.endLine} of ${span.totalLines}; ` +
        `matched: ${span.matchedVariations.join(', ')}) ===`
      return `${meta}\n${span.content}`
    })
    const summary = [
      `Repo grep task: ${input.task}`,
      `Path: ${searchPath}`,
      input.glob ? `Glob: ${input.glob}` : null,
      `Variations: ${variations.join(' | ')}`,
      hitLines.length ? `Hits:\n${hitLines.join('\n')}` : 'Hits: none',
      spanBlocks.length ? `Sections:\n${spanBlocks.join('\n\n')}` : null
    ].filter((line): line is string => Boolean(line)).join('\n')

    return {
      summary,
      structuredPayload: {
        workspaceRoot,
        task: input.task,
        ...(searchPath !== '.' ? { path: searchPath } : {}),
        ...(input.glob ? { glob: input.glob } : {}),
        variations,
        hits: rankedHits.map((hit) => ({
          variation: hit.variation,
          path: hit.path,
          kind: hit.kind,
          line: hit.line,
          text: hit.text
        })),
        spans,
        context: {
          chars: summary.length,
          estimatedTokens: estimateContextTokens(summary.length),
          variationCount: variations.length,
          hitCount: rankedHits.length,
          spanCount: spans.length
        }
      }
    }
  }

  async readSpans(input: ReadSpansInput): Promise<ReadSpansResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    this.files.setRoot(workspaceRoot)
    const items = input.items.slice(0, 6)
    const resolved = await Promise.all(
      items.map(async (item) => {
        const read = await this.files.read(
          item.path,
          item.startLine,
          item.endLine,
          false
        )
        return {
          path: path.relative(workspaceRoot, read.path) || path.basename(read.path),
          startLine: read.startLine,
          endLine: read.endLine,
          totalLines: read.totalLines,
          truncated: read.truncated,
          defaultWindow: read.defaultWindow,
          content: read.content
        }
      })
    )

    const summary = resolved
      .map((item) => {
        const meta = `=== ${item.path} (lines ${item.startLine}-${item.endLine} of ${item.totalLines}) ===`
        return `${meta}\n${item.content}`
      })
      .join('\n\n')

    return {
      summary,
      structuredPayload: {
        workspaceRoot,
        items: resolved,
        context: {
          chars: resolved.reduce((total, item) => total + item.content.length, 0),
          estimatedTokens: estimateContextTokens(resolved.reduce((total, item) => total + item.content.length, 0)),
          itemCount: resolved.length,
          includedLines: resolved.reduce((total, item) => total + Math.max(0, item.endLine - item.startLine + 1), 0)
        }
      }
    }
  }

  async relatedSpans(input: RelatedSpanInput): Promise<ReadSpanInput[]> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    this.touchIndex(workspaceRoot)
    const related = await this.index.relatedFiles({
      workspaceRoot,
      paths: input.paths,
      query: input.query,
      maxResults: input.maxResults
    })
    return related.map((file) => ({
      path: file.path,
      startLine: file.startLine ?? 1,
      endLine: file.endLine ?? 80
    }))
  }

  private touchIndex(workspaceRoot: string): void {
    this.index.watchWorkspace(workspaceRoot)
    this.index.queueRefresh(workspaceRoot)
  }

  private async readPackageJson(
    workspaceRoot: string
  ): Promise<{ name?: unknown; scripts?: Record<string, unknown> } | null> {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8')
      return JSON.parse(raw) as { name?: unknown; scripts?: Record<string, unknown> }
    } catch {
      return null
    }
  }

  private async detectPackageManager(workspaceRoot: string): Promise<string | null> {
    const candidates: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm']
    ]
    for (const [filename, label] of candidates) {
      try {
        await fs.access(path.join(workspaceRoot, filename))
        return label
      } catch {
        // try next
      }
    }
    return null
  }

  private async readTopDirectories(workspaceRoot: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() && !IGNORE_DIRS.has(entry.name))
        .map((entry) => entry.name)
        .sort()
        .slice(0, 12)
    } catch {
      return []
    }
  }

  private async findExisting(workspaceRoot: string, relPaths: string[]): Promise<string[]> {
    const results: string[] = []
    for (const relPath of relPaths) {
      try {
        await fs.access(path.join(workspaceRoot, relPath))
        results.push(relPath)
      } catch {
        // skip missing file
      }
    }
    return results
  }
}

function buildRepoGrepVariations(task: string, maxVariations: number): string[] {
  const normalized = task.replace(/\s+/g, ' ').trim()
  const candidates: string[] = []
  const add = (value: string): void => {
    const next = value.replace(/\s+/g, ' ').trim()
    if (!next) return
    if (next.length < 3) return
    if (!candidates.some((existing) => existing.toLowerCase() === next.toLowerCase())) {
      candidates.push(next)
    }
  }

  for (const quoted of normalized.matchAll(/["'`](.+?)["'`]/g)) add(quoted[1])
  for (const identifier of normalized.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g)) {
    const value = identifier[0]
    if (STOP_WORDS.has(value.toLowerCase())) continue
    if (/[A-Z_$]|\./.test(value) || value.includes('_') || value.length >= 5) add(value)
  }
  add(normalized)

  const words = normalized
    .toLowerCase()
    .replace(/[^a-z0-9_$.\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
  for (let size = Math.min(4, words.length); size >= 2; size -= 1) {
    for (let index = 0; index <= words.length - size; index += 1) {
      add(words.slice(index, index + size).join(' '))
      if (candidates.length >= maxVariations) return candidates.slice(0, maxVariations)
    }
  }
  for (const word of words) {
    add(word)
    if (candidates.length >= maxVariations) break
  }
  return candidates.slice(0, maxVariations)
}

function rankRepoGrepHits(
  searches: Array<{
    variation: string
    hits: Array<{ path: string; kind: string; line: number; text: string }>
  }>,
  limit: number
): Array<{ variation: string; path: string; kind: string; line: number; text: string; score: number }> {
  const deduped = new Map<string, { variation: string; path: string; kind: string; line: number; text: string; score: number }>()
  searches.forEach((search, variationIndex) => {
    search.hits.forEach((hit, hitIndex) => {
      const key = `${hit.path}:${hit.line}:${hit.kind}:${hit.text}`
      const score =
        (searches.length - variationIndex) * 100 +
        Math.max(0, 50 - hitIndex) +
        (hit.kind === 'symbol' ? 45 : hit.kind === 'path' ? 25 : 0) +
        (hit.line > 0 ? Math.max(0, 20 - Math.floor(hit.line / 50)) : 0)
      const next = { ...hit, variation: search.variation, score }
      const prior = deduped.get(key)
      if (!prior || next.score > prior.score) deduped.set(key, next)
    })
  })
  return Array.from(deduped.values())
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, limit)
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'all',
  'and',
  'are',
  'but',
  'can',
  'code',
  'create',
  'file',
  'find',
  'for',
  'from',
  'how',
  'into',
  'let',
  'make',
  'need',
  'not',
  'our',
  'repo',
  'repository',
  'search',
  'task',
  'that',
  'the',
  'this',
  'tool',
  'use',
  'what',
  'when',
  'where',
  'with'
])

export function estimateContextTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}
