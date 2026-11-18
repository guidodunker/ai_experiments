import { useCallback, useEffect, useRef, useState } from 'react'
import { ENGINES, TEXT_BOOSTS, postSearch } from './api.js'
import { ResultCard } from './ResultCard.jsx'

/** Anfragen, die zeigen, was semantische Suche kann und Stichwortsuche nicht. */
const BEISPIELE = [
  'womit säge ich Kurven in Holz',
  'billiger Akkuschrauber für Möbelaufbau',
  'meine Terrasse ist grün und schmutzig',
  'ich will eine Wand im Wohnzimmer streichen',
  'etwas gegen Lärm beim Flexen',
]

export function TextSearch({ basis, onAdd, engine }) {
  const [query, setQuery] = useState('')
  const [k, setK] = useState(10)
  const [textBoost, setTextBoost] = useState(0.1)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  // Verhindert, dass eine langsame frühere Antwort eine neuere überschreibt.
  const runId = useRef(0)
  const inputRef = useRef(null)
  // Zuletzt gestellte Anfrage, für die Wiederholung beim Umschalten.
  const lastQuery = useRef('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const search = useCallback(
    async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const id = ++runId.current
      lastQuery.current = trimmed
      setLoading(true)
      setError(null)
      try {
        const data = await postSearch(trimmed, k, engine, textBoost)
        if (id === runId.current) setResult(data)
      } catch (e) {
        if (id === runId.current) {
          setError(e.message)
          setResult(null)
        }
      } finally {
        if (id === runId.current) setLoading(false)
      }
    },
    [k, engine, textBoost],
  )

  // Beim Umschalten der Suchmaschine dieselbe Anfrage noch einmal stellen,
  // damit sich die Listen direkt vergleichen lassen. Nur auf engine reagieren,
  // nicht auf jede neue search-Funktion (die ändert sich auch mit k).
  const searchRef = useRef(search)
  useEffect(() => {
    searchRef.current = search
  }, [search])
  // Ebenso beim Ändern des Text-Gewichts: genau dafür ist der Regler da.
  useEffect(() => {
    if (lastQuery.current) searchRef.current(lastQuery.current)
  }, [engine, textBoost])

  return (
    <>
      <p className="erklaerung">
        Beschreib dein Vorhaben in eigenen Worten. Verglichen wird Bedeutung,
        kein Stichwort — die Anfrage muss dafür erst beim Modell eingebettet
        werden, und das dauert.
      </p>

      <form
        className="suchfeld"
        onSubmit={(event) => {
          event.preventDefault()
          search(query)
        }}
      >
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="z.B. womit säge ich Kurven in Holz"
          aria-label="Suchanfrage"
          maxLength={500}
        />
        <label className="treffer-anzahl">
          Treffer
          <select value={k} onChange={(e) => setK(Number(e.target.value))}>
            {[5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {engine === 'hybrid' && (
          <label
            className="treffer-anzahl"
            title="Gewicht des Volltext-Anteils (BM25). 0 = reines kNN. BM25-Scores liegen schnell bei 5–15, kNN-Scores zwischen 0 und 1."
          >
            Text-Gewicht
            <select
              value={textBoost}
              onChange={(e) => setTextBoost(Number(e.target.value))}
            >
              {TEXT_BOOSTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? 'Sucht…' : 'Suchen'}
        </button>
      </form>

      <div className="beispiele">
        {BEISPIELE.map((text) => (
          <button
            key={text}
            type="button"
            className="beispiel"
            onClick={() => {
              setQuery(text)
              search(text)
            }}
            disabled={loading}
          >
            {text}
          </button>
        ))}
      </div>

      {error && (
        <div className="meldung fehler" role="alert">
          <strong>Suche fehlgeschlagen</strong>
          <pre>{error}</pre>
        </div>
      )}

      {result && !error && (
        <>
          <div className="zeitleiste">
            <span>
              <strong>{result.hits.length}</strong> Treffer für „{result.query}“
            </span>
            <span className="zeiten">
              <span title="Die Anfrage beim Embedding-Modell einbetten">
                Embedding-API {result.embedMs} ms
              </span>
              <span className="trenner">·</span>
              <span title={ENGINES[result.engine]?.title}>
                {ENGINES[result.engine]?.label ?? 'Datenbank'} {result.searchMs} ms
                {result.took !== undefined && ` (intern ${result.took} ms)`}
                {result.textBoost !== undefined && `, Text-Gewicht ${result.textBoost}`}
              </span>
              <span className="trenner">·</span>
              <span className="anteil">
                {Math.round(
                  (result.embedMs / Math.max(result.embedMs + result.searchMs, 1)) *
                    100,
                )}{' '}
                % Wartezeit auf die API
              </span>
            </span>
          </div>

          {result.hits.length === 0 ? (
            <p className="meldung leer">Keine Treffer.</p>
          ) : (
            <ol className="trefferliste">
              {result.hits.map((hit, index) => (
                <ResultCard
                  key={hit.docId}
                  hit={hit}
                  rang={index + 1}
                  onAdd={onAdd}
                  inBasis={basis.includes(hit.docId)}
                  maxScore={result.hits[0]?.score}
                />
              ))}
            </ol>
          )}
        </>
      )}

      {!result && !error && !loading && (
        <p className="meldung leer">
          Noch keine Suche. Nimm ein Beispiel oben oder tipp etwas ein.
        </p>
      )}
    </>
  )
}
