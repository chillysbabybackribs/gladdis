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

/**
 * A blocking overlay currently on top of the page: a modal dialog, cookie
 * consent wall, paywall, or newsletter interstitial. This is the ONE thing whose
 * visual/interaction stacking (z-index / top layer) deliberately contradicts its
 * DOM position — a modal is appended at the end of <body> yet covers the top of
 * the screen. Every other capture field is in DOM order; this field exists so the
 * model is told "a layer is in front, the page underneath is still correct."
 */
export interface OverlayInfo {
  /** How the overlay was identified. */
  kind: 'dialog' | 'aria-modal' | 'cookie-consent' | 'fixed-cover'
  /** Best-effort accessible name / heading of the overlay. */
  name: string
  /** Fraction of the viewport (0–1) the overlay's box covers. */
  coversViewportPct: number
  /** The overlay's own interactive controls (Accept / Reject / ✕ …), DOM order. */
  actions: ActionNode[]
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
  /**
   * The topmost blocking overlay (modal / cookie wall / paywall), if one is
   * currently covering the page. Absent when nothing is on top.
   */
  overlay?: OverlayInfo
  /** Counts + raw size signals for the deep DOM. */
  dom: {
    nodeCount: number
    htmlBytes: number
    frameCount: number
  }
}
