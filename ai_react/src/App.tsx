import { useState, useEffect } from 'react'
import { SearchBar } from './components/SearchBar.tsx'
import { Chat } from './chat/Chat.tsx'
import { Calendar } from './components/Calendar.tsx'
import { HelloWorld } from './components/HelloWorld.tsx'
import { ComponentsShowcase } from './components/ComponentsShowcase.tsx'
import { TodoList } from './components/TodoList.tsx'
import { NotesPage } from './components/NotesPage.tsx'
import './App.css'

const COLORS = {
  primary: '#b0b0b0',
  primaryHover: '#8a8a8a',
  secondary: '#d4d4d4',
  background: '#1a1a1a',
  sidebar: '#0f0f0f',
  card: '#2a2a2a',
  text: '#f0f0f0',
  textMuted: '#9a9a9a',
  border: '#3a3a3a',
  success: '#c0c0c0',
  error: '#7a7a7a',
}

type Page = 'home' | 'components' | 'todo' | 'calendar' | 'notes'
const PAGE_STORAGE_KEY = 'app.currentPage'

// Export todos for search to access
export const useTodos = () => {
  const [todos, setTodos] = useState<{ id: number; text: string; completed: boolean }[]>(() => {
    try {
      const saved = localStorage.getItem('todos')
      if (saved) return JSON.parse(saved)
    } catch { /* ignore */ }
    return []
  })

  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const saved = localStorage.getItem('todos')
        if (saved) setTodos(JSON.parse(saved))
      } catch { /* ignore */ }
    }, 500)
    return () => clearInterval(interval)
  }, [])

  return todos
}

function App() {
  const [page, setPage] = useState<Page>(() => {
    const savedPage = sessionStorage.getItem(PAGE_STORAGE_KEY)
    return savedPage === 'components' || savedPage === 'todo' || savedPage === 'calendar' || savedPage === 'notes'
      ? savedPage
      : 'home'
  })
  const todos = useTodos()

  useEffect(() => {
    sessionStorage.setItem(PAGE_STORAGE_KEY, page)
  }, [page])

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: COLORS.background }}>
      <div style={{
        width: '280px', backgroundColor: COLORS.sidebar, borderRight: `2px solid ${COLORS.border}`,
        padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px', flexShrink: 0
      }}>
        <HelloWorld />
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[
            { id: 'home', label: 'Coding Agent' },
            { id: 'components', label: 'Komponenten' },
            { id: 'calendar', label: 'Kalender' },
            { id: 'todo', label: 'TODO Liste' },
            { id: 'notes', label: 'Notes' }
          ].map(item => (
            <button
              key={item.id}
              onClick={() => setPage(item.id as Page)}
              style={{
                padding: '12px 16px',
                backgroundColor: page === item.id ? COLORS.primary : 'transparent',
                color: page === item.id ? '#fff' : COLORS.textMuted,
                border: `2px solid ${page === item.id ? COLORS.primary : COLORS.border}`,
                borderRadius: '8px', cursor: 'pointer', fontWeight: page === item.id ? '600' : '500',
                fontSize: '14px', textAlign: 'left', transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => { if (page !== item.id) e.currentTarget.style.backgroundColor = COLORS.card }}
              onMouseLeave={(e) => { if (page !== item.id) e.currentTarget.style.backgroundColor = 'transparent' }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      <div style={{ flex: 1, overflow: 'auto', backgroundColor: COLORS.background, color: COLORS.text }}>
        <SearchBar onNavigate={setPage} todos={todos} />
        {page === 'home' && <Chat />}
        {page === 'components' && <ComponentsShowcase />}
        {page === 'calendar' && <Calendar />}
        {page === 'todo' && <TodoList />}
        {page === 'notes' && <NotesPage />}
      </div>
    </div>
  )
}

export default App
