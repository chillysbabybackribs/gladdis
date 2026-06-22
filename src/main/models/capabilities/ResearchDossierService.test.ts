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
      query: 'how is chat service structured?'
    })

    expect(result.summary).toContain('## Dossier')
    expect(result.structuredPayload.query).toBe('how is chat service structured?')
    expect(result.structuredPayload.searchedFiles).toContain('src/chat.ts')
    expect(generateContent).toHaveBeenCalled()

    await fs.rm(workspace, { recursive: true, force: true })
  })
})
