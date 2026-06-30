import * as fs from 'fs/promises'
import * as path from 'path'
import type { GoogleGenAI } from '@google/genai'
import { snapshotDirectoryTree } from '../../fs/repoSnapshot'
import {
  estimateContextTokens,
  RepoIntelligenceService,
  type ReadSpansResult,
  type SearchRepoResult
} from './RepoIntelligenceService'

export interface ResearchDossierInput {
  workspaceRoot: string
  query: string
  glob?: string
  maxResults?: number
}

export interface ResearchDossierResult {
  summary: string
  structuredPayload: {
    workspaceRoot: string
    query: string
    searchedFiles: string[]
    suggestedSpans: Array<{
      path: string
      startLine: number
      endLine: number
    }>
    context: {
      promptChars: number
      estimatedPromptTokens: number
      searchSummaryChars: number
      readSpanChars: number
      estimatedReadSpanTokens: number
      suggestedSpanCount: number
      selectedFileBytes: number
      estimatedFullFileTokens: number
      estimatedTokensSavedBySpans: number
    }
  }
}

type AiLike = Pick<GoogleGenAI, 'models'>

interface TimedCacheEntry<T> {
  value: T
  expiresAt: number
}

interface WorkspaceContext {
  readme: string
  packageJson: string
  tree: string[]
}

export class ResearchDossierService {
  private readonly workspaceContextCache = new Map<string, TimedCacheEntry<WorkspaceContext>>()
  private readonly searchCache = new Map<string, TimedCacheEntry<SearchRepoResult>>()
  private readonly spansCache = new Map<string, TimedCacheEntry<ReadSpansResult>>()
  private readonly dossierCache = new Map<string, TimedCacheEntry<ResearchDossierResult>>()
  private readonly inFlightDossiers = new Map<string, Promise<ResearchDossierResult>>()
  private static readonly CACHE_TTL_MS = 120_000
  private static readonly CACHE_LIMIT = 24

  constructor(
    private readonly getAi: () => AiLike,
    private readonly repoIntelligence = new RepoIntelligenceService()
  ) {}

  async researchDossier(input: ResearchDossierInput): Promise<ResearchDossierResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const dossierKey = this.dossierCacheKey({ ...input, workspaceRoot })
    const cachedDossier = this.getCache(this.dossierCache, dossierKey)
    if (cachedDossier) return cachedDossier

    const pending = this.inFlightDossiers.get(dossierKey)
    if (pending) return pending

