export interface TabInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  /** ms the current load has been running, or null when the tab is idle. */
  loadingMs: number | null
  /** True when the current load has run past the slow-load threshold. */
  slowLoad: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface TabsUpdatedState {
  tabs: TabInfo[]
  activeTabId: string | null
}

/** Pixel rect (in renderer CSS px) where the active browser view should sit. */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A raw CDP command, the escape hatch that exposes the whole protocol. */
export interface CdpCommand {
  tabId: string
  method: string
  params?: Record<string, unknown>
}

/** Payload pushed to renderer for every CDP event (for models / logging). */
export interface CdpEventPayload {
  tabId: string
  method: string
  params: unknown
  sessionId?: string
}

/** Result of running JS in a tab's page context via the exec bridge. */
export type ExecResult =
  | { success: true; result: unknown }
  | { success: false; error: string }
