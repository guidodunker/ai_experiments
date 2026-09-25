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

export const postSearch = (query, k) => post('/api/search', { query, k })

export const postRecommend = (docIds, k, includeBasis) =>
  post('/api/recommend', { docIds, k, includeBasis })
