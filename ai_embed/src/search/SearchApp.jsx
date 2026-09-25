import { useCallback, useEffect, useState } from 'react'
import { getProducts, getStatus } from './api.js'
import { TextSearch } from './TextSearch.jsx'
import { Recommend } from './Recommend.jsx'
import './search.css'

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
        <TextSearch basis={basis} onAdd={addToBasis} />
      ) : (
        <Recommend
          products={products}
          basis={basis}
          setBasis={setBasis}
          onRemove={removeFromBasis}
        />
      )}
    </main>
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
