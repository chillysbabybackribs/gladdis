import type { AxBounds, AxSnapshotNode } from './axTree'

const AX_REF_RE = /^@?a(\d+)$/i

/** Normalize `@a1` / `a1` style refs from read_a11y snapshots. */
export function parseAxRefQuery(query: string): string | null {
  const trimmed = query.trim()
  const match = trimmed.match(AX_REF_RE)
  if (!match) return null
  return `@a${match[1]}`
}

export function isAxRefQuery(query: string, type?: string): boolean {
  if (type === 'ref') return !!parseAxRefQuery(query)
  if (type && type !== 'text') return false
  return !!parseAxRefQuery(query)
}

export function resolveAxRef(nodes: AxSnapshotNode[], query: string): AxSnapshotNode | null {
  const ref = parseAxRefQuery(query)
  if (!ref) return null
  return nodes.find((node) => node.ref.toLowerCase() === ref.toLowerCase()) ?? null
}

export function axRefTargetError(query: string, reason: string): string {
  return `No accessibility ref "${query}" is available (${reason}). Call read_a11y on this tab first, then grep_click/grep_type/click_xy with type "ref", click_xy ref, or the @aN ref directly.`
}

export type AxRefStore = {
  pageUrl: string
  capturedAt: number
  nodes: AxSnapshotNode[]
}

export function axRefStillValid(store: AxRefStore | null | undefined, pageUrl: string, maxAgeMs: number): boolean {
  if (!store) return false
  if (normalizePageUrl(store.pageUrl) !== normalizePageUrl(pageUrl)) return false
  return Date.now() - store.capturedAt <= maxAgeMs
}

export function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

export function axNodeClickable(node: AxSnapshotNode): boolean {
  if (node.states.includes('disabled')) return false
  return !!node.bounds
}

export function axNodeCenter(node: AxSnapshotNode): { x: number; y: number } | null {
  if (!node.bounds) return null
  return { x: node.bounds.x, y: node.bounds.y }
}

export function describeAxRefMatch(node: AxSnapshotNode): string {
  const label = node.name || node.value || '(unnamed)'
  let desc = `Matched accessibility ref ${node.ref}: ${node.role} "${label}"`
  if (node.frameLabel) desc += ` [${node.frameLabel}]`
  return desc
}

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export async function refreshAxNodeBounds(
  send: CdpSend,
  node: AxSnapshotNode,
  viewport: { width: number; height: number }
): Promise<AxBounds | null> {
  if (typeof node.backendDOMNodeId !== 'number') return null

  let domEnabled = false
  try {
    await send('DOM.enable', {})
    domEnabled = true
    const response = (await send('DOM.getBoxModel', {
      backendNodeId: node.backendDOMNodeId
    })) as { model?: { content?: number[] } }
    const content = response.model?.content
    if (!Array.isArray(content) || content.length < 8) return null
    const xs = [content[0], content[2], content[4], content[6]]
    const ys = [content[1], content[3], content[5], content[7]]
    const left = Math.min(...xs)
    const right = Math.max(...xs)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0) return null
    const bounds = {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      x: Math.round(left + width / 2),
      y: Math.round(top + height / 2)
    }
    node.bounds = bounds
    node.inViewport =
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      !(right <= 0 || bottom <= 0 || left >= viewport.width || top >= viewport.height)
    return bounds
  } finally {
    if (domEnabled) {
      try {
        await send('DOM.disable', {})
      } catch {
        /* best effort */
      }
    }
  }
}
