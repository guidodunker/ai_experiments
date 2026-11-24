import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvent, ensureThread, hashText, loadState, saveState } from '../src/state.ts'
import type { State, Thread } from '../src/types.ts'

const thread: Thread = {
  id: '0',
  index: 0,
  top: { level: 1, text: 'Bug' },
  replies: [{ level: 2, text: 'a' }, { level: 2, text: 'b' }],
}

test('fehlende Zustandsdatei ergibt leeren Zustand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  assert.deepEqual(await loadState(join(dir, 'state.json')), { threads: {} })
})

test('Zustand übersteht Speichern und Laden', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  const path = join(dir, 'state.json')
  const state: State = { threads: { '1764000000.000100': { topHash: 'x', replyCount: 2, ticket: 7 } } }
  await saveState(path, state)
  assert.deepEqual(await loadState(path), state)
})

test('altes Array-Format wird zum Objekt mit der Position als Schlüssel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  const path = join(dir, 'state.json')
  const a = { topHash: 'a', replyCount: 1, ticket: 2 }
  const c = { topHash: 'c', replyCount: 0, ticket: null }
  await writeFile(path, JSON.stringify({ threads: [a, null, c] }))
  assert.deepEqual(await loadState(path), { threads: { '0': a, '2': c } })
})

test('ensureThread legt Eintrag an und liefert danach denselben', () => {
  const state: State = { threads: {} }
  const entry = ensureThread(state, thread)
  assert.deepEqual(entry, { topHash: hashText('Bug'), replyCount: 0, ticket: null })
  assert.equal(ensureThread(state, thread), entry)
  assert.deepEqual(Object.keys(state.threads), ['0'])
})

test('applyEvent bei NewThread übernimmt neuen Hash und setzt Antworten zurück', () => {
  const state: State = { threads: { '0': { topHash: hashText('B'), replyCount: 2, ticket: 9 } } }
  applyEvent(state, { kind: 'NewThread', thread })
  assert.deepEqual(state.threads['0'], { topHash: hashText('Bug'), replyCount: 0, ticket: 9 })
})

test('applyEvent zählt Antworten hoch', () => {
  const state: State = { threads: {} }
  applyEvent(state, { kind: 'NewThread', thread })
  applyEvent(state, { kind: 'NewReply', thread, reply: thread.replies[1]!, replyIndex: 1 })
  assert.equal(state.threads['0']?.replyCount, 2)
})
