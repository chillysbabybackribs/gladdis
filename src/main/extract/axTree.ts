import type { TabManager } from '../TabManager'

/** Raw CDP accessibility node from Accessibility.getFullAXTree. */
export type CdpAxValue = { type?: string; value?: unknown }

export type CdpAxProperty = { name?: string; value?: CdpAxValue }

export type CdpAxNode = {
  nodeId?: string
  ignored?: boolean
  role?: CdpAxValue
  name?: CdpAxValue
  description?: CdpAxValue
  value?: CdpAxValue
  properties?: CdpAxProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
}

export type AxBounds = {
  x: number
  y: number
  width: number
  height: number
  top: number
  left: number
}

export type AxSnapshotNode = {
  ref: string
  role: string
  name: string
  value?: string
  states: string[]
  backendDOMNodeId?: number
  bounds?: AxBounds
  inViewport: boolean
  score: number
  frameId?: string
  frameLabel?: string
}

export type AxSnapshot = {
  url: string
  title: string
  capturedAt: number
  totalSeen: number
  truncated: boolean
  nodes: AxSnapshotNode[]
}

export type AxDigestOptions = {
  focus?: string
  viewportOnly?: boolean
  interactiveOnly?: boolean
  maxNodes?: number
}

export type AxCaptureOptions = AxDigestOptions & {
  includeBounds?: boolean
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'slider',
  'searchbox',
  'listbox',
  'option',
  'treeitem',
  'gridcell',
  'row',
  'spinbutton',
  'scrollbar',
  'disclosuretriangle',
  'summary'
])

const STRUCTURAL_ROLES = new Set([
  'RootWebArea',
  'WebArea',
  'generic',
  'none',
  'group',
  'presentation',
  'StaticText',
  'LineBreak',
  'InlineTextBox',
  'paragraph'
])

const MAX_NODES_DEFAULT = 60
const MAX_NAME_LEN = 80
const MAX_VALUE_LEN = 60
const MAX_OUTPUT_CHARS = 8_600
const MAX_BOUNDS_FETCHES = 50
const MAX_FRAMES = 8

type FrameTreeNode = {
  frame?: { id?: string; url?: string; name?: string }
  childFrames?: FrameTreeNode[]
}

type TaggedAxNode = {
  node: CdpAxNode
  frameId?: string
  frameLabel?: string
}

type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function axString(field?: CdpAxValue): string {
  const value = field?.value
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function axStates(node: CdpAxNode): string[] {
  const out: string[] = []
  for (const prop of node.properties ?? []) {
    const name = String(prop.name ?? '').toLowerCase()
    const raw = prop.value?.value
    if (raw === true || raw === 'true') {
      if (['disabled', 'focused', 'checked', 'selected', 'expanded', 'pressed', 'readonly', 'required', 'invalid'].includes(name)) {
        out.push(name)
      }
    }
  }
  return out
}

function isInterestingNode(node: CdpAxNode, interactiveOnly: boolean): boolean {
  if (node.ignored) return false
  const role = axString(node.role)
  if (!role) return false
  const name = axString(node.name)
  const value = axString(node.value)
  if (interactiveOnly) {
    return INTERACTIVE_ROLES.has(role.toLowerCase())
  }
  if (INTERACTIVE_ROLES.has(role.toLowerCase())) return true
  if (STRUCTURAL_ROLES.has(role)) return false
  return !!(name || value)
}

function scoreNode(node: Pick<AxSnapshotNode, 'role' | 'name' | 'states' | 'inViewport'>, focus?: string): number {
  let score = 0
  if (node.inViewport) score += 4
  if (!node.states.includes('disabled')) score += 3
  if (node.name) score += 2
  if (INTERACTIVE_ROLES.has(node.role.toLowerCase())) score += 2
  if (focus) {
    const needle = focus.toLowerCase()
    if (node.name.toLowerCase().includes(needle)) score += 5
    if (node.role.toLowerCase().includes(needle)) score += 2
  }
  return score
}

export function boxFromContentQuad(model: number[] | undefined): AxBounds | null {
  if (!Array.isArray(model) || model.length < 8) return null
  const xs = [model[0], model[2], model[4], model[6]]
  const ys = [model[1], model[3], model[5], model[7]]
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return null
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
    x: Math.round(left + width / 2),
    y: Math.round(top + height / 2)
  }
}

