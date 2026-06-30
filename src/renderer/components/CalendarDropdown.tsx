import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createEventId,
  dateKey,
  datesWithEvents,
  eventsForDate,
  isSameDay,
  loadCalendarEvents,
  saveCalendarEvents,
  type CalendarEvent
} from '../lib/calendarEvents'

interface MonthCell {
  date: Date
  inMonth: boolean
}

function getWeekStartDay(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay?: number }
    }
    return locale.weekInfo?.firstDay ?? 7
  } catch {
    return 7
  }
}

function jsDayToCldr(day: number): number {
  return day === 0 ? 7 : day
}

function buildMonthGrid(viewMonth: Date, weekStart: number): MonthCell[] {
  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const first = new Date(year, month, 1)
  const offset = (jsDayToCldr(first.getDay()) - weekStart + 7) % 7
  const start = new Date(year, month, 1 - offset)

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return { date, inMonth: date.getMonth() === month }
  })
}

function weekdayLabels(weekStart: number): string[] {
  const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  const labels = Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(2024, 0, 7 + index))
  )
  const startJs = weekStart === 7 ? 0 : weekStart
  return Array.from({ length: 7 }, (_, index) => labels[(startJs + index) % 7])
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1)
}

function shiftDate(date: Date, deltaDays: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + deltaDays)
  return next
}

export function CalendarDropdown() {
  const [now, setNow] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEvent[]>(() => loadCalendarEvents())
  const [draftTitle, setDraftTitle] = useState('')
  const [draftTime, setDraftTime] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const weekStart = useMemo(() => getWeekStartDay(), [])
  const weekdays = useMemo(() => weekdayLabels(weekStart), [weekStart])
  const monthGrid = useMemo(() => buildMonthGrid(viewMonth, weekStart), [viewMonth, weekStart])
  const eventDates = useMemo(() => datesWithEvents(events), [events])
  const selectedEvents = useMemo(
    () => eventsForDate(events, selectedDate),
    [events, selectedDate]
  )

  const clockLabel = now.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })

  const headerDate = selectedDate.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  const monthLabel = viewMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })

  const close = useCallback(() => setOpen(false), [])

  const persistEvents = useCallback((next: CalendarEvent[]) => {
    setEvents(next)
    saveCalendarEvents(next)
  }, [])

  const addEvent = useCallback(() => {
    const title = draftTitle.trim()
    if (!title) return
    const time = draftTime.trim()
    const next: CalendarEvent = {
      id: createEventId(),
      date: dateKey(selectedDate),
      title,
      ...(time ? { time } : {})
    }
    persistEvents([...events, next])
    setDraftTitle('')
    setDraftTime('')
    titleInputRef.current?.focus()
  }, [draftTitle, draftTime, events, persistEvents, selectedDate])

  const removeEvent = useCallback(
    (id: string) => {
      persistEvents(events.filter((event) => event.id !== id))
    },
    [events, persistEvents]
  )

  const jumpToToday = useCallback(() => {
    const today = new Date()
    setNow(today)
    setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1))
    setSelectedDate(today)
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSelectedDate((current) => shiftDate(current, -1))
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setSelectedDate((current) => shiftDate(current, 1))
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedDate((current) => shiftDate(current, -7))
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedDate((current) => shiftDate(current, 7))
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  useEffect(() => {
    if (!open) return
    setViewMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1))
  }, [open, selectedDate])

  useEffect(() => {
    if (open) titleInputRef.current?.focus()
  }, [open, selectedDate])

  return (
    <div
      ref={rootRef}
      className={`calendar-dropdown${open ? ' open' : ''}`}
    >
      <button
        type="button"
        className="calendar-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${headerDate}, ${clockLabel}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="calendar-trigger-time">{clockLabel}</span>
      </button>

      {open && (
        <div className="calendar-panel" role="dialog" aria-label="Calendar">
          <div className="calendar-panel-header">
            <div className="calendar-panel-date">{headerDate}</div>
            <div className="calendar-panel-toolbar">
              <button
                type="button"
                className="calendar-icon-btn"
                title="Previous month"
                aria-label="Previous month"
                onClick={() => setViewMonth((current) => addMonths(current, -1))}
              >
                ‹
              </button>
              <span className="calendar-month-label">{monthLabel}</span>
              <button
                type="button"
                className="calendar-icon-btn"
                title="Next month"
                aria-label="Next month"
                onClick={() => setViewMonth((current) => addMonths(current, 1))}
              >
                ›
              </button>
              <button
                type="button"
                className="calendar-today-btn"
                onClick={jumpToToday}
              >
                Today
              </button>
            </div>
          </div>

          <div className="calendar-grid-wrap">
            <div className="calendar-weekdays" aria-hidden>
              {weekdays.map((label) => (
                <span key={label} className="calendar-weekday">
                  {label}
                </span>
              ))}
            </div>
            <div className="calendar-grid" role="grid" aria-label={monthLabel}>
              {monthGrid.map(({ date, inMonth }) => {
                const key = dateKey(date)
                const isToday = isSameDay(date, now)
                const isSelected = isSameDay(date, selectedDate)
                const hasEvents = eventDates.has(key)
                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    className={[
                      'calendar-day',
                      !inMonth ? 'outside' : '',
                      isToday ? 'today' : '',
                      isSelected ? 'selected' : '',
                      hasEvents ? 'has-events' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-label={date.toLocaleDateString(undefined, {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                    aria-selected={isSelected}
                    onClick={() => setSelectedDate(date)}
                  >
                    <span className="calendar-day-num">{date.getDate()}</span>
                    {hasEvents && <span className="calendar-day-dot" aria-hidden />}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="calendar-agenda">
            <div className="calendar-agenda-head">
              <span className="calendar-agenda-title">
                {isSameDay(selectedDate, now)
                  ? 'Today'
                  : selectedDate.toLocaleDateString(undefined, {
                      weekday: 'long',
                      month: 'short',
                      day: 'numeric'
                    })}
              </span>
              <span className="calendar-agenda-count">
                {selectedEvents.length === 0
                  ? 'No events'
                  : `${selectedEvents.length} event${selectedEvents.length === 1 ? '' : 's'}`}
              </span>
            </div>

            <ul className="calendar-event-list">
              {selectedEvents.map((event) => (
                <li key={event.id} className="calendar-event-item">
                  <div className="calendar-event-main">
                    {event.time && (
                      <span className="calendar-event-time">{event.time}</span>
                    )}
                    <span className="calendar-event-title">{event.title}</span>
                  </div>
                  <button
                    type="button"
                    className="calendar-event-remove"
                    title="Remove event"
                    aria-label={`Remove ${event.title}`}
                    onClick={() => removeEvent(event.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>

            <form
              className="calendar-event-form"
              onSubmit={(event) => {
                event.preventDefault()
                addEvent()
              }}
            >
              <input
                ref={titleInputRef}
                className="calendar-event-input"
                type="text"
                placeholder="Add event…"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
              />
              <input
                className="calendar-event-time-input"
                type="time"
                value={draftTime}
                onChange={(event) => setDraftTime(event.target.value)}
                aria-label="Event time"
              />
              <button
                type="submit"
                className="calendar-event-add"
                disabled={!draftTitle.trim()}
              >
                Add
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
