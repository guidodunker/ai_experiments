import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatTicketFile, parseTicket, readTicket, setSection, writeTicket } from '../src/ticketfile.ts'
import { createTicket } from '../src/tickets.ts'

const SAMPLE = 'id: 3\nstatus: neu\ntitel: Suche\n\n## Beschreibung\nlangsam\n\n## Nachträge\n'

test('parseTicket trennt Kopf und Rumpf', () => {
  const ticket = parseTicket(SAMPLE)
  assert.equal(ticket.id, 3)
  assert.equal(ticket.header.get('status'), 'neu')
  assert.equal(ticket.body, '## Beschreibung\nlangsam\n\n## Nachträge\n')
})

test('parseTicket verträgt CRLF', () => {
  assert.equal(parseTicket(SAMPLE.replace(/\n/g, '\r\n')).header.get('titel'), 'Suche')
})

test('parseTicket ohne gültige id wirft', () => {
  assert.throws(() => parseTicket('status: neu\n\nx\n'), /id/)
})

test('formatTicketFile ergibt den Text eines neuen Tickets unverändert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  const thread = { id: '0', index: 0, top: { level: 1, text: 'Bug' }, replies: [] }
  const fields = { title: 'T', description: 'D', component: 'K', severity: 'hoch' as const }
  await createTicket(dir, thread, fields, new Date(2026, 10, 23, 9, 0, 0))
  const text = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.equal(formatTicketFile(parseTicket(text)), text)
})

test('Kopffeld ändern behält die Position, neues Feld kommt ans Ende', () => {
  const ticket = parseTicket(SAMPLE)
  ticket.header.set('status', 'analysiert')
  ticket.header.set('branch', 'bugfix/bug-3')
  assert.ok(formatTicketFile(ticket).startsWith('id: 3\nstatus: analysiert\ntitel: Suche\nbranch: bugfix/bug-3\n\n'))
})

test('setSection hängt einen neuen Abschnitt nach den Nachträgen an', () => {
  const body = parseTicket(SAMPLE).body
  assert.equal(
    setSection(body, 'Analyse', 'Ursache\n'),
    '## Beschreibung\nlangsam\n\n## Nachträge\n\n## Analyse\nUrsache\n',
  )
})

test('setSection ersetzt einen Abschnitt in der Mitte und am Ende', () => {
  const body = '## Nachträge\n\n## Analyse\nalt\n\n## Plan\np\n'
  assert.equal(setSection(body, 'Analyse', 'neu'), '## Nachträge\n\n## Analyse\nneu\n\n## Plan\np\n')
  assert.equal(setSection(body, 'Plan', 'q'), '## Nachträge\n\n## Analyse\nalt\n\n## Plan\nq\n')
})

test('writeTicket und readTicket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  await writeTicket(dir, parseTicket(SAMPLE))
  assert.equal(await readFile(join(dir, 'bug_3.txt'), 'utf8'), SAMPLE)
  assert.equal((await readTicket(dir, 3)).header.get('titel'), 'Suche')
})
