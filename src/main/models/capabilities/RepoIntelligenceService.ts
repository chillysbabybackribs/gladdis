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

export interface SearchRepoInput {
  workspaceRoot: string
  query: string
  path?: string
  glob?: string
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
    this.index.warm(workspaceRoot)
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

      return {
        summary: `Search query: ${input.query}\nPath: ${searchPath}\nIndex hits:\n${preview}${nextReads}`,
        structuredPayload: {
          workspaceRoot,
          query: input.query,
          ...(searchPath !== '.' ? { path: searchPath } : {}),
          ...(input.glob ? { glob: input.glob } : {}),
          totalHits: hits.length,
          hits,
          suggestedSpans
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

    return {
      summary:
        hits.length > 0
          ? `Search query: ${input.query}\nPath: ${searchPath}\nHits:\n${preview}${nextReads}`
          : `Search query: ${input.query}\nPath: ${searchPath}\nHits: none`,
      structuredPayload: {
        workspaceRoot,
        query: input.query,
        ...(searchPath !== '.' ? { path: searchPath } : {}),
        ...(input.glob ? { glob: input.glob } : {}),
        totalHits: hits.length,
        hits,
        suggestedSpans
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
        items: resolved
      }
    }
  }

  async relatedSpans(input: RelatedSpanInput): Promise<ReadSpanInput[]> {
    const related = await this.index.relatedFiles({
      workspaceRoot: input.workspaceRoot,
      paths: input.paths,
      query: input.query,
      maxResults: input.maxResults
    })
    return related.map((file) => ({
      path: file.path,
      startLine: 1,
      endLine: 80
    }))
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
