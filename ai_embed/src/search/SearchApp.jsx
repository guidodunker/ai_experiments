import { useCallback, useEffect, useState } from 'react'
import { ENGINES, getProducts, getStatus } from './api.js'
import { TextSearch } from './TextSearch.jsx'
import { Recommend } from './Recommend.jsx'
import './search.css'

const ENGINE_KEY = 'ai_embed.engine'

/** Gewählte Suchmaschine überlebt ein Neuladen; ohne Storage eben pgvector. */
function readEngine() {
  try {
    const stored = localStorage.getItem(ENGINE_KEY)
    return stored in ENGINES ? stored : 'pgvector'
  } catch {
    return 'pgvector'
  }
}

/**
 * Hülle für beide Suchen. Die Auswahl der Ausgangsprodukte liegt hier und nicht
 * in Recommend, damit aus einem Treffer der Textsuche direkt ein Ausgangsprodukt
 * für die Empfehlung werden kann.
 */
export function SearchApp() {
  const [tab, setTab] = useState('text')
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState(null)
  const [products, setProducts] = useState([])
  const [basis, setBasis] = useState([])
  const [engine, setEngine] = useState(readEngine)

  const chooseEngine = useCallback((next) => {
    setEngine(next)
    try {
      localStorage.setItem(ENGINE_KEY, next)
    } catch {
      // Storage gesperrt: Auswahl gilt dann nur bis zum Neuladen.
    }
  }, [])

  useEffect(() => {
    getStatus().then(setStatus).catch((e) => setStatusError(e.message))
    getProducts()
      .then((d) => setProducts(d.products))
      .catch(() => setProducts([]))
  }, [])

  const addToBasis = useCallback((docId) => {
    setBasis((current) =>
      current.includes(docId) ? current : [...current, docId],
    )
    setTab('empfehlung')
  }, [])

  const removeFromBasis = useCallback((docId) => {
    setBasis((current) => current.filter((id) => id !== docId))
  }, [])

  return (
    <main className="suche">
      <header className="kopf">
        <h1>Produktsuche</h1>
        <ModellZeile status={status} fehler={statusError} />
        <EngineSchalter engine={engine} onChange={chooseEngine} status={status} />
      </header>

      <nav className="reiter" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'text'}
          className={tab === 'text' ? 'aktiv' : ''}
          onClick={() => setTab('text')}
        >
          Textsuche
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'empfehlung'}
          className={tab === 'empfehlung' ? 'aktiv' : ''}
          onClick={() => setTab('empfehlung')}
        >
          Empfehlungen
          {basis.length > 0 && <span className="zaehler">{basis.length}</span>}
        </button>
      </nav>

      {tab === 'text' ? (
        <TextSearch basis={basis} onAdd={addToBasis} engine={engine} />
      ) : (
        <Recommend
          engine={engine}
          products={products}
          basis={basis}
          setBasis={setBasis}
          onRemove={removeFromBasis}
        />
      )}
    </main>
  )
}

/**
 * Umschalter zwischen den Suchmaschinen. Der Query-Vektor kommt in beiden
 * Fällen vom selben Modell; verglichen wird nur, wer rankt.
 */
function EngineSchalter({ engine, onChange, status }) {
  const es = status?.elasticsearch

  return (
    <div className="engine">
      <div className="engine-wahl" role="radiogroup" aria-label="Suchmaschine">
        {Object.entries(ENGINES).map(([key, { label, title }]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={engine === key}
            className={engine === key ? 'aktiv' : ''}
            title={title}
            onClick={() => onChange(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {engine === 'elasticsearch' && es && (
        es.available ? (
          <span className="engine-info">
            Index <code>{es.index}</code> · {es.documents} Dokumente ·{' '}
            {es.dims === null ? (
              <span className="warntext">kein Feld {es.field}, sync.ts laufen lassen</span>
            ) : (
              <code>{es.indexType}</code>
            )}
          </span>
        ) : (
          <pre className="engine-info warntext">{es.reason}</pre>
        )
      )}
    </div>
  )
}

function ModellZeile({ status, fehler }) {
  if (fehler) {
    return <p className="modellzeile warnung">Backend nicht erreichbar: {fehler}</p>
  }
  if (!status) return <p className="modellzeile">lädt…</p>
  if (!status.ready) {
    return (
      <p className="modellzeile warnung">
        Für <code>{status.model}</code> liegen keine Vektoren im Korpus — erst
        indexieren.
      </p>
    )
  }
  return (
    <p className="modellzeile">
      Modell <code>{status.modelId}</code> · {status.dim} Dimensionen ·{' '}
      {status.vectors} von {status.documents} Produkten indexiert
    </p>
  )
}
