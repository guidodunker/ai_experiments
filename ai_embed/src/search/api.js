/** Alle Zugriffe auf das Dev-Server-Backend an einer Stelle. */

async function json(url, options) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

function post(url, body) {
  return json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const getStatus = () => json('/api/status')

export const getProducts = () => json('/api/products')

export const postSearch = (query, k, engine, textBoost) =>
  post('/api/search', { query, k, engine, textBoost })

export const postRecommend = (docIds, k, includeBasis, engine) =>
  post('/api/recommend', { docIds, k, includeBasis, engine })

/** Anzeigename und Erklärung je Suchmaschine. */
export const ENGINES = {
  pgvector: {
    label: 'pgvector',
    title: 'Postgres + pgvector: exakter Vergleich gegen jeden Vektor (Seq-Scan)',
  },
  elasticsearch: {
    label: 'Elasticsearch',
    title: 'Elasticsearch: kNN-Suche auf einem HNSW-Index (approximiert)',
  },
  hybrid: {
    label: 'ES hybrid',
    title:
      'Elasticsearch: Volltext (BM25) und kNN in einem Request, Scores addiert',
  },
}

/** Gewicht des BM25-Anteils bei der hybriden Suche; 0 = reines kNN. */
export const TEXT_BOOSTS = [0, 0.05, 0.1, 0.2, 0.5, 1]
