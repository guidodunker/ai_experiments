import { useEffect, useState, useRef } from 'react'
import './NotesPage.css'

type Note = {
  id: number
  title: string
  content: string
}

const NOTES_URL = '/svc/notes-api/notes'

interface CreateNote {
  title: string
  content: string
}

export function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [formData, setFormData] = useState<CreateNote>({ title: '', content: '' })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const notesSectionRef = useRef<HTMLDivElement>(null)

  const fetchNotes = async () => {
    try {
      const response = await fetch(NOTES_URL)
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      const data = await response.json()
      setNotes(data as Note[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load notes')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchNotes()
  }, [])

  const resetForm = () => {
    setFormData({ title: '', content: '' })
    setIsCreating(false)
    setEditingId(null)
  }

  const handleCreate = async () => {
    if (!formData.title.trim() || !formData.content.trim()) {
      setError('Title and content are required')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      const response = await fetch(NOTES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || `Request failed with status ${response.status}`)
      }
      await fetchNotes()
      resetForm()
      // Focus the notes section after the form is hidden
      setTimeout(() => {
        notesSectionRef.current?.focus()
      }, 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create note')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEdit = async () => {
    if (!editingId) return
    if (!formData.title.trim() || !formData.content.trim()) {
      setError('Title and content are required')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      const response = await fetch(`${NOTES_URL}/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || `Request failed with status ${response.status}`)
      }
      await fetchNotes()
      resetForm()
      // Focus the notes section after the form is hidden
      setTimeout(() => {
        notesSectionRef.current?.focus()
      }, 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update note')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this note?')) return
    try {
      const response = await fetch(`${NOTES_URL}/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || `Request failed with status ${response.status}`)
      }
      await fetchNotes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete note')
    }
  }

  const startCreating = () => {
    setIsCreating(true)
    setFormData({ title: '', content: '' })
    setError(null)
  }

  const startEditing = (note: Note) => {
    setEditingId(note.id)
    setFormData({ title: note.title, content: note.content })
    setError(null)
  }

  const cancelForm = () => {
    resetForm()
  }

  return (
    <section ref={notesSectionRef} className="notes-page" tabIndex={0} aria-label="Notes">
      <header className="notes-header">
        <p className="eyebrow">notes-api</p>
        <h1>Your notes</h1>
        <p className="notes-summary">
          {isLoading ? 'Loading notes…' : `${notes.length} note${notes.length === 1 ? '' : 's'} from the service`}
        </p>
      </header>

      {error && <p className="notes-error" role="alert">{error}</p>}

      {(isCreating || editingId !== null) && (
        <div className="notes-form-container">
          <h2 className="notes-form-title">{editingId ? 'Edit note' : 'New note'}</h2>
          <div className="notes-form">
            <div className="form-group">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                type="text"
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="Enter note title"
                disabled={isSubmitting}
              />
            </div>
            <div className="form-group">
              <label htmlFor="content">Content</label>
              <textarea
                id="content"
                value={formData.content}
                onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                placeholder="Enter note content"
                rows={4}
                disabled={isSubmitting}
              />
            </div>
            <div className="form-actions">
              <button
                onClick={editingId ? handleEdit : handleCreate}
                disabled={isSubmitting || !formData.title.trim() || !formData.content.trim()}
                className="btn-primary"
              >
                {isSubmitting ? 'Saving...' : editingId ? 'Update' : 'Create'}
              </button>
              <button
                onClick={cancelForm}
                disabled={isSubmitting}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="notes-actions">
        {!isCreating && editingId === null && (
          <button onClick={startCreating} className="btn-primary">
            + New note
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="notes-status">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="notes-status">No notes available.</p>
      ) : (
        <div className="notes-grid">
          {notes.map(note => (
            <article className="note-card" key={note.id}>
              <div className="note-card-header">
                <span className="note-number">Note {note.id}</span>
                <h2>{note.title}</h2>
                <div className="note-actions">
                  <button
                    onClick={() => startEditing(note)}
                    className="btn-icon"
                    title="Edit note"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => handleDelete(note.id)}
                    className="btn-icon btn-delete"
                    title="Delete note"
                  >
                    🗑️
                  </button>
                </div>
              </div>
              <p>{note.content}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}