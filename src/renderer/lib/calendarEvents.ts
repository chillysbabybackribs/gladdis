export interface CalendarEvent {
  id: string
  date: string
  title: string
  time?: string
  note?: string
}

const STORAGE_KEY = 'gladdis.calendar.events.v1'

export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function loadCalendarEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is CalendarEvent =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as CalendarEvent).id === 'string' &&
        typeof (item as CalendarEvent).date === 'string' &&
        typeof (item as CalendarEvent).title === 'string'
    )
  } catch {
    return []
  }
}

export function saveCalendarEvents(events: CalendarEvent[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
}

export function eventsForDate(events: CalendarEvent[], date: Date): CalendarEvent[] {
  const key = dateKey(date)
  return events
    .filter((event) => event.date === key)
    .sort((a, b) => {
      if (a.time && b.time) return a.time.localeCompare(b.time)
      if (a.time) return -1
      if (b.time) return 1
      return a.title.localeCompare(b.title)
    })
}

export function datesWithEvents(events: CalendarEvent[]): Set<string> {
  return new Set(events.map((event) => event.date))
}

export function createEventId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
