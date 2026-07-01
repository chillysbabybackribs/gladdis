import { describe, expect, it } from 'vitest'
import { buildPageWireframe, formatPageWireframe, formatOverlayBanner } from './pageWireframe'
import type { PageCapture, ActionNode, OverlayInfo } from '../../../shared/extraction'

function action(idx: number, role: string, name: string, value?: string): ActionNode {
  return {
    idx, role, name, tag: role === 'link' ? 'a' : role,
    ...(value ? { value } : {}),
    selector: `sel-${idx}`, rect: { x: 0, y: idx * 10, w: 100, h: 10 }, inViewport: true
  }
}

function hnCapture(): PageCapture {
  // The real HN shape: stories first (title link + metadata), footer nav last.
  const actions: ActionNode[] = [
    action(1, 'link', 'Claude Sonnet 5', 'https://anthropic.com'),
    action(2, 'link', '482 comments', 'item?id=48736605'),
    action(3, 'link', 'Claude Code is steganographically marking requests', 'https://thereallo.dev'),
    action(4, 'link', '392 comments', 'item?id=2'),
    action(5, 'link', 'Google copybara: moving code between repositories', 'https://github.com/google'),
    action(6, 'link', '3 comments', 'item?id=3'),
    action(7, 'link', 'Guidelines', 'newsguidelines.html'),
    action(8, 'link', 'FAQ', 'newsfaq.html'),
    action(9, 'link', 'Lists', 'lists'),
    action(10, 'link', 'API', 'https://github.com/HackerNews/API'),
    action(11, 'link', 'Security', 'security.html'),
    action(12, 'link', 'Legal', 'legal')
  ]
  return {
    url: 'https://news.ycombinator.com/',
    title: 'Hacker News',
    capturedAt: 0,
    tookMs: 1,
    content: { title: 'Hacker News', byline: null, text: '', markdown: '', headings: [], wordCount: 0 },
    data: { meta: {}, openGraph: {}, jsonLd: [], canonical: null, feeds: [], lang: null },
    actions,
    dom: { nodeCount: 100, htmlBytes: 5000, frameCount: 1 }
  }
}

describe('pageWireframe (DOM source)', () => {
  it('lists interactive elements in document order with real names — top story is first', () => {
    const wire = buildPageWireframe(hnCapture())
    const first = wire.lines[0]
    // The #1 story is FIRST — not a footer link, not an empty row.
    expect(first).toMatchObject({ kind: 'action', name: 'Claude Sonnet 5' })
    // Its comments link is right after it, in order.
    expect(wire.lines[1]).toMatchObject({ kind: 'action', name: '482 comments' })
    // The footer nav is LAST, in order — never floated to the top.
    const names = wire.lines.filter((l) => l.kind === 'action').map((l: any) => l.name)
    expect(names.indexOf('Claude Sonnet 5')).toBeLessThan(names.indexOf('Guidelines'))
    expect(names).toContain('Legal')
  })

  it('preserves the href on link actions so the model can navigate directly', () => {
    const wire = buildPageWireframe(hnCapture())
    const top = wire.lines[0]
    expect(top).toMatchObject({ kind: 'action', href: 'https://anthropic.com' })
  })

  it('collapses a repetitive same-role run in place without breaking order', () => {
    const actions: ActionNode[] = [
      action(1, 'link', 'Top Story'),
      ...Array.from({ length: 8 }, (_, k) => action(k + 2, 'link', `${k + 1} hours ago`)),
      action(10, 'link', 'Footer')
    ]
    const cap = { ...hnCapture(), actions }
    const wire = buildPageWireframe(cap)
    expect(wire.lines[0]).toMatchObject({ kind: 'action', name: 'Top Story' })
    expect(wire.lines[1]).toMatchObject({ kind: 'group', count: 8, idxStart: 2, idxEnd: 9 })
    expect(wire.lines[2]).toMatchObject({ kind: 'action', name: 'Footer' })
  })

  it('renders a readable document-order text block', () => {
    const text = formatPageWireframe(buildPageWireframe(hnCapture()))
    expect(text).toContain('document order')
    expect(text).toContain('#1 link: Claude Sonnet 5 → https://anthropic.com')
    expect(text).toContain('482 comments')
    // Footer appears, and after the top story.
    expect(text.indexOf('Claude Sonnet 5')).toBeLessThan(text.indexOf('Guidelines'))
  })
})

describe('pageWireframe overlay banner', () => {
  function cookieOverlay(): OverlayInfo {
    return {
      kind: 'cookie-consent',
      name: 'We value your privacy',
      coversViewportPct: 0.85,
      actions: [action(1, 'button', 'Accept all'), action(2, 'button', 'Reject all')]
    }
  }

  it('surfaces the overlay banner BEFORE the DOM-order wireframe', () => {
    const cap = { ...hnCapture(), overlay: cookieOverlay() }
    const text = formatPageWireframe(buildPageWireframe(cap))
    // The banner is present, names the overlay, and appears before page content.
    expect(text).toContain('ACTIVE OVERLAY')
    expect(text).toContain('We value your privacy')
    expect(text).toContain('85%')
    expect(text.indexOf('ACTIVE OVERLAY')).toBeLessThan(text.indexOf('Claude Sonnet 5'))
  })

  it('tells the model the underlying page is correct and lists overlay controls', () => {
    const banner = formatOverlayBanner(cookieOverlay())
    expect(banner).toContain('underlying page loaded correctly')
    expect(banner).toContain('Accept all')
    expect(banner).toContain('Reject all')
  })

  it('omits the banner entirely when no overlay is present', () => {
    const text = formatPageWireframe(buildPageWireframe(hnCapture()))
    expect(text).not.toContain('ACTIVE OVERLAY')
  })

  it('handles an overlay with no detected controls gracefully', () => {
    const banner = formatOverlayBanner({ kind: 'dialog', name: 'Sign in', coversViewportPct: 0.5, actions: [] })
    expect(banner).toContain('modal dialog')
    expect(banner).toContain('no distinct controls detected')
  })
})
