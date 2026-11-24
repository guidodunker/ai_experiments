import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubClient } from '../src/store/github-client.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = []
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    })
    const next = responses.shift()
    if (next === undefined) throw new Error('keine Antwort mehr vorbereitet')
    if (next instanceof Error) throw next
    return next
  }
  return { fetchFn, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const rawIssue = (number: number, extra: object = {}) => ({
  number,
  title: `T${number}`,
  body: 'B',
  labels: [{ name: 'bugfix-agent' }],
  html_url: `https://github.com/o/r/issues/${number}`,
  state: 'open',
  ...extra,
})

function client(responses: (Response | Error)[]) {
  const fake = fakeFetch(responses)
  const waits: number[] = []
  const api = githubClient('ghp_geheim', 'o/r', {
    fetch: fake.fetchFn,
    sleep: async (ms) => void waits.push(ms),
  })
  return { api, calls: fake.calls, waits }
}

test('Header mit Token und API-Version', async () => {
  const { api, calls } = client([json(200, { full_name: 'o/r' })])
  await api.getRepo()
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/o/r')
  assert.equal(calls[0]?.headers.Authorization, 'Bearer ghp_geheim')
  assert.equal(calls[0]?.headers['X-GitHub-Api-Version'], '2022-11-28')
})

test('503, dann Netzfehler, dann Erfolg: zwei Wiederholungen mit 1 s und 2 s', async () => {
  const { api, waits } = client([json(503, { message: 'down' }), new Error('ECONNRESET'), json(200, rawIssue(7))])
  const issue = await api.getIssue(7)
  assert.equal(issue?.number, 7)
  assert.deepEqual(waits, [1000, 2000])
})

test('Retry-After bestimmt die Wartezeit', async () => {
  const { api, waits } = client([json(429, { message: 'slow' }, { 'retry-after': '3' }), json(200, { full_name: 'o/r' })])
  await api.getRepo()
  assert.deepEqual(waits, [3000])
})

test('nach drei Wiederholungen Fehler mit letzter Ursache', async () => {
  const { api, calls } = client([503, 503, 503, 503].map((s) => json(s, { message: 'down' })))
  await assert.rejects(api.getRepo(), /GitHub GET \/repos\/o\/r: 503 down/)
  assert.equal(calls.length, 4)
})

test('401 sofort, ohne Token in der Meldung', async () => {
  const { api, calls } = client([json(401, { message: 'Bad credentials' })])
  await assert.rejects(api.getRepo(), (error: Error) => {
    assert.equal(error.message, 'GitHub GET /repos/o/r: 401 Bad credentials')
    assert.doesNotMatch(error.message, /ghp_geheim/)
    return true
  })
  assert.equal(calls.length, 1)
})

test('getIssue: 404 ergibt undefined, Labels als Namen', async () => {
  const { api } = client([json(404, { message: 'Not Found' }), json(200, rawIssue(7))])
  assert.equal(await api.getIssue(99), undefined)
  assert.deepEqual(await api.getIssue(7), {
    number: 7,
    title: 'T7',
    body: 'B',
    labels: ['bugfix-agent'],
    url: 'https://github.com/o/r/issues/7',
    open: true,
  })
})

test('listOpenIssues folgt dem Link-Header und lässt Pull Requests weg', async () => {
  const next = 'https://api.github.com/repositories/1/issues?labels=bugfix-agent&state=open&per_page=100&page=2'
  const { api, calls } = client([
    json(200, [rawIssue(1), rawIssue(2, { pull_request: {} })], { link: `<${next}>; rel="next", <${next}>; rel="last"` }),
    json(200, [rawIssue(3)]),
  ])
  const issues = await api.listOpenIssues('bugfix-agent')
  assert.deepEqual(
    issues.map((i) => i.number),
    [1, 3],
  )
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/o/r/issues?labels=bugfix-agent&state=open&per_page=100')
  assert.equal(calls[1]?.url, next)
})

test('listComments: Text, Zeit, Login', async () => {
  const { api } = client([
    json(200, [
      { body: 'x', created_at: '2026-11-24T09:00:00Z', user: { login: 'g' }, author_association: 'OWNER' },
      { body: 'y', created_at: '2026-11-24T09:01:00Z', user: null },
    ]),
  ])
  assert.deepEqual(await api.listComments(7), [
    { body: 'x', createdAt: '2026-11-24T09:00:00Z', login: 'g', association: 'OWNER' },
    { body: 'y', createdAt: '2026-11-24T09:01:00Z', login: 'unbekannt', association: 'NONE' },
  ])
})

test('ensureLabels legt nur fehlende an und merkt sich vorhandene', async () => {
  const { api, calls } = client([
    json(200, { name: 'bugfix-agent' }),
    json(404, { message: 'Not Found' }),
    json(201, { name: 'status:neu' }),
  ])
  await api.ensureLabels(['bugfix-agent', 'status:neu'])
  await api.ensureLabels(['bugfix-agent', 'status:neu'])
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET https://api.github.com/repos/o/r/labels/bugfix-agent',
      'GET https://api.github.com/repos/o/r/labels/status%3Aneu',
      'POST https://api.github.com/repos/o/r/labels',
    ],
  )
  assert.deepEqual(JSON.parse(calls[2]?.body ?? '{}'), { name: 'status:neu', color: 'ededed' })
})

test('createIssue, updateBody, setLabels, addComment senden die erwarteten Anfragen', async () => {
  const { api, calls } = client([json(201, rawIssue(7)), json(200, {}), json(200, []), json(201, {})])
  assert.equal((await api.createIssue({ title: 'T', body: 'B', labels: ['bugfix-agent'] })).number, 7)
  await api.updateBody(7, 'neu')
  await api.setLabels(7, ['bugfix-agent', 'status:analysiert'])
  await api.addComment(7, 'K')
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, JSON.parse(c.body ?? 'null')]),
    [
      ['POST', 'https://api.github.com/repos/o/r/issues', { title: 'T', body: 'B', labels: ['bugfix-agent'] }],
      ['PATCH', 'https://api.github.com/repos/o/r/issues/7', { body: 'neu' }],
      ['PUT', 'https://api.github.com/repos/o/r/issues/7/labels', { labels: ['bugfix-agent', 'status:analysiert'] }],
      ['POST', 'https://api.github.com/repos/o/r/issues/7/comments', { body: 'K' }],
    ],
  )
})
