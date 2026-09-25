import { useCallback, useMemo, useState } from 'react'
import { postRecommend } from './api.js'
import { ResultCard } from './ResultCard.jsx'

/** "105, 106 107" → ["105","106","107"], ohne Duplikate, nur positive Zahlen. */
function parseDocIds(text) {
  return [
    ...new Set(
      text
        .split(/[^0-9]+/)
        .filter(Boolean)
        .filter((n) => Number(n) > 0),
    ),
  ]
}

export function Recommend({ products, basis, setBasis, onRemove }) {
  const [rohEingabe, setRohEingabe] = useState('')
  const [k, setK] = useState(10)
  const [includeBasis, setIncludeBasis] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const nachId = useMemo(
    () => new Map(products.map((p) => [p.docId, p])),
    [products],
  )

  const uebernehmen = () => {
    const neue = parseDocIds(rohEingabe)
    if (neue.length === 0) return
    setBasis((current) => [...new Set([...current, ...neue])])
    setRohEingabe('')
  }

  const auswaehlen = (docId) => {
    if (!docId) return
    setBasis((current) =>
      current.includes(docId) ? current : [...current, docId],
    )
  }

  const suchen = useCallback(async () => {
    if (basis.length === 0) return
    setLoading(true)
    setError(null)
    try {
      setResult(await postRecommend(basis, k, includeBasis))
    } catch (e) {
      setError(e.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [basis, k, includeBasis])

  return (
    <>
      <p className="erklaerung">
        Mehrere Produkte als Ausgangspunkt. Aus ihren Vektoren wird der
        Mittelwert gebildet, und mit diesem Vektor wird gesucht. Dafür ist{' '}
        <strong>kein Aufruf beim Embedding-Modell nötig</strong> — die Vektoren
        liegen bereits im Korpus, die Suche kostet nur den Datenbankdurchlauf.
      </p>

      <form
        className="suchfeld"
        onSubmit={(event) => {
          event.preventDefault()
          uebernehmen()
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          value={rohEingabe}
          onChange={(e) => setRohEingabe(e.target.value)}
          placeholder="doc_ids, z.B. 105, 106 107"
          aria-label="doc_ids der Ausgangsprodukte"
        />
        <button type="submit" disabled={parseDocIds(rohEingabe).length === 0}>
          Übernehmen
        </button>
      </form>

      <label className="produktwahl">
        oder aus der Liste wählen
        <select value="" onChange={(e) => auswaehlen(e.target.value)}>
          <option value="">— Produkt hinzufügen —</option>
          {products.map((p) => (
            <option key={p.docId} value={p.docId} disabled={basis.includes(p.docId)}>
              {p.docId} · {p.name} ({p.category})
            </option>
          ))}
        </select>
      </label>

      <div className="basis">
        {basis.length === 0 ? (
          <p className="meldung leer">
            Noch keine Ausgangsprodukte. Gib doc_ids ein, wähl aus der Liste,
            oder nimm in der Textsuche einen Treffer mit <code>+</code> dazu.
          </p>
        ) : (
          <>
            <div className="basis-chips">
              {basis.map((docId) => (
                <span key={docId} className="chip">
                  <span className="chip-id">{docId}</span>
                  {nachId.get(docId)?.name ?? 'unbekannte doc_id'}
                  <button
                    type="button"
                    onClick={() => onRemove(docId)}
                    aria-label={`${docId} entfernen`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            <div className="basis-aktionen">
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
              <label className="schalter">
                <input
                  type="checkbox"
                  checked={includeBasis}
                  onChange={(e) => setIncludeBasis(e.target.checked)}
                />
                Ausgangsprodukte mitanzeigen
              </label>
              <button
                type="button"
                className="hauptknopf"
                onClick={suchen}
                disabled={loading}
              >
                {loading ? 'Sucht…' : `Empfehlungen zu ${basis.length} Produkten`}
              </button>
              <button type="button" className="beispiel" onClick={() => setBasis([])}>
                Auswahl leeren
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="meldung fehler" role="alert">
          <strong>Empfehlung fehlgeschlagen</strong>
          <pre>{error}</pre>
        </div>
      )}

      {result && !error && (
        <>
          {result.missing?.length > 0 && (
            <div className="meldung fehler">
              Ohne Vektor und deshalb nicht berücksichtigt:{' '}
              {result.missing.join(', ')}
            </div>
          )}

          <div className="zeitleiste">
            <span>
              <strong>{result.hits.length}</strong> Empfehlungen aus{' '}
              {result.basis.length} Ausgangsprodukten
            </span>
            <span className="zeiten">
              <span className="anteil">keine Embedding-API</span>
              <span className="trenner">·</span>
              <span title="Zentroid bilden und vergleichen, alles in Postgres">
                Datenbank {result.searchMs} ms
              </span>
            </span>
          </div>

          {result.hits.length === 0 ? (
            <p className="meldung leer">Keine Empfehlungen.</p>
          ) : (
            <ol className="trefferliste">
              {result.hits.map((hit, index) => (
                <ResultCard
                  key={hit.docId}
                  hit={hit}
                  rang={index + 1}
                  inBasis={basis.includes(hit.docId)}
                />
              ))}
            </ol>
          )}
        </>
      )}
    </>
  )
}
