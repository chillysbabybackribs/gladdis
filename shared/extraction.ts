/** A single actionable element on the page: the agent's action surface. */
export interface ActionNode {
  /** Stable 1-based index, also drawn as the overlay label. */
  idx: number
  /** Best-effort role: link, button, textbox, checkbox, select, etc. */
  role: string
  /** Visible/accessible name (trimmed, capped). */
  name: string
  /** Tag name, lowercased. */
  tag: string
  /** href for links, value/placeholder for inputs, etc. */
  value?: string
  /** A deterministic CSS selector that resolves back to this node. */
  selector: string
  /** Viewport-relative bounding box in CSS px. */
  rect: { x: number; y: number; w: number; h: number }
  /** Whether the element is in the viewport right now. */
  inViewport: boolean
  /** True if disabled / aria-disabled. */
  disabled?: boolean
}

/** Cleaned, reader-grade main content. */
export interface ReadableContent {
  title: string
  byline: string | null
  /** Plain-text main content (boilerplate stripped). */
  text: string
  /** Lightweight markdown of the main content. */
  markdown: string
  /** Outline of headings. */
  headings: Array<{ level: number; text: string }>
  wordCount: number
}

/** Everything machine-readable the page advertises about itself. */
export interface StructuredData {
  meta: Record<string, string>
  openGraph: Record<string, string>
  jsonLd: unknown[]
  canonical: string | null
  feeds: Array<{ title: string; href: string; type: string }>
  lang: string | null
}

/** The full deterministic capture of a page at one instant. */
export interface PageCapture {
  url: string
  title: string
  capturedAt: number
  /** Wall-clock ms the extraction took (perf signal). */
  tookMs: number
  content: ReadableContent
  data: StructuredData
  /** Interactive action surface, ordered by DOM position. */
  actions: ActionNode[]
  /** Counts + raw size signals for the deep DOM. */
  dom: {
    nodeCount: number
    htmlBytes: number
    frameCount: number
  }
}
