import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './Calendar.css'

interface CalendarEvent {
  id: string
  date: string
  time: string
  title: string
  color: string
  description?: string
  webLink?: string
}

interface OutlookEvent {
  id?: string
  subject?: string | null
  start?: {
    dateTime?: string
    timeZone?: string
  } | null
  isAllDay?: boolean
  bodyPreview?: string | null
  category?: string | null
  webLink?: string | null
}

interface GraphTokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

const EVENT_COLORS = {
  default: '#f87171',
  meeting: '#dc2626',
  personal: '#fca5a5',
  important: '#ef4444',
  work: '#fb923c',
}

const AUTH_STORAGE_PREFIX = 'ai-react-outlook-'
const GRAPH_SCOPE = 'openid profile offline_access Calendars.Read'

const toISODate = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const fromISODate = (date: string) => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const addDays = (date: Date, amount: number) => {
  const nextDate = new Date(date)
  nextDate.setDate(nextDate.getDate() + amount)
  return nextDate
}

const DEMO_EVENTS: CalendarEvent[] = [
  {
    id: 'standup',
    date: toISODate(new Date()),
    time: '09:00',
    title: 'Team Stand-up',
    color: EVENT_COLORS.meeting,
  },
  {
    id: 'review',
    date: toISODate(addDays(new Date(), 2)),
    time: '14:30',
    title: 'Projekt-Review',
    color: EVENT_COLORS.work,
  },
  {
    id: 'design',
    date: toISODate(addDays(new Date(), 5)),
    time: '11:00',
    title: 'Design-Workshop',
    color: EVENT_COLORS.personal,
  },
  {
    id: 'invoice',
    date: toISODate(addDays(new Date(), 9)),
    time: '16:00',
    title: 'Rechnungen prüfen',
    color: EVENT_COLORS.important,
  },
]

const randomBase64Url = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)

  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const base64Url = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const getTenantId = () => import.meta.env.VITE_MS_OUTLOOK_TENANT_ID?.trim() || 'common'

const getRedirectUri = () => {
  const configuredRedirectUri = import.meta.env.VITE_MS_OUTLOOK_REDIRECT_URI?.trim()
  if (configuredRedirectUri) {
    return configuredRedirectUri
  }

  return typeof window === 'undefined'
    ? 'http://localhost:5173/'
    : `${window.location.origin}/`
}

const getStorageValue = (key: string) => {
  try {
    return sessionStorage.getItem(`${AUTH_STORAGE_PREFIX}${key}`)
  } catch {
    return null
  }
}

