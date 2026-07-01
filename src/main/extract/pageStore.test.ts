import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { savePageCapture, slugForUrl, clearConversationPages } from './pageStore'
import type { PageCapture } from '../../../shared/extraction'

function cap(url: string, title = 'Hacker News'): PageCapture {
  return {
    url, title, capturedAt: 1, tookMs: 1,
    content: { title, byline: null, text: 'Main body text here.', markdown: '# H\nbody', headings: [{ level: 1, text: 'H' }], wordCount: 3 },
    data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
    actions: [{ idx: 1, role: 'link', name: 'Claude Sonnet 5', tag: 'a', value: 'https://anthropic.com', selector: 's1', rect: { x: 0, y: 0, w: 10, h: 10 }, inViewport: true }],
    dom: { nodeCount: 1, htmlBytes: 1, frameCount: 1 }
  }
}

describe('pageStore', () => {
  it('writes cleaned markdown + actions JSON and returns their paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gladdis-pages-'))
    const saved = await savePageCapture(cap('https://news.ycombinator.com/'), 'conv-1', { baseDir: base })

    const md = await readFile(saved.markdownPath, 'utf8')
    expect(md).toContain('# Hacker News')
    expect(md).toContain('<https://news.ycombinator.com/>')
    expect(md).toContain('body')

    const actions = JSON.parse(await readFile(saved.actionsPath, 'utf8'))
    expect(actions.url).toBe('https://news.ycombinator.com/')
    expect(actions.actions[0]).toMatchObject({ name: 'Claude Sonnet 5', role: 'link', value: 'https://anthropic.com' })

    // Scoped under the conversation dir.
    expect(saved.markdownPath).toContain(join(base, 'conv-1'))
  })

  it('makes filesystem-safe, collision-resistant slugs', () => {
    const a = slugForUrl('https://news.ycombinator.com/item?id=1')
    const b = slugForUrl('https://news.ycombinator.com/item?id=2')
    expect(a).not.toBe(b) // query difference must not collide
    expect(a).toMatch(/^[a-zA-Z0-9._-]+$/)
  })

  it('prunes oldest captures beyond the per-conversation file cap', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gladdis-pages-prune-'))
    const cfg = { baseDir: base, maxFilesPerConversation: 4 } // 4 files = 2 pages (md+json each)
    await savePageCapture(cap('https://a.com/1'), 'conv-2', cfg)
    await new Promise((r) => setTimeout(r, 5))
    await savePageCapture(cap('https://a.com/2'), 'conv-2', cfg)
    await new Promise((r) => setTimeout(r, 5))
    await savePageCapture(cap('https://a.com/3'), 'conv-2', cfg)

    const files = await readdir(join(base, 'conv-2'))
    expect(files.length).toBeLessThanOrEqual(4)
    // The newest page survives; the oldest is evicted.
    expect(files.some((f) => f.includes('a.com-3') || f.includes('3'))).toBe(true)
  })

  it('clears a conversation dir', async () => {
    const base = await mkdtemp(join(tmpdir(), 'gladdis-pages-clear-'))
    await savePageCapture(cap('https://a.com/x'), 'conv-3', { baseDir: base })
    await clearConversationPages('conv-3', { baseDir: base })
    await expect(readdir(join(base, 'conv-3'))).rejects.toBeTruthy()
  })
})
