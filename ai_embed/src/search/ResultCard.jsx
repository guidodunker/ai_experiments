/**
 * Ein Treffer. Zeigt bewusst die strukturierten Felder aus documents.meta und
 * nicht den eingebetteten Fließtext — so ist nachvollziehbar, worauf das Modell
 * angesprungen sein könnte.
 */
export function ResultCard({ hit, rang, onAdd, inBasis }) {
  // Kosinus-Distanz: 0 = identisch. Die Ähnlichkeit ist das Gegenstück davon
  // und lässt sich als Balken darstellen. Nur innerhalb eines Modells
  // aussagekräftig — zwischen Modellen sind die Zahlen nicht vergleichbar.
  const aehnlichkeit = Math.max(0, Math.min(1, 1 - hit.distance))

  return (
    <li className={`treffer${inBasis ? ' ist-basis' : ''}`}>
      <div className="rang">{rang}</div>

      <div className="inhalt">
        <div className="titelzeile">
          <h2>{hit.name}</h2>
          <span className={`preis preis-${hit.priceSegment}`}>
            {hit.priceSegment}
          </span>
          {inBasis && <span className="basis-marke">Ausgangsprodukt</span>}
        </div>

        <p className="pfad">
          <span className="doc-id" title="doc_id für die Empfehlungssuche">
            {hit.docId}
          </span>
          {hit.category} <span aria-hidden="true">›</span> {hit.subCategory}
          <span className="marke">{hit.brand}</span>
        </p>

        <ul className="merkmale">
          {hit.useCases.map((u) => (
            <li key={u} className="einsatz">
              {u}
            </li>
          ))}
          {hit.features.map((f) => (
            <li key={f} className="feature">
              {f}
            </li>
          ))}
        </ul>
      </div>

      <div className="rechts">
        <div
          className="distanz"
          title={`Kosinus-Distanz ${hit.distance.toFixed(4)} — kleiner ist näher. Nur innerhalb dieses Modells vergleichbar.`}
        >
          <div className="balken">
            <div
              className="fuellung"
              style={{ inlineSize: `${aehnlichkeit * 100}%` }}
            />
          </div>
          <span className="wert">{hit.distance.toFixed(3)}</span>
        </div>

        {onAdd && (
          <button
            type="button"
            className="hinzu"
            onClick={() => onAdd(hit.docId)}
            disabled={inBasis}
            title={
              inBasis
                ? 'Schon als Ausgangsprodukt gewählt'
                : 'Als Ausgangsprodukt für Empfehlungen übernehmen'
            }
          >
            {inBasis ? '✓' : '+'}
          </button>
        )}
      </div>
    </li>
  )
}
