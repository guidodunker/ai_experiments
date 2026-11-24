import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diff } from '../src/diff.ts'
import { hashText } from '../src/state.ts'
import type { State, Thread } from '../src/types.ts'

const thread: Thread = {
  id: '0',
  index: 0,
  top: { level: 1, text: 'Bug' },
  replies: [{ level: 2, text: 'a' }, { level: 2, text: 'b' }],
}

test('unbekannter Thread ergibt NewThread und ein NewReply je Antwort', () => {
  const { events, warnings } = diff([thread], { threads: {} })
  assert.deepEqual(
    events.map((e) => (e.kind === 'NewReply' ? `reply:${e.replyIndex}` : e.kind)),
    ['NewThread', 'reply:0', 'reply:1'],
  )
  assert.deepEqual(warnings, [])
})

test('bekannter Thread liefert nur neue Antworten', () => {
  const state: State = { threads: { '0': { topHash: hashText('Bug'), replyCount: 1, ticket: 3 } } }
  const { events } = diff([thread], state)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.kind, 'NewReply')
  if (event?.kind === 'NewReply') assert.equal(event.reply.text, 'b')
})

test('nichts Neues ergibt keine Ereignisse', () => {
  const state: State = { threads: { '0': { topHash: hashText('Bug'), replyCount: 2, ticket: null } } }
  assert.deepEqual(diff([thread], state), { events: [], warnings: [] })
})

test('geänderter Top-Post mit Ticket ergibt Warnung statt Ereignissen', () => {
  const state: State = { threads: { '0': { topHash: hashText('anders'), replyCount: 0, ticket: 4 } } }
  const { events, warnings } = diff([thread], state)
  assert.deepEqual(events, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /Thread 0: Top-Post wurde geändert/)
})

test('geänderter Top-Post ohne Ticket wird mit allen Antworten neu bewertet', () => {
  const state: State = { threads: { '0': { topHash: hashText('Bu'), replyCount: 2, ticket: null } } }
  const { events, warnings } = diff([thread], state)
  assert.deepEqual(
    events.map((e) => (e.kind === 'NewReply' ? `reply:${e.replyIndex}` : e.kind)),
    ['NewThread', 'reply:0', 'reply:1'],
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /Thread 0: .*neu bewertet/)
})

test('Thread wird über id erkannt, auch wenn sich index verschiebt', () => {
  const moved: Thread = { ...thread, id: 'a', index: 5 }
  const state: State = { threads: { a: { topHash: hashText('Bug'), replyCount: 2, ticket: 1 } } }
  assert.deepEqual(diff([moved], state), { events: [], warnings: [] })
})
