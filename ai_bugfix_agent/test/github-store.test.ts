import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubStore } from '../src/store/github.ts'
import { parseBody, sectionComment } from '../src/store/github-format.ts'
import type { Thread } from '../src/types.ts'
import { fakeGitHub } from './helpers/fake-github.ts'

const NOW = new Date(2026, 10, 24, 9, 20, 59)
const thread: Thread = {
  id: '1795508455.866989',
  index: 0,
  top: { level: 1, text: 'Die Suche findet Müller nicht.' },
  replies: [],
}
const fields = { title: 'Suche findet Müller nicht', description: 'Umlaute.', component: 'Suche', severity: 'mittel' as const }

async function created() {
  const gh = fakeGitHub()
  const store = githubStore(gh.api)
  const result = await store.create(thread, fields, 'slack', NOW, 'https://x.slack.com/p1')
  return { gh, store, result }
}

test('Name, Bezeichnung und Branch', () => {
  const store = githubStore(fakeGitHub().api)
  assert.equal(store.kind, 'github')
  assert.equal(store.label(7), '#7')
  assert.equal(store.branch(7), 'bugfix/issue-7')
})

test('create: Labels, Body mit Kopfdaten, Nummer und URL', async () => {
  const { gh, result } = await created()
  assert.deepEqual(result, { id: 1, url: 'https://github.com/o/r/issues/1' })
  const issue = gh.issues.get(1)!
  assert.equal(issue.title, 'Suche findet Müller nicht')
  assert.deepEqual(issue.labels, ['bugfix-agent', 'status:neu', 'komponente:Suche', 'schweregrad:mittel'])
  assert.deepEqual([...gh.labels].sort(), ['bugfix-agent', 'komponente:Suche', 'schweregrad:mittel', 'status:neu'])
  assert.deepEqual(parseBody(issue.body, 1).meta, {
    erstellt: '2026-11-24T09:20:59',
    thread: '1795508455.866989',
    quelle: 'slack',
    link: 'https://x.slack.com/p1',
    komponente: 'Suche',
    schweregrad: 'mittel',
  })
  assert.match(issue.body, /## Originalmeldung\n> Die Suche findet Müller nicht\.\n$/)
})

test('appendReply: Kommentar mit Markierung; unbekannt oder fremd ergibt false', async () => {
  const { gh, store } = await created()
  assert.equal(await store.appendReply(1, { level: 2, text: 'Nur bei Umlauten.' }, NOW), true)
  assert.equal(gh.comments.get(1)?.[0]?.body, '<!-- bugfix-agent:nachtrag ebene=2 -->\nNur bei Umlauten.')
  assert.equal(await store.appendReply(99, { level: 2, text: 'x' }, NOW), false)
  gh.issues.set(50, { number: 50, title: 'fremd', body: '', labels: [], url: '', open: true })
  assert.equal(await store.appendReply(50, { level: 2, text: 'x' }, NOW), false)
})

test('read liefert das Ticket mit Status, Kopf und Nachträgen', async () => {
  const { store } = await created()
  await store.appendReply(1, { level: 2, text: 'Nur bei Umlauten.' }, NOW)
  const ticket = await store.read(1)
  assert.equal(ticket.header.get('status'), 'neu')
  assert.equal(ticket.header.get('thread'), '1795508455.866989')
  assert.match(ticket.body, /## Nachträge\n\n### .* \(Antwort, Ebene 2\)\nNur bei Umlauten\.\n$/)
})

test('applyResult: Status-Label getauscht, Felder im Body, Abschnitt als Kommentar, Handänderung bleibt', async () => {
  const { gh, store } = await created()
  gh.issues.get(1)!.body += '\nVon Hand ergänzt.\n'
  const ticket = await store.applyResult(1, {
    status: 'analysiert',
    fields: { branch: 'bugfix/issue-1', kosten_analyse: '0.53' },
    section: { heading: 'Analyse', text: '### Ursache\nX' },
    summary: '(0.53 $): X',
  })
  const issue = gh.issues.get(1)!
  assert.deepEqual(issue.labels, ['bugfix-agent', 'komponente:Suche', 'schweregrad:mittel', 'status:analysiert'])
  assert.ok(gh.labels.has('status:analysiert'))
  assert.equal(parseBody(issue.body, 1).meta.branch, 'bugfix/issue-1')
  assert.ok(issue.body.endsWith('\nVon Hand ergänzt.\n'))
  assert.equal(gh.comments.get(1)?.at(-1)?.body, sectionComment('Analyse', '### Ursache\nX'))
  assert.equal(ticket.header.get('status'), 'analysiert')
  assert.equal(ticket.header.get('kosten_analyse'), '0.53')
  assert.match(ticket.body, /## Analyse\n### Ursache\nX\n$/)
})

test('applyResult ohne Abschnitt und ohne Felder ändert nur das Label', async () => {
  const { gh, store } = await created()
  const before = gh.issues.get(1)!.body
  await store.applyResult(1, { status: 'neu', summary: '' })
  assert.equal(gh.issues.get(1)!.body, before)
  assert.equal(gh.comments.get(1), undefined)
})

test('list: nur offene Issues des Agenten, aufsteigend', async () => {
  const { gh, store } = await created()
  await store.create(thread, fields, 'slack', NOW)
  await store.create(thread, fields, 'slack', NOW)
  gh.issues.get(2)!.open = false
  gh.issues.set(10, { number: 10, title: 'fremd', body: '', labels: ['bug'], url: '', open: true })
  assert.deepEqual(await store.list(), [1, 3])
})

test('read eines fremden Issues wirft', async () => {
  const { gh, store } = await created()
  gh.issues.set(50, { number: 50, title: 'fremd', body: '', labels: [], url: '', open: true })
  await assert.rejects(store.read(50), /Issue #50 gibt es nicht oder es gehört nicht zum Agenten/)
})
