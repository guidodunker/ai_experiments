import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileReply, fileSource } from '../src/sources/file.ts'

test('fileSource liest chat.txt als Threads mit Position als id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  await writeFile(join(dir, 'chat.txt'), '> A\n>> a\n> B\n')
  const source = fileSource(join(dir, 'chat.txt'))
  assert.equal(source.name, 'datei')
  const threads = await source.readThreads()
  assert.notEqual(threads, 'missing')
  if (threads !== 'missing') assert.deepEqual(threads.map((t) => [t.id, t.top.text]), [['0', 'A'], ['1', 'B']])
})

test('fileSource meldet fehlende Datei als missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  assert.equal(await fileSource(join(dir, 'chat.txt')).readThreads(), 'missing')
})

test('fileReply schreibt die Antwort ins Log', async () => {
  const logs: string[] = []
  await fileReply((m) => logs.push(m))('3', 'Ticket bug-1 angelegt: X (Y, hoch)')
  assert.deepEqual(logs, ['Antwort an Thread 3: Ticket bug-1 angelegt: X (Y, hoch)'])
})
