import { useState, useEffect, useMemo } from 'react'
import './SearchBar.css'

interface SearchResult {
  id: string
  title: string
  description: string
  category: string
  targetPage: 'home' | 'components' | 'todo' | 'calendar' | 'notes' | null
}

interface Todo {
  id: number
  text: string
  completed: boolean
}

interface Note {
  id: number
  title: string
  content: string
}

const MOCK_DATA: SearchResult[] = [
  { id: '1', title: 'Komponenten Showcase', description: 'Alle verfügbaren Komponenten und deren Beispiele anzeigen', category: 'Seite', targetPage: 'components' },
  { id: '2', title: 'TODO Liste', description: 'Interaktive Aufgabenverwaltung mit localStorage-Persistenz', category: 'Seite', targetPage: 'todo' },
  { id: '3', title: 'Kalender', description: 'Monatsansicht mit Outlook-Terminübersicht und Farbmarkierungen', category: 'Seite', targetPage: 'calendar' },
  { id: '4', title: 'Coding Agent', description: 'Hauptseite des KI-Coding-Assistenten mit Chat-Funktion', category: 'Seite', targetPage: 'home' },
  { id: '5', title: 'Error Boundary', description: 'Fängt alle Runtime-Fehler ab und zeigt ein rotes Crash-Banner an', category: 'Feature', targetPage: null },
  { id: '6', title: 'Recovery Page', description: 'Standalone-Seite zum Wiederherstellen älterer Zustände', category: 'Feature', targetPage: null },
  { id: '7', title: 'Commit-Panel', description: 'Zeigt alle Git-Commits mit FORGET-Funktion zum Zurücksetzen', category: 'Feature', targetPage: null },
  { id: '8', title: 'Microsoft Graph API', description: 'Outlook-Anbindung mit OAuth 2.0 PKCE-Fluss', category: 'Integration', targetPage: null },
  { id: '9', title: 'Store Modul', description: 'Modullevel Chat-Store mit useSyncExternalStore und Agent Loop', category: 'Architektur', targetPage: null },
  { id: '10', title: 'Agent Loop', description: 'Hauptschleife für die KI-Agenten-Aktionen mit Watchdog', category: 'Architektur', targetPage: null },
  { id: '11', title: 'Message Input', description: 'Eingabefeld für Nachrichten mit Enter-Senden und Shift+Enter-Format', category: 'Komponente', targetPage: null },
  { id: '12', title: 'Model Picker', description: 'Dropdown-Auswahl für OpenRouter-Modelle mit Auto-Vervollständigung', category: 'Komponente', targetPage: null },
]

export function SearchBar({ onNavigate, todos }: { onNavigate?: (page: 'home' | 'components' | 'todo' | 'calendar' | 'notes') => void; todos?: Todo[] }) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showResults, setShowResults] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])

  useEffect(() => {
    fetch('/svc/notes-api/notes')
      .then(res => res.ok ? res.json() : [])
      .then((data: Note[]) => setNotes(data))
      .catch(() => setNotes([]))
  }, [])

  const EXAMPLE_TODOS: Todo[] = [
    { id: 1, text: 'Implementiere Authentifizierung', completed: false },
    { id: 2, text: 'Bereite API-Dokumentation vor', completed: true },
    { id: 3, text: 'Optimiere Datenbankabfragen', completed: false },
  ]

  const allTodos = todos && todos.length > 0 ? todos : EXAMPLE_TODOS

  const results = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    const filteredData = MOCK_DATA.filter(
      item =>
        item.title.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    )

    const todoResults: SearchResult[] = allTodos
      .filter(todo =>
        todo.text.toLowerCase().includes(q) ||
        (todo.completed ? 'completed' : 'pending').includes(q)
      )
      .map(todo => ({
        id: `todo-${todo.id}`,
        title: todo.text,
        description: todo.completed ? '✅ Erledigt' : '⏳ Ausstehend',
        category: 'Aufgabe',
        targetPage: 'todo' as const,
      }))

    const noteResults: SearchResult[] = notes
      .filter(note =>
        note.title.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q)
      )
      .map(note => ({
        id: `note-${note.id}`,
        title: note.title,
        description: note.content,
        category: 'Notiz',
        targetPage: 'notes' as const,
      }))

    return [...filteredData, ...todoResults, ...noteResults]
  }, [query, allTodos, notes])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showResults || results.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault()
      const result = results[selectedIndex]
      setQuery(result.title)
      setShowResults(false)
      setSelectedIndex(0)
      if (result.targetPage && onNavigate) {
        onNavigate(result.targetPage)
      }
    } else if (e.key === 'Escape') {
      setShowResults(false)
      setSelectedIndex(0)
    }
  }

  const handleFocus = () => {
    if (query.trim() && results.length > 0) {
      setShowResults(true)
      setSelectedIndex(0)
    }
  }

  const handleBlur = () => {
    setTimeout(() => setShowResults(false), 200)
  }

  const handleSelect = (result: SearchResult) => {
    setQuery(result.title)
    setShowResults(false)
    setSelectedIndex(0)
    if (result.targetPage && onNavigate) {
      onNavigate(result.targetPage)
    }
  }

  return (
    <div className="search-bar">
      <div className="search-bar__input-wrapper">
        <span className="search-bar__icon" aria-hidden="true">🔍</span>
        <input
          type="text"
          className="search-bar__input"
          placeholder="Suche..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShowResults(true); setSelectedIndex(0) }}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          aria-label="Suche"
          aria-expanded={showResults && results.length > 0}
          aria-controls="search-results-list"
          aria-activedescendant={results[selectedIndex] ? `search-result-${results[selectedIndex].id}` : undefined}
          autoComplete="off"
        />
        {query && (
          <button
            className="search-bar__clear"
            type="button"
            onClick={() => { setQuery(''); setShowResults(false); setSelectedIndex(0) }}
            aria-label="Suche zurücksetzen"
          >
            ✕
          </button>
        )}
      </div>

      {showResults && results.length > 0 && (
        <ul className="search-bar__results" id="search-results-list" role="listbox">
          {results.map((result, index) => (
            <li
              key={result.id}
              id={`search-result-${result.id}`}
              className={`search-bar__result ${index === selectedIndex ? 'search-bar__result--active' : ''} ${result.targetPage ? 'search-bar__result--clickable' : ''} ${result.category === 'Aufgabe' ? 'search-bar__result--todo' : ''}`}
              role="option"
              aria-selected={index === selectedIndex}
              onMouseDown={() => handleSelect(result)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="search-bar__result-title">
                {result.category === 'Aufgabe' && <span className="search-bar__result-icon">📝</span>}
                {result.title}
                {result.targetPage && <span className="search-bar__result-arrow"> →</span>}
              </span>
              <span className="search-bar__result-desc">{result.description}</span>
              <span className="search-bar__result-category">{result.category}</span>
            </li>
          ))}
        </ul>
      )}

      {showResults && query.trim() && results.length === 0 && (
        <div className="search-bar__no-results" role="status">
          <p>Keine Ergebnisse für "{query}"</p>
        </div>
      )}

      {!query && (
        <div className="search-bar__hint">
          <p>Tastatur: <kbd>↑</kbd> <kbd>↓</kbd> navigieren · <kbd>Enter</kbd> auswählen · <kbd>Esc</kbd> schließen</p>
        </div>
      )}
    </div>
  )
}