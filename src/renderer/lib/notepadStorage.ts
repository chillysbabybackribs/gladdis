import type { PartialBlock } from '@blocknote/core'

// v1 stored a single document under this key. We migrate the body of that key
// into the first tab of v2 on the first read, then leave the legacy key in
// place as a one-time fallback. (Don't delete it — if someone rolls back, the
// old build can still find their note.)
const LEGACY_BLOCKS_KEY = 'gladdis:notepad:blocks'
const STATE_KEY = 'gladdis:notepad:state:v2'

export interface NotepadTab {
  id: string
  title: string
  blocks: PartialBlock[]
  /** Epoch ms — used for sort fallbacks; not surfaced in UI yet. */
  createdAt: number
  updatedAt: number
}

export interface NotepadState {
  tabs: NotepadTab[]
  activeId: string
}

function makeId(): string {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function emptyTab(title = 'Note 1'): NotepadTab {
  const now = Date.now()
  return { id: makeId(), title, blocks: [], createdAt: now, updatedAt: now }
}

/** Read the legacy v1 single-document blob, if any. */
function readLegacyBlocks(): PartialBlock[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_BLOCKS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed as PartialBlock[]
  } catch {
    return null
  }
}

function isValidTab(t: unknown): t is NotepadTab {
  if (!t || typeof t !== 'object') return false
  const r = t as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    Array.isArray(r.blocks) &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number'
  )
}

function defaultState(): NotepadState {
  const legacy = readLegacyBlocks()
  const first = emptyTab('Note 1')
  if (legacy && legacy.length > 0) first.blocks = legacy
  return { tabs: [first], activeId: first.id }
}

export function loadNotepadState(): NotepadState {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return defaultState()
    const r = parsed as Record<string, unknown>
    const tabs = Array.isArray(r.tabs) ? (r.tabs.filter(isValidTab) as NotepadTab[]) : []
    if (tabs.length === 0) return defaultState()
    const activeId =
      typeof r.activeId === 'string' && tabs.some((t) => t.id === r.activeId)
        ? r.activeId
        : tabs[0].id
    return { tabs, activeId }
  } catch {
    return defaultState()
  }
}

export function saveNotepadState(state: NotepadState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch (e) {
    console.warn('Failed to persist notepad state:', e)
  }
}