export function isBoundsInViewport(bounds: AxBounds, viewport: { width: number; height: number }): boolean {
  if (viewport.width <= 0 || viewport.height <= 0) return true
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  if (right <= 0 || bottom <= 0 || bounds.left >= viewport.width || bounds.top >= viewport.height) {
    return false
  }
  return true
}

export function flattenAxNodes(
  nodes: TaggedAxNode[],
  opts: AxCaptureOptions,
  viewport: { width: number; height: number }
): { entries: AxSnapshotNode[]; totalSeen: number } {
  const interactiveOnly = opts.interactiveOnly !== false
  const candidates: AxSnapshotNode[] = []
  let totalSeen = 0

  for (const tagged of nodes) {
    const node = tagged.node
    if (!isInterestingNode(node, interactiveOnly)) continue
    totalSeen += 1
    const role = axString(node.role)
    const name = axString(node.name)
    const value = axString(node.value)
    const states = axStates(node)
    const entry: AxSnapshotNode = {
      ref: '',
      role,
      name,
      value: value || undefined,
      states,
      backendDOMNodeId: node.backendDOMNodeId,
      inViewport: true,
      score: 0,
      frameId: tagged.frameId,
      frameLabel: tagged.frameLabel
    }
    entry.score = scoreNode(entry, opts.focus)
    candidates.push(entry)
  }

  candidates.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
  return { entries: candidates, totalSeen }
}

async function readViewport(send: CdpSend): Promise<{ width: number; height: number }> {
  try {
    const layout = (await send('Page.getLayoutMetrics', {})) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
    }
    const viewport = layout.cssVisualViewport ?? layout.cssLayoutViewport
    return {
      width: Math.max(0, Math.round(viewport?.clientWidth ?? 0)),
      height: Math.max(0, Math.round(viewport?.clientHeight ?? 0))
    }
  } catch {
    return { width: 0, height: 0 }
  }
}

function frameLabelFromUrl(url: string | undefined, name: string | undefined, isMain: boolean): string | undefined {
  if (isMain) return undefined
  if (name?.trim()) return `iframe:${name.trim()}`
  if (!url) return 'iframe'
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? parsed.hostname : `${parsed.hostname}${parsed.pathname}`
    return `iframe:${path.slice(0, 48)}`
  } catch {
    return `iframe:${url.slice(0, 48)}`
  }
}

function collectFrames(root: FrameTreeNode | undefined, out: Array<{ id: string; url?: string; name?: string; isMain: boolean }>): void {
  if (!root || out.length >= MAX_FRAMES) return
  const walk = (entry: FrameTreeNode, isMain: boolean): void => {
    if (out.length >= MAX_FRAMES) return
    const id = entry.frame?.id
    if (!id) return
    out.push({
      id,
      url: entry.frame?.url,
      name: entry.frame?.name,
      isMain
    })
    for (const child of entry.childFrames ?? []) {
      walk(child, false)
    }
  }
  walk(root, true)
}

async function loadTaggedAxNodes(send: CdpSend): Promise<TaggedAxNode[]> {
  const tree = (await send('Page.getFrameTree', {})) as { frameTree?: FrameTreeNode }
  const frames: Array<{ id: string; url?: string; name?: string; isMain: boolean }> = []
  collectFrames(tree.frameTree, frames)
  if (frames.length === 0) {
    const response = (await send('Accessibility.getFullAXTree', {})) as { nodes?: CdpAxNode[] }
    return (response.nodes ?? []).map((node) => ({ node }))
  }

  const tagged: TaggedAxNode[] = []
  for (const frame of frames) {
    const response = (await send('Accessibility.getFullAXTree', { frameId: frame.id })) as { nodes?: CdpAxNode[] }
    const label = frameLabelFromUrl(frame.url, frame.name, frame.isMain)
    for (const node of response.nodes ?? []) {
      tagged.push({
        node,
        frameId: frame.isMain ? undefined : frame.id,
        frameLabel: label
      })
    }
  }
  return tagged
}

