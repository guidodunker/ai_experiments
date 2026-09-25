import { useState, useEffect } from 'react'

interface Todo { id: number; text: string; completed: boolean }
const STORAGE_KEY = 'todos'
const COLORS = {
  primary: '#3b82f6', // blue-500
  secondary: '#60a5fa', // blue-400
  background: '#e0f2fe', // blue-100
  text: '#1e3a8a', // blue-800
  textMuted: '#93c5fd', // blue-300
  border: '#60a5fa', // blue-400
  success: '#10b981', // green-500
  error: '#ef4444', // red-500
  card: '#e0f2fe', // blue-100
}

const EXAMPLE_TODOS: Todo[] = [
  { id: 1, text: 'Implementiere Authentifizierung', completed: false },
  { id: 2, text: 'Bereite API-Dokumentation vor', completed: true },
  { id: 3, text: 'Optimiere Datenbankabfragen', completed: false },
]

export function TodoList({ demo = false }: { demo?: boolean }) {
  const [todos, setTodos] = useState<Todo[]>(() => {
    if (demo) return EXAMPLE_TODOS
    const savedTodos = localStorage.getItem(STORAGE_KEY)
    if (savedTodos) {
      try { return JSON.parse(savedTodos) } catch (e) { console.error('Fehler beim Laden der TODOs:', e) }
    }
    return []
  })
  const [input, setInput] = useState('')
  useEffect(() => { if (!demo) localStorage.setItem(STORAGE_KEY, JSON.stringify(todos)) }, [demo, todos])
  const addTodo = () => { if (!demo && input.trim()) { setTodos([...todos, { id: Date.now(), text: input, completed: false }]); setInput('') } }
  const toggleTodo = (id: number) => { if (!demo) setTodos(todos.map(todo => todo.id === id ? { ...todo, completed: !todo.completed } : todo)) }
  const deleteTodo = (id: number) => { if (!demo) setTodos(todos.filter(todo => todo.id !== id)) }
  const handleKeyPress = (e: React.KeyboardEvent) => { if (!demo && e.key === 'Enter') addTodo() }

  return (
    <div style={{ padding: '40px 20px', minHeight: '100vh', backgroundColor: COLORS.background }}>
      <div style={{ maxWidth: '700px', margin: '0 auto' }}>
        <h1 style={{ color: COLORS.text, marginBottom: '30px', fontSize: '32px', fontWeight: '700' }}>📝 TODO Liste</h1>
        <div style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}>
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyPress} placeholder="Neues TODO hinzufügen..." style={{ flex: 1, padding: '12px 16px', fontSize: '14px', backgroundColor: COLORS.card, border: `2px solid ${COLORS.border}`, borderRadius: '8px', color: COLORS.text }} />
          <button onClick={addTodo} style={{ padding: '12px 24px', backgroundColor: COLORS.primary, color: '#ffffff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: '600', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)' }}>Hinzufügen</button>
        </div>
        <div>
          {todos.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', backgroundColor: COLORS.card, borderRadius: '12px', border: `2px dashed ${COLORS.border}`, color: COLORS.textMuted }}>
              <p style={{ fontSize: '18px', marginBottom: '8px' }}>📭 Noch keine TODOs</p>
              <p style={{ fontSize: '14px' }}>Füge ein neues TODO hinzu, um zu starten!</p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {todos.map(todo => (
                <li key={todo.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px', marginBottom: '12px', backgroundColor: COLORS.card, borderRadius: '8px', border: `1px solid ${COLORS.border}`, opacity: todo.completed ? 0.7 : 1 }}>
                  <input type="checkbox" checked={todo.completed} onChange={() => toggleTodo(todo.id)} style={{ width: '20px', height: '20px', cursor: 'pointer', accentColor: COLORS.success }} />
                  <span style={{ flex: 1, textDecoration: todo.completed ? 'line-through' : 'none', color: todo.completed ? COLORS.textMuted : COLORS.text, fontSize: '15px' }}>{todo.text}</span>
                  <button onClick={() => deleteTodo(todo.id)} style={{ padding: '8px 12px', backgroundColor: 'transparent', color: COLORS.primary, border: `1px solid ${COLORS.primary}`, borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '500' }}>Löschen</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {todos.length > 0 && (
          <div style={{ marginTop: '32px', padding: '16px 20px', backgroundColor: `${COLORS.primary}20`, borderLeft: `4px solid ${COLORS.primary}`, borderRadius: '8px', fontSize: '14px', color: COLORS.text, fontWeight: '500' }}>
            <span style={{ color: COLORS.secondary, fontWeight: '600' }}>{todos.filter(t => !t.completed).length}</span> von <span style={{ color: COLORS.secondary, fontWeight: '600' }}>{todos.length}</span> TODOs verbleibend
          </div>
        )}
      </div>
    </div>
  )
}
