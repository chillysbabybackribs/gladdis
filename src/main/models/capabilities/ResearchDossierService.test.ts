import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
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
})