const setStorageValue = (key: string, value: string) => {
  try {
    sessionStorage.setItem(`${AUTH_STORAGE_PREFIX}${key}`, value)
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
}

const removeStorageValue = (key: string) => {
  try {
    sessionStorage.removeItem(`${AUTH_STORAGE_PREFIX}${key}`)
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
}

const describeGraphError = async (response: Response) => {
  try {
    const data = await response.json()
    return data?.error?.description || data?.error || response.statusText
  } catch {
    return response.statusText
  }
}

const toCalendarEvent = (event: OutlookEvent, index: number): CalendarEvent => {
  const dateTime = event.start?.dateTime
  const parsedDate = dateTime ? new Date(dateTime) : new Date()
  const eventDate = Number.isNaN(parsedDate.getTime())
    ? toISODate(new Date())
    : toISODate(parsedDate)
  const category = (event.category ?? 'default') as keyof typeof EVENT_COLORS

  return {
    id: event.id ?? `outlook-event-${index}-${eventDate}`,
    date: eventDate,
    time: event.isAllDay
      ? 'Ganztägig'
      : (dateTime?.slice(0, 5) || 'Zeit fehlt'),
    title: event.subject?.trim() || 'Ohne Betreff',
    color: EVENT_COLORS[category] || EVENT_COLORS.default,
    description: event.bodyPreview?.replace(/<[^>]+>/g, '').trim(),
    webLink: event.webLink ?? undefined,
  }
}

export function Calendar({
  events,
  onDateSelect,
}: {
  events?: CalendarEvent[]
  onDateSelect?: (date: string) => void
}) {
  const today = new Date()
  const outlookClientId = import.meta.env.VITE_MS_OUTLOOK_CLIENT_ID?.trim()
  const tenantId = getTenantId()
  const redirectUri = getRedirectUri()

  const [viewDate, setViewDate] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  )
  const [selectedDate, setSelectedDate] = useState(() => toISODate(today))
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [outlookEvents, setOutlookEvents] = useState<CalendarEvent[]>([])
  const [account, setAccount] = useState<{
    displayName?: string
    userPrincipalName?: string
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [outlookError, setOutlookError] = useState<string | null>(null)
  const callbackHandled = useRef(false)

  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  const leadingBlanks = Array.from({ length: firstWeekday })
  const days = Array.from({ length: daysInMonth }, (_, index) => index + 1)

  const loadOutlookEvents = useCallback(async () => {
    if (!accessToken) {
      return
    }

    setLoading(true)
    setOutlookError(null)

    try {
      const start = new Date(year, month, 1, 0, 0, 0, 0)
      const end = new Date(year, month + 1, 1, 0, 0, 0, 0)
      const query = new URLSearchParams({
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        '$select': 'id,subject,start,end,bodyPreview,isAllDay,category,webLink,showAs',
        '$orderby': 'start/dateTime',
      })

      const calendarResponse = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarview?${query.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      )

      if (!calendarResponse.ok) {
        throw new Error(`Termine konnten nicht geladen werden: ${await describeGraphError(calendarResponse)}`)
      }

      const calendarData = await calendarResponse.json()
      const values = Array.isArray(calendarData.value) ? calendarData.value : []
      setOutlookEvents(values.map(toCalendarEvent))

      const accountResponse = await fetch(
        'https://graph.microsoft.com/v1.0/me?$select=displayName,userPrincipalName',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      )

      if (accountResponse.ok) {
        const accountData = await accountResponse.json()
        setAccount({
          displayName: accountData.displayName,
          userPrincipalName: accountData.userPrincipalName,
        })
      }
    } catch (error) {
      setOutlookError(error instanceof Error ? error.message : 'Unbekannter Fehler beim Laden der Termine.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, month, year])

  useEffect(() => {
    void loadOutlookEvents()
  }, [loadOutlookEvents])

  const connectOutlook = useCallback(async () => {
    if (!outlookClientId) {
      setOutlookError('Outlook ist nicht konfiguriert. Setze VITE_MS_OUTLOOK_CLIENT_ID.')
      return
    }

    const verifier = randomBase64Url()
    const challenge = base64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    )
    const state = randomBase64Url()

    setStorageValue('state', state)
    setStorageValue('codeVerifier', verifier)
    setLoading(true)

    const authorizeParams = new URLSearchParams({
      client_id: outlookClientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: GRAPH_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })

    const authorizeUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?${authorizeParams.toString()}`
    window.location.assign(authorizeUrl)
  }, [outlookClientId, redirectUri, tenantId])

  const handleCallback = useCallback(async () => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const error = params.get('error')
    const state = params.get('state')
    const storedState = getStorageValue('state')
    const verifier = getStorageValue('codeVerifier')

    if (error) {
      setOutlookError(params.get('error_description') || 'Die Outlook-Anmeldung wurde abgebrochen.')
      setLoading(false)
      return
    }

    if (!code || !state || !verifier) {
      setOutlookError('Die Outlook-Anmeldung konnte nicht abgeschlossen werden.')
      setLoading(false)
      return
    }

    if (state !== storedState) {
      setOutlookError('Die Outlook-Anmeldung ist ungültig. Bitte versuche es erneut.')
      setLoading(false)
      return
    }

    try {
      const tokenParams = new URLSearchParams({
        client_id: outlookClientId || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: verifier,
        scope: GRAPH_SCOPE,
      })

      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: tokenParams.toString(),
        }
      )

      const tokenData = await tokenResponse.json() as GraphTokenResponse
      if (!tokenResponse.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || 'Token konnte nicht erstellt werden.')
      }

      setAccessToken(tokenData.access_token)
      setOutlookError(null)
      setAccount(null)
      removeStorageValue('state')
      removeStorageValue('codeVerifier')

      try {
        window.history.replaceState({}, document.title, window.location.pathname)
      } catch {
        // The callback can still be used if the history API is restricted.
      }

      await loadOutlookEvents()
    } catch (callbackError) {
      setOutlookError(callbackError instanceof Error ? callbackError.message : 'Outlook-Anmeldung fehlgeschlagen.')
    } finally {
      setLoading(false)
    }
  }, [loadOutlookEvents, outlookClientId, redirectUri, tenantId])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if ((params.get('code') || params.get('error')) && !callbackHandled.current) {
      callbackHandled.current = true
      void handleCallback()
    }
  }, [handleCallback])

  const disconnectOutlook = () => {
    setAccessToken(null)
    setOutlookEvents([])
    setAccount(null)
    setOutlookError(null)
    removeStorageValue('state')
    removeStorageValue('codeVerifier')
  }

  const calendarEvents = accessToken ? outlookEvents : events || DEMO_EVENTS
  const eventsByDate = useMemo(() => {
    return calendarEvents.reduce<Record<string, CalendarEvent[]>>((grouped, event) => {
      grouped[event.date] ??= []
      grouped[event.date].push(event)
      return grouped
    }, {})
  }, [calendarEvents])

  const selectedDayEvents = eventsByDate[selectedDate] || []
  const selectedDateLabel = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(fromISODate(selectedDate))

  const selectDate = (date: string) => {
    const nextDate = fromISODate(date)
    setSelectedDate(date)
    setViewDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1))
    onDateSelect?.(date)
  }

  const moveMonth = (amount: number) => {
    setViewDate(new Date(year, month + amount, 1))
  }

  const showToday = () => {
    const date = new Date()
    setViewDate(new Date(date.getFullYear(), date.getMonth(), 1))
    selectDate(toISODate(date))
  }

  const isConnected = Boolean(accessToken)

  return (
    <section className="calendar" aria-label="Kalender">
      <header className="calendar__header">
        <div>
          <span className="calendar__eyebrow">Terminübersicht</span>
          <h2 className="calendar__title">
            {MONTHS[month]} <span>{year}</span>
          </h2>
        </div>

        <div className="calendar__controls">
          {outlookClientId ? (
            isConnected ? (
              <div className="calendar__connected">
                <span className="calendar__status-dot" aria-hidden="true" />
                <span className="calendar__connected-label">Outlook verbunden</span>
                {account?.userPrincipalName && (
                  <small className="calendar__account">{account.userPrincipalName}</small>
                )}
                <button
                  className="calendar__disconnect-button"
                  type="button"
                  onClick={disconnectOutlook}
                  disabled={loading}
                >
                  Abmelden
                </button>
              </div>
            ) : (
              <button
                className="calendar__connect-button"
                type="button"
                onClick={connectOutlook}
                disabled={loading}
              >
                {loading ? 'Verbindung wird hergestellt...' : 'Mit Outlook verbinden'}
              </button>
            )
          ) : (
            <div className="calendar__setup">
              Outlook-Anbindung konfigurieren
            </div>
          )}

          <button className="calendar__today-button" type="button" onClick={showToday} disabled={loading}>
            Heute
          </button>
          <button
            className="calendar__icon-button"
            type="button"
            aria-label="Vorheriger Monat"
            onClick={() => moveMonth(-1)}
            disabled={loading}
          >
            ‹
          </button>
          <button
            className="calendar__icon-button"
            type="button"
            aria-label="Nächster Monat"
            onClick={() => moveMonth(1)}
            disabled={loading}
          >
            ›
          </button>
        </div>
      </header>

      {outlookError && (
        <div className="calendar__error" role="alert">
          {outlookError}
        </div>
      )}

      <div className="calendar__weekdays" aria-hidden="true">
        {WEEKDAYS.map(day => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="calendar__days">
        {leadingBlanks.map((_, index) => (
          <span className="calendar__day calendar__day--blank" key={`blank-${index}`} />
        ))}
        {days.map(day => {
          const date = toISODate(new Date(year, month, day))
          const dayEvents = eventsByDate[date] || []
          const isToday = date === toISODate(today)
          const isSelected = date === selectedDate
          const className = [
            'calendar__day',
            isToday ? 'calendar__day--today' : '',
            isSelected ? 'calendar__day--selected' : '',
          ].filter(Boolean).join(' ')

          return (
            <button
              className={className}
              type="button"
              key={day}
              aria-pressed={isSelected}
              aria-label={`${day}. ${MONTHS[month]} ${year}${dayEvents.length ? `, ${dayEvents.length} Termine` : ', kein Termin'}`}
              onClick={() => selectDate(date)}
            >
              <span className="calendar__day-number">{day}</span>
              {dayEvents.length > 0 && (
                <span className="calendar__event-count" aria-hidden="true">
                  {dayEvents.length > 3 ? `+${dayEvents.length - 3}` : dayEvents.length}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <aside className="calendar__details">
        <span className="calendar__eyebrow">Ausgewählter Tag</span>
        <h3>{selectedDateLabel}</h3>

        {selectedDayEvents.length === 0 ? (
          <div className="calendar__empty">
            <span aria-hidden="true">◇</span>
            <p>Keine Termine an diesem Tag</p>
            {isConnected && <small>Termine werden direkt aus deinem Outlook geladen.</small>}
          </div>
        ) : (
          <div className="calendar__event-list">
            {selectedDayEvents.map(event => (
              <article className="calendar__event" key={event.id}>
                <span
                  className="calendar__event-marker"
                  style={{ backgroundColor: event.color }}
                  aria-hidden="true"
                />
                <div>
                  <time style={{ color: event.color }}>{event.time}</time>
                  <strong>{event.title}</strong>
                  {event.description && <p>{event.description}</p>}
                  {event.webLink && (
                    <a href={event.webLink} target="_blank" rel="noreferrer">
                      Im Outlook öffnen ↗
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </aside>
    </section>
  )
}
