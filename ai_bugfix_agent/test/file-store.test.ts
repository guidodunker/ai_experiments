import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStore } from '../src/store/file.ts'
import type { Thread } from '../src/types.ts'

const NOW = new Date(2026, 10, 24, 9, 0, 0)
const thread: Thread = { id: '0', index: 0, top: { level: 1, text: 'Suche langsam' }, replies: [] }
const fields = { title: 'Suche langsam', description: 'D', component: 'Suche', severity: 'mittel' as const }

async function store() {
  const dir = join(await mkdtemp(join(tmpdir(), 'bugagent-store-')), 'tickets')
  return { dir, store: fileStore(dir) }
}

test('Name, Bezeichnung und Branch', async () => {
  const { store: s } = await store()
  assert.equal(s.kind, 'datei')
  assert.equal(s.label(5), 'bug-5')
  assert.equal(s.branch(5), 'bugfix/bug-5')
})

test('create schreibt bug_N.txt und liefert die Nummer ohne URL', async () => {
  const { dir, store: s } = await store()
  assert.deepEqual(await s.create(thread, fields, 'datei', NOW), { id: 1 })
  assert.match(await readFile(join(dir, 'bug_1.txt'), 'utf8'), /^titel: Suche langsam$/m)
})

test('appendReply, list und read', async () => {
  const { store: s } = await store()
  await s.create(thread, fields, 'slack', NOW, 'https://x/p1')
  assert.equal(await s.appendReply(1, { level: 2, text: 'ab 1000 Treffern' }, NOW), true)
  assert.equal(await s.appendReply(9, { level: 2, text: 'x' }, NOW), false)
  assert.deepEqual(await s.list(), [1])
  const ticket = await s.read(1)
  assert.equal(ticket.header.get('link'), 'https://x/p1')
  assert.match(ticket.body, /\(Antwort, Ebene 2\)\nab 1000 Treffern\n$/)
})

test('applyResult setzt Status und Felder, hängt Abschnitt an, liefert das neue Ticket', async () => {
  const { dir, store: s } = await store()
  await s.create(thread, fields, 'datei', NOW)
  const updated = await s.applyResult(1, {
    status: 'analysiert',
    fields: { branch: 'bugfix/bug-1' },
    section: { heading: 'Analyse', text: 'Ursache X' },
    summary: '',
  })
  assert.equal(updated.header.get('status'), 'analysiert')
  assert.equal(updated.header.get('branch'), 'bugfix/bug-1')
  const text = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.match(text, /^status: analysiert$/m)
  assert.match(text, /## Analyse\nUrsache X\n$/)
})
