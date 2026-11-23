import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendToTicket,
  createTicket,
  formatTimestamp,
  listTicketIds,
  nextTicketNumber,
} from '../src/tickets.ts'
import type { Thread } from '../src/types.ts'

const NOW = new Date(2026, 10, 20, 15, 42, 5)
const thread: Thread = { index: 4, top: { level: 1, text: 'Die Suche funktioniert sehr langsam.' }, replies: [] }
const fields = {
  title: 'Suche reagiert sehr langsam',
  description: 'Nutzer meldet, dass die Suche sehr langsam ist.',
  component: 'Suche',
  severity: 'mittel' as const,
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bugagent-'))
}

test('formatTimestamp: lokale Zeit ohne Zeitzone', () => {
  assert.equal(formatTimestamp(NOW), '2026-11-20T15:42:05')
})

test('nextTicketNumber: fehlendes Verzeichnis ergibt 1', async () => {
  assert.equal(await nextTicketNumber(join(await tempDir(), 'tickets')), 1)
})

test('nextTicketNumber: höchste Nummer + 1, Lücken und fremde Dateien egal', async () => {
  const dir = await tempDir()
  for (const name of ['bug_2.txt', 'bug_7.txt', 'notiz.txt', 'bug_x.txt']) {
    await writeFile(join(dir, name), '')
  }
  assert.equal(await nextTicketNumber(dir), 8)
})

test('createTicket schreibt das Ticketformat', async () => {
  const dir = join(await tempDir(), 'tickets')
  const id = await createTicket(dir, thread, fields, NOW)
  assert.equal(id, 1)
  assert.equal(
    await readFile(join(dir, 'bug_1.txt'), 'utf8'),
    [
      'id: 1',
      'status: neu',
      'erstellt: 2026-11-20T15:42:05',
      'thread: 4',
      'titel: Suche reagiert sehr langsam',
      'komponente: Suche',
      'schweregrad: mittel',
      '',
      '## Beschreibung',
      'Nutzer meldet, dass die Suche sehr langsam ist.',
      '',
      '## Originalmeldung',
      '> Die Suche funktioniert sehr langsam.',
      '',
      '## Nachträge',
      '',
    ].join('\n'),
  )
})

test('createTicket: Zeilenumbrüche im Titel werden zu Leerzeichen', async () => {
  const dir = await tempDir()
  await createTicket(dir, thread, { ...fields, title: 'Zeile\neins' }, NOW)
  assert.match(await readFile(join(dir, 'bug_1.txt'), 'utf8'), /^titel: Zeile eins$/m)
})

test('appendToTicket hängt einen Nachtrag an', async () => {
  const dir = await tempDir()
  await createTicket(dir, thread, fields, NOW)
  const ok = await appendToTicket(dir, 1, { level: 2, text: 'Tritt ab 1000 Treffern auf.' }, NOW)
  assert.equal(ok, true)
  const content = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.ok(
    content.endsWith('## Nachträge\n\n### 2026-11-20T15:42:05 (Antwort, Ebene 2)\nTritt ab 1000 Treffern auf.\n'),
    content,
  )
})

test('appendToTicket: unbekanntes Ticket ergibt false', async () => {
  assert.equal(await appendToTicket(await tempDir(), 99, { level: 2, text: 'x' }, NOW), false)
})

test('listTicketIds: aufsteigend, fremde Dateien egal, fehlendes Verzeichnis leer', async () => {
  const dir = await tempDir()
  for (const name of ['bug_10.txt', 'bug_2.txt', 'notiz.txt']) await writeFile(join(dir, name), '')
  assert.deepEqual(await listTicketIds(dir), [2, 10])
  assert.deepEqual(await listTicketIds(join(dir, 'fehlt')), [])
})

test('appendToTicket: Nachtrag landet vor einem späteren Abschnitt', async () => {
  const dir = await tempDir()
  await createTicket(dir, thread, fields, NOW)
  await appendFile(join(dir, 'bug_1.txt'), '\n## Analyse\nUrsache X\n')
  await appendToTicket(dir, 1, { level: 2, text: 'erster' }, NOW)
  await appendToTicket(dir, 1, { level: 3, text: 'zweiter' }, NOW)
  const content = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.ok(
    content.endsWith(
      '## Nachträge\n\n' +
        '### 2026-11-20T15:42:05 (Antwort, Ebene 2)\nerster\n\n' +
        '### 2026-11-20T15:42:05 (Antwort, Ebene 3)\nzweiter\n\n' +
        '## Analyse\nUrsache X\n',
    ),
    content,
  )
})
