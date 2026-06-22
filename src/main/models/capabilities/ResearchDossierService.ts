import * as fs from 'fs/promises'
import * as path from 'path'
import type { GoogleGenAI } from '@google/genai'
import { RepoIntelligenceService } from './RepoIntelligenceService'

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
  }
}

type AiLike = Pick<GoogleGenAI, 'models'>

export class ResearchDossierService {
  constructor(
    private readonly getAi: () => AiLike,
    private readonly repoIntelligence = new RepoIntelligenceService()
  ) {}

  async researchDossier(input: ResearchDossierInput): Promise<ResearchDossierResult> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const [readme, packageJson, tree] = await Promise.all([
      this.readOptional(path.join(workspaceRoot, 'README.md'), 4000),
      this.readOptional(path.join(workspaceRoot, 'package.json'), 4000),
      this.scanDirectory(workspaceRoot)
    ])
    const search = await this.repoIntelligence.searchRepo({
      workspaceRoot,
      query: input.query,
      glob: input.glob,
      maxResults: input.maxResults ?? 8
    })
    const suggestedSpans = search.structuredPayload.suggestedSpans.slice(0, 3)
    const spans =
      suggestedSpans.length > 0
        ? await this.repoIntelligence.readSpans({ workspaceRoot, items: suggestedSpans })
        : null

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

    const response = await this.getAi().models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction:
          'You are a compact repository reconnaissance agent. Synthesize a concise Markdown dossier grounded only in the supplied workspace evidence. Focus on the user goal, identify the most relevant files/modules, explain why they matter, and suggest the next concrete reads or edits. Do not invent files or behavior not supported by the evidence.',
        temperature: 0.1
      }
    })

    return {
      summary: response.text?.trim() || 'Unable to generate research dossier.',
      structuredPayload: {
        workspaceRoot,
        query: input.query,
        searchedFiles: search.structuredPayload.hits.map((hit) => hit.path),
        suggestedSpans
      }
    }
  }

  private async readOptional(filePath: string, maxChars: number): Promise<string> {
    try {
      const text = await fs.readFile(filePath, 'utf8')
      return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [truncated]` : text
    } catch {
      return ''
    }
  }

  private async scanDirectory(root: string, depth = 0, maxDepth = 4): Promise<string[]> {
    if (depth > maxDepth) return []
    const ignored = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      'out',
      '.next',
      '.cache',
      'coverage'
    ])
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const lines: string[] = []
      for (const entry of entries.slice(0, 40)) {
        if (ignored.has(entry.name)) continue
        const fullPath = path.join(root, entry.name)
        const rel = path.relative(root, fullPath)
        if (entry.isDirectory()) {
          lines.push(`${rel}/`)
          const nested = await this.scanDirectory(fullPath, depth + 1, maxDepth)
          lines.push(...nested.map((item) => `${entry.name}/${item}`))
        } else {
          lines.push(rel)
        }
        if (lines.length >= 120) break
      }
      return lines.slice(0, 120)
    } catch {
      return []
    }
  }
}
