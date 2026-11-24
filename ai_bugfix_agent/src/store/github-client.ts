import type { CommentData, IssueData } from './github-format.ts'
import type { GitHubApi } from './github.ts'

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export type ClientOptions = {
  fetch?: Fetch
  sleep?: (ms: number) => Promise<void>
}

const BASE = 'https://api.github.com'
const BACKOFF_MS = [1000, 2000, 4000]

type RawIssue = {
  number: number
  title: string
  body: string | null
  labels: ({ name?: string } | string)[]
  html_url: string
  state: string
  pull_request?: unknown
}
type RawComment = { body?: string | null; created_at: string; user: { login: string } | null }

function toIssue(raw: RawIssue): IssueData {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    labels: raw.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    url: raw.html_url,
    open: raw.state === 'open',
  }
}

function nextLink(header: string | null): string | undefined {
  return header?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
}

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === 'string' ? body.message : ''
  } catch {
    return ''
  }
}

export function githubClient(token: string, repo: string, options: ClientOptions = {}): GitHubApi {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const knownLabels = new Set<string>()

  /**
   * Wiederholt bei Netzfehlern, 5xx, 429 und 403 mit Rate-Limit dreimal.
   * Statuscodes in `accept` gelten nicht als Fehler (z. B. 404 beim Lesen).
   */
  async function call(method: string, pathOrUrl: string, body?: unknown, accept: number[] = []): Promise<Response> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${BASE}${pathOrUrl}`
    const where = `GitHub ${method} ${url.replace(BASE, '')}`
    for (let attempt = 0; ; attempt++) {
      let failure: string
      let wait = BACKOFF_MS[attempt] ?? 4000
      try {
        const response = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (response.ok || accept.includes(response.status)) return response
        const retryAfter = response.headers.get('retry-after')
        const rateLimited =
          response.status === 429 ||
          (response.status === 403 && (retryAfter !== null || response.headers.get('x-ratelimit-remaining') === '0'))
        failure = `${response.status} ${await messageOf(response)}`.trimEnd()
        if (response.status < 500 && !rateLimited) throw new Error(`${where}: ${failure}`)
        if (retryAfter !== null && Number.isFinite(Number(retryAfter))) wait = Number(retryAfter) * 1000
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(where)) throw error
        failure = `Netzfehler: ${error instanceof Error ? error.message : String(error)}`
      }
      if (attempt >= BACKOFF_MS.length) throw new Error(`${where}: ${failure}`)
      await sleep(wait)
    }
  }

  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = path
    while (next !== undefined) {
      const response = await call('GET', next)
      items.push(...((await response.json()) as T[]))
      next = nextLink(response.headers.get('link'))
    }
    return items
  }

  const issuePath = (number: number) => `/repos/${repo}/issues/${number}`

  return {
    repo,
    async getRepo() {
      await call('GET', `/repos/${repo}`)
    },
    async ensureLabels(names) {
      for (const name of names) {
        if (knownLabels.has(name)) continue
        const found = await call('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`, undefined, [404])
        // 422: Ein paralleler Lauf hat das Label gerade angelegt.
        if (found.status === 404) await call('POST', `/repos/${repo}/labels`, { name, color: 'ededed' }, [422])
        knownLabels.add(name)
      }
    },
    async createIssue(input) {
      return toIssue((await (await call('POST', `/repos/${repo}/issues`, input)).json()) as RawIssue)
    },
    async getIssue(number) {
      const response = await call('GET', issuePath(number), undefined, [404])
      return response.status === 404 ? undefined : toIssue((await response.json()) as RawIssue)
    },
    async updateBody(number, body) {
      await call('PATCH', issuePath(number), { body })
    },
    async setLabels(number, labels) {
      await call('PUT', `${issuePath(number)}/labels`, { labels })
    },
    async listComments(number) {
      const raw = await all<RawComment>(`${issuePath(number)}/comments?per_page=100`)
      return raw.map(
        (c): CommentData => ({ body: c.body ?? '', createdAt: c.created_at, login: c.user?.login ?? 'unbekannt' }),
      )
    },
    async addComment(number, body) {
      await call('POST', `${issuePath(number)}/comments`, { body })
    },
    async listOpenIssues(label) {
      const raw = await all<RawIssue>(`/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`)
      return raw.filter((issue) => issue.pull_request === undefined).map(toIssue)
    },
  }
}
