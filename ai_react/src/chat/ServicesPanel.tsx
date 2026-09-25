import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe } from './store.ts'
import type { ServiceStatus } from '../agent/serviceHealth.ts'

const POLL_MS = 3000

/**
 * Live view of the declared services. Rendered inside the chat subtree on
 * purpose: AppErrorBoundary keeps the chat mounted when App.tsx crashes, so the
 * panel stays usable exactly when it is most needed.
 */
export function ServicesPanel() {
  const { busy } = useSyncExternalStore(subscribe, getSnapshot)
  const [services, setServices] = useState<ServiceStatus[]>([])
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/services')
      const body = await res.json()
      if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`))
      setServices(body.services as ServiceStatus[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Refresh after every turn, and keep polling only while expanded.
  useEffect(() => {
    if (!busy) void refresh()
  }, [busy, refresh])

  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [open, refresh])

  const control = useCallback(
    async (name: string, action: 'start' | 'stop' | 'restart') => {
      try {
        const res = await fetch('/api/services/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      void refresh()
    },
    [refresh],
  )

  const showLogs = useCallback(async (name: string) => {
    const res = await fetch('/api/services/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lines: 100 }),
    })
    const body = await res.json()
    setLogs({ name, text: res.ok ? String(body.logs || '(no output)') : String(body.error) })
  }, [])

  const unhealthy = services.filter((s) => s.enabled && s.state !== 'ready').length
  const running = services.filter((s) => s.state === 'ready').length

  if (services.length === 0 && !error) return null

  return (
    <section className={`services-panel${open ? ' open' : ''}`}>
      <button className="services-summary" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} Services</span>
        <span className="services-counts">
          {running} running{unhealthy > 0 ? ` · ${unhealthy} unhealthy` : ''}
        </span>
      </button>
      {open && (
        <div className="services-list">
          {error && <div className="services-error">{error}</div>}
          {services.map((s) => (
            <div key={s.name} className="service-row">
              <span className={`service-dot ${s.state}`} title={s.state} />
              <span className="service-name">{s.name}</span>
              <code className="service-port">:{s.port}</code>
              {!s.enabled && <span className="service-badge">disabled</span>}
              <span className="service-actions">
                <button title="Start" onClick={() => void control(s.name, 'start')}>
                  ▶
                </button>
                <button title="Stop" onClick={() => void control(s.name, 'stop')}>
                  ■
                </button>
                <button title="Restart" onClick={() => void control(s.name, 'restart')}>
                  ⟳
                </button>
                <button title="Logs" onClick={() => void showLogs(s.name)}>
                  ≡
                </button>
              </span>
            </div>
          ))}
          {logs && (
            <div className="service-logs">
              <div className="service-logs-header">
                <span>{logs.name}</span>
                <button onClick={() => setLogs(null)}>✕</button>
              </div>
              <pre>{logs.text}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