    const work = this.buildResearchDossier({ ...input, workspaceRoot }, dossierKey)
    this.inFlightDossiers.set(dossierKey, work)
    try {
      return await work
    } finally {
      this.inFlightDossiers.delete(dossierKey)
    }
  }

  private async buildResearchDossier(input: ResearchDossierInput, dossierKey: string): Promise<ResearchDossierResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const { readme, packageJson, tree } = await this.getWorkspaceContext(workspaceRoot)
    const search = await this.searchRepoCached({
      workspaceRoot,
      query: input.query,
      glob: input.glob,
      maxResults: input.maxResults ?? 8
    })
    const relatedSpans = await this.relatedSpansCached({
      workspaceRoot,
      paths: search.structuredPayload.suggestedSpans.map((span) => span.path),
      query: input.query,
      maxResults: 3
    })
    const suggestedSpans = mergeSpanSuggestions([
      ...search.structuredPayload.suggestedSpans.slice(0, 3),
      ...relatedSpans
    ], 5)
    const spans =
      suggestedSpans.length > 0
        ? await this.readSpansCached({ workspaceRoot, items: suggestedSpans })
        : null
    const selectedFileBytes = await this.sumSelectedFileBytes(workspaceRoot, suggestedSpans.map((span) => span.path))

    const prompt = [
      `Workspace Root: ${workspaceRoot}`,
      `Research Goal: ${input.query}`,
      input.glob ? `Search Glob: ${input.glob}` : null,
      packageJson ? `\n=== package.json ===\n${packageJson}` : null,
      readme ? `\n=== README.md ===\n${readme}` : null,
      `\n=== Project Tree Snapshot ===\n${tree.join('\n')}`,
      `\n=== Search Results ===\n${search.summary}`,
      spans ? `\n=== Read Spans ===\n${spans.summary}` : '\n=== Read Spans ===\nNone'
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n')
    const readSpanChars = spans?.structuredPayload.context?.chars ?? spans?.summary.length ?? 0
    const estimatedReadSpanTokens = estimateContextTokens(readSpanChars)
    const estimatedFullFileTokens = estimateContextTokens(selectedFileBytes)

    const response = await this.getAi().models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction:
          'You are a compact repository reconnaissance agent. Synthesize a concise Markdown dossier grounded only in the supplied workspace evidence. Focus on the user goal, identify the most relevant files/modules, explain why they matter, and suggest the next concrete reads or edits. Do not invent files or behavior not supported by the evidence.',
        temperature: 0.1
      }
    })

    const result = {
      summary: response.text?.trim() || 'Unable to generate research dossier.',
      structuredPayload: {
        workspaceRoot,
        query: input.query,
        searchedFiles: search.structuredPayload.hits.map((hit) => hit.path),
        suggestedSpans,
        context: {
          promptChars: prompt.length,
          estimatedPromptTokens: estimateContextTokens(prompt.length),
          searchSummaryChars: search.summary.length,
          readSpanChars,
          estimatedReadSpanTokens,
          suggestedSpanCount: suggestedSpans.length,
          selectedFileBytes,
          estimatedFullFileTokens,
          estimatedTokensSavedBySpans: Math.max(0, estimatedFullFileTokens - estimatedReadSpanTokens)
        }
      }
    }
    this.setCache(this.dossierCache, dossierKey, result)
    return result
  }

  private async getWorkspaceContext(workspaceRoot: string): Promise<WorkspaceContext> {
    const cacheKey = workspaceRoot
    const cached = this.getCache(this.workspaceContextCache, cacheKey)
    if (cached) return cached

    const [readme, packageJson, tree] = await Promise.all([
      this.readOptional(path.join(workspaceRoot, 'README.md'), 4000),
      this.readOptional(path.join(workspaceRoot, 'package.json'), 4000),
      snapshotDirectoryTree(workspaceRoot, workspaceRoot, {
        maxDepth: 4,
        maxEntriesPerDirectory: 40,
        maxEntries: 120
      })
    ])
    const context = { readme, packageJson, tree }
    this.setCache(this.workspaceContextCache, cacheKey, context)
    return context
  }

  private async searchRepoCached(input: Parameters<RepoIntelligenceService['searchRepo']>[0]): Promise<SearchRepoResult> {
    const cacheKey = JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      query: input.query,
      glob: input.glob ?? null,
      maxResults: input.maxResults ?? null
    })
    const cached = this.getCache(this.searchCache, cacheKey)
    if (cached) return cached

    const result = await this.repoIntelligence.searchRepo(input)
    this.setCache(this.searchCache, cacheKey, result)
    return result
  }

  private async readSpansCached(input: Parameters<RepoIntelligenceService['readSpans']>[0]): Promise<ReadSpansResult> {
    const items = input.items
      .map((item) => ({ path: item.path, startLine: item.startLine ?? null, endLine: item.endLine ?? null }))
      .sort((a, b) => {
        if (a.path === b.path) {
          return (a.startLine ?? 0) - (b.startLine ?? 0) || (a.endLine ?? 0) - (b.endLine ?? 0)
        }
        return a.path.localeCompare(b.path)
      })
    const cacheKey = JSON.stringify({ workspaceRoot: input.workspaceRoot, items })
    const cached = this.getCache(this.spansCache, cacheKey)
    if (cached) return cached

    const result = await this.repoIntelligence.readSpans(input)
    this.setCache(this.spansCache, cacheKey, result)
    return result
  }

  private async relatedSpansCached(input: { workspaceRoot: string; paths: string[]; query?: string; maxResults: number }): Promise<Array<{ path: string; startLine: number; endLine: number }>> {
    const service = this.repoIntelligence as RepoIntelligenceService & {
      relatedSpans?: (args: { workspaceRoot: string; paths: string[]; query?: string; maxResults?: number }) => Promise<Array<{ path: string; startLine?: number; endLine?: number }>>
    }
    if (typeof service.relatedSpans !== 'function' || input.paths.length === 0) return []

    const spans = await service.relatedSpans({
      workspaceRoot: input.workspaceRoot,
      paths: input.paths,
      query: input.query,
      maxResults: input.maxResults
    })
    return spans.map((span) => ({
      path: span.path,
      startLine: span.startLine ?? 1,
      endLine: span.endLine ?? 80
    }))
  }

  private async sumSelectedFileBytes(workspaceRoot: string, relPaths: string[]): Promise<number> {
    const uniquePaths = [...new Set(relPaths)]
    const sizes = await Promise.all(
      uniquePaths.map(async (relPath) => {
        try {
          const stat = await fs.stat(path.join(workspaceRoot, relPath))
          return stat.isFile() ? stat.size : 0
        } catch {
          return 0
        }
      })
    )
    return sizes.reduce((total, size) => total + size, 0)
  }

  private async readOptional(filePath: string, maxChars: number): Promise<string> {
    try {
      const text = await fs.readFile(filePath, 'utf8')
      return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [truncated]` : text
    } catch {
      return ''
    }
  }

  private dossierCacheKey(input: ResearchDossierInput): string {
    return JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      query: input.query,
      glob: input.glob ?? null,
      maxResults: input.maxResults ?? null
    })
  }

  private getCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) {
      cache.delete(key)
      return null
    }
    return entry.value
  }

  private setCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T): void {
    if (cache.has(key)) cache.delete(key)
    if (cache.size >= ResearchDossierService.CACHE_LIMIT) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
    cache.set(key, { value, expiresAt: Date.now() + ResearchDossierService.CACHE_TTL_MS })
  }
}

function mergeSpanSuggestions(
  spans: Array<{ path: string; startLine: number; endLine: number }>,
  limit: number
): Array<{ path: string; startLine: number; endLine: number }> {
  const merged = new Map<string, { path: string; startLine: number; endLine: number }>()
  for (const span of spans) {
    const existing = merged.get(span.path)
    if (existing) {
      existing.startLine = Math.min(existing.startLine, span.startLine)
      existing.endLine = Math.max(existing.endLine, span.endLine)
    } else {
      merged.set(span.path, { ...span })
    }
  }
  return [...merged.values()].slice(0, limit)
}
