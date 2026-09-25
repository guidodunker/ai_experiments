import { useState } from 'react'
import { HelloWorld } from './HelloWorld'
import { TodoList } from './TodoList'
import { Calendar } from './Calendar'
import { ErrorTestButton } from './ErrorTestButton'

const COLORS = {
  background: '#0f0f0f', card: '#0f2b4b', text: '#dbeafa', textMuted: '#7fb0e8',
  border: '#1d4775', primary: '#dc2626', primaryHover: '#b91c1c', code: '#0f0f0f',
}

interface ShowcaseItem {
  key: string
  label: string
  content: React.ReactNode
}

const COMPONENTS: ShowcaseItem[] = [
  {
    key: 'helloWorld',
    label: '👋 HelloWorld Component',
    content: <HelloWorld />,
  },
  {
    key: 'todoList',
    label: '📝 TODO Liste Beispiele',
    content: <TodoList demo={true} />,
  },
  {
    key: 'calendar',
    label: '📅 Kalender Komponente',
    content: <Calendar />,
  },
  {
    key: 'errorBoundary',
    label: '🛡️ Error Boundary / Fehler Test',
    content: <ErrorTestButton onInject={() => {}} />,
  },
]

export function ComponentsShowcase() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <div style={{ padding: '40px 20px', minHeight: '100vh', backgroundColor: COLORS.background }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
        <h1 style={{ color: COLORS.text, marginBottom: '12px', fontSize: '32px', fontWeight: '700' }}>🎨 Komponenten Showcase</h1>
        <p style={{ color: COLORS.textMuted, marginBottom: '24px', fontSize: '16px' }}>Alle verfügbare Komponenten und deren Beispiele</p>

        {COMPONENTS.map(item => (
          <div style={{ marginBottom: '24px' }} key={item.key}>
            <button
              onClick={() => toggle(item.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '12px 20px',
                backgroundColor: expanded[item.key] ? COLORS.primary : 'transparent',
                color: expanded[item.key] ? '#ffffff' : COLORS.textMuted,
                border: `1px solid ${expanded[item.key] ? COLORS.primaryHover : COLORS.border}`,
                borderRadius: '8px', cursor: 'pointer', fontSize: '15px', fontWeight: '600',
                width: '100%', textAlign: 'left',
              }}
            >
              <span>{expanded[item.key] ? '▼' : '▶'}</span>
              {item.label}
            </button>
            {expanded[item.key] && (
              <div style={{
                padding: '20px', backgroundColor: COLORS.card,
                borderRadius: '0 0 8px 8px', border: `1px solid ${COLORS.border}`, borderTop: 'none'
              }}>
                {item.content}
              </div>
            )}
          </div>
        ))}

        <div style={{ backgroundColor: `${COLORS.primary}20`, borderLeft: `4px solid ${COLORS.primaryHover}`, borderRadius: '8px', padding: '20px', color: COLORS.text }}>
          <p style={{ margin: 0, fontSize: '14px' }}>💡 <strong>Tipp:</strong> Weitere Komponenten findest du im Ordner <code style={{ backgroundColor: COLORS.code, padding: '2px 6px', borderRadius: '4px', color: '#bfdbfe' }}>src/components/</code></p>
        </div>
      </div>
    </div>
  )
}