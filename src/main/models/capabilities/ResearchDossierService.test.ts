import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { RepoIndexService } from './RepoIndexService'
import { RepoIntelligenceService } from './RepoIntelligenceService'
import { ResearchDossierService } from './ResearchDossierService'

describe('ResearchDossierService', () => {
  it('gathers repo evidence and returns Gemini dossier text', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-research-dossier-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'README.md'), '# Demo Workspace\nThis repo contains chat services.')
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'dossier-demo', scripts: { test: 'vitest' } })
    )
    await fs.writeFile(
      path.join(workspace, 'src', 'chat.ts'),
      ['export function buildChatService() {', '  return true', '}'].join('\n')
    )

    const generateContent = vi.fn(async () => ({
      text: '## Dossier\n`src/chat.ts` is relevant to the requested chat-service investigation.'
    }))
    const service = new ResearchDossierService(
      () =>
        ({
          models: { generateContent }
        }) as any
    )

    const result = await service.researchDossier({
      workspaceRoot: workspace,
      query: 'ChatService'
    })

    expect(result.summary).toContain('## Dossier')
    expect(result.structuredPayload.query).toBe('ChatService')
    expect(result.structuredPayload.searchedFiles).toContain('src/chat.ts')
    console.log('ResearchDossier context', result.structuredPayload.context)
    expect(result.structuredPayload.context).toEqual(expect.objectContaining({
      promptChars: expect.any(Number),
      estimatedPromptTokens: expect.any(Number),
      readSpanChars: expect.any(Number),
      estimatedReadSpanTokens: expect.any(Number),
      suggestedSpanCount: result.structuredPayload.suggestedSpans.length,
      estimatedTokensSavedBySpans: expect.any(Number)
    }))
    expect(generateContent).toHaveBeenCalled()

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('reuses cached dossier evidence for repeated identical requests', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-research-dossier-cache-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'README.md'), '# Demo Workspace\nThis repo contains chat services.')
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'dossier-demo' }))
    await fs.writeFile(path.join(workspace, 'src', 'chat.ts'), 'export const chat = true\n')

    const generateContent = vi.fn(async () => ({ text: '## Cached Dossier' }))
    const searchRepo = vi.fn(async () => ({
      summary: 'Search query: chat\nHits:\nsrc/chat.ts:1 - export const chat = true',
      structuredPayload: {
        workspaceRoot: workspace,
        query: 'chat',
        totalHits: 1,
        hits: [{ path: 'src/chat.ts', kind: 'content', line: 1, text: 'export const chat = true' }],
        suggestedSpans: [{ path: 'src/chat.ts', startLine: 1, endLine: 10 }]
      }
    }))
    const readSpans = vi.fn(async () => ({
      summary: '=== src/chat.ts (lines 1-1 of 1) ===\nexport const chat = true',
      structuredPayload: {
        workspaceRoot: workspace,
        items: [
          {
            path: 'src/chat.ts',
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            truncated: false,
            defaultWindow: false,
            content: 'export const chat = true'
          }
        ]
      }
    }))
    const service = new ResearchDossierService(
      () =>
        ({
          models: { generateContent }
        }) as any,
      { searchRepo, readSpans } as any
    )

    const input = { workspaceRoot: workspace, query: 'chat' }
    const first = await service.researchDossier(input)
    const second = await service.researchDossier(input)

    expect(first.summary).toBe('## Cached Dossier')
    expect(second.summary).toBe('## Cached Dossier')
    expect(generateContent).toHaveBeenCalledTimes(1)
    expect(searchRepo).toHaveBeenCalledTimes(1)
    expect(readSpans).toHaveBeenCalledTimes(1)

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('quietly expands dossier reads with indexed import neighbors', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-research-dossier-graph-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'dossier-graph-demo' }))
    await fs.writeFile(
      path.join(workspace, 'src', 'service.ts'),
      [
        "import { helperValue } from './helper'",
        'export class IndexedDossierService {',
        '  run() {',
        '    return helperValue',
        '  }',
        '}'
      ].join('\n')
    )
    await fs.writeFile(path.join(workspace, 'src', 'helper.ts'), 'export const helperValue = true\n')

    const generateContent = vi.fn(async () => ({ text: '## Graph Dossier' }))
    const index = new RepoIndexService()
    await index.refresh(workspace)
    const service = new ResearchDossierService(
      () =>
        ({
          models: { generateContent }
        }) as any,
      new RepoIntelligenceService(index)
    )

    const result = await service.researchDossier({
      workspaceRoot: workspace,
      query: 'IndexedDossierService'
    })
    expect(generateContent).toHaveBeenCalled()
    const [[request]] = generateContent.mock.calls as unknown as Array<[{
      contents: Array<{ parts: Array<{ text: string }> }>
    }]>
    const prompt = JSON.stringify(request)

    expect(result.structuredPayload.suggestedSpans.map((span) => span.path)).toContain('src/helper.ts')
    expect(result.structuredPayload.context.selectedFileBytes).toBeGreaterThan(0)
    expect(result.structuredPayload.context.estimatedFullFileTokens).toBeGreaterThan(0)
    expect(prompt).toContain('=== src/helper.ts')
    expect(prompt).toContain('helperValue')

    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('passes the dossier query into hidden related-span ranking', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gladdis-research-dossier-related-query-'))
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'dossier-related-query-demo' }))

    const generateContent = vi.fn(async () => ({ text: '## Ranked Dossier' }))
    const searchRepo = vi.fn(async () => ({
      summary: 'Search query: target\nHits:\nsrc/service.ts:1 - class TargetService',
      structuredPayload: {
        workspaceRoot: workspace,
        query: 'target',
        totalHits: 1,
        hits: [{ path: 'src/service.ts', kind: 'symbol', line: 1, text: 'class TargetService' }],
        suggestedSpans: [{ path: 'src/service.ts', startLine: 1, endLine: 10 }]
      }
    }))
    const relatedSpans = vi.fn(async () => [{ path: 'src/helper.ts', startLine: 1, endLine: 20 }])
    const readSpans = vi.fn(async () => ({
      summary: [
        '=== src/service.ts (lines 1-1 of 1) ===',
        'export class TargetService {}',
        '=== src/helper.ts (lines 1-1 of 1) ===',
        'export const targetHelper = true'
      ].join('\n'),
      structuredPayload: {
        workspaceRoot: workspace,
        items: []
      }
    }))
    const service = new ResearchDossierService(
      () =>
        ({
          models: { generateContent }
        }) as any,
      { searchRepo, relatedSpans, readSpans } as any
    )

    await service.researchDossier({
      workspaceRoot: workspace,
      query: 'targetHelper'
    })

    expect(relatedSpans).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: workspace,
      paths: ['src/service.ts'],
      query: 'targetHelper',
      maxResults: 3
    }))

    await fs.rm(workspace, { recursive: true, force: true })
  })
})