async function attachBounds(
  send: CdpSend,
  entries: AxSnapshotNode[],
  viewport: { width: number; height: number },
  focus?: string
): Promise<void> {
  const targets = entries.filter((node) => typeof node.backendDOMNodeId === 'number')

  let domEnabled = false
  try {
    await send('DOM.enable', {})
    domEnabled = true
    for (const node of targets) {
      try {
        const response = (await send('DOM.getBoxModel', {
          backendNodeId: node.backendDOMNodeId
        })) as { model?: { content?: number[] } }
        const bounds = boxFromContentQuad(response.model?.content)
        if (!bounds) continue
        node.bounds = bounds
        node.inViewport = isBoundsInViewport(bounds, viewport)
        node.score = scoreNode(node, focus)
      } catch {
        /* skip nodes Chromium cannot box-model */
      }
    }
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

export async function captureAxSnapshot(
  send: CdpSend,
  meta: { url: string; title: string },
  opts: AxCaptureOptions = {}
): Promise<AxSnapshot> {
  const includeBounds = opts.includeBounds !== false
  let accessibilityEnabled = false
  try {
    await send('Accessibility.enable', {})
    accessibilityEnabled = true
    const taggedNodes = await loadTaggedAxNodes(send)
    const viewport = await readViewport(send)
    const flattened = flattenAxNodes(taggedNodes, opts, viewport)
    const boundsTargets = flattened.entries.slice(0, MAX_BOUNDS_FETCHES)

    if (includeBounds && boundsTargets.length > 0) {
      await attachBounds(send, boundsTargets, viewport, opts.focus)
    }

    let ranked = includeBounds ? [...flattened.entries] : flattened.entries
    ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    if (opts.viewportOnly) {
      ranked = ranked.filter((node) => node.inViewport)
    }
    const maxNodes = Math.min(Math.max(opts.maxNodes ?? MAX_NODES_DEFAULT, 1), 120)
    const truncated = ranked.length > maxNodes
    const selected = ranked.slice(0, maxNodes)
    selected.forEach((node, index) => {
      node.ref = `@a${index + 1}`
    })

    return {
      url: meta.url,
      title: meta.title,
      capturedAt: Date.now(),
      totalSeen: flattened.totalSeen,
      truncated,
      nodes: selected
    }
  } finally {
    if (accessibilityEnabled) {
      try {
        await send('Accessibility.disable', {})
      } catch {
        /* best effort */
      }
    }
  }
}

export async function captureAxSnapshotForTab(
  tabs: TabManager,
  tabId: string,
  opts: AxCaptureOptions = {}
): Promise<AxSnapshot> {
  const tab = tabs.list().find((entry) => entry.id === tabId)
  const url = tabs.getTabUrl(tabId)
  const title = tab?.title ?? url
  return captureAxSnapshot((method, params) => tabs.cdpSend(tabId, method, params), { url, title }, opts)
}

function trunc(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value
}

export function digestAxSnapshot(snapshot: AxSnapshot, opts: AxDigestOptions = {}): string {
  const lines: string[] = []
  lines.push(`URL: ${snapshot.url}`)
  lines.push(`TITLE: ${snapshot.title}`)
  lines.push(`SOURCE: CDP Accessibility.getFullAXTree (+ child frames, capped)`)
  lines.push(
    `NODES: ${snapshot.nodes.length} shown` +
      (snapshot.truncated ? ` (${snapshot.totalSeen} matched, truncated)` : ` (${snapshot.totalSeen} matched)`)
  )
  if (opts.focus) lines.push(`FOCUS: ${opts.focus}`)
  if (opts.viewportOnly) lines.push('FILTER: viewportOnly=true')
  if (opts.interactiveOnly === false) lines.push('FILTER: interactiveOnly=false')

  if (snapshot.nodes.length === 0) {
    lines.push('')
    lines.push('── A11Y TREE ──')
    lines.push('(no matching accessibility nodes)')
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`── A11Y TREE (${snapshot.nodes.length} nodes, ranked) ──`)
  lines.push('ref | role         | name / label                                    | x    y   | states')
  lines.push('────┼──────────────┼─────────────────────────────────────────────────┼──────────┼────────')

  for (const node of snapshot.nodes) {
    const name = trunc(node.name || node.value || '', MAX_NAME_LEN).padEnd(MAX_NAME_LEN, ' ')
    const role = node.role.padEnd(12, ' ')
    const coords =
      node.bounds != null
        ? `${String(node.bounds.x).padStart(4)} ${String(node.bounds.y).padStart(4)}`
        : '   ?    ?'
    const vp = node.inViewport ? '' : '↑'
    const states = [node.states.join(','), node.frameLabel].filter(Boolean).join(' | ')
    lines.push(` ${node.ref.padEnd(3)} | ${role} | ${name} | ${coords}${vp} | ${states}`)
  }

  let output = lines.join('\n')
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + '\n…'
  }
  return output
}
