import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toThreads, type SlackMessage } from '../src/sources/slack-threads.ts'

const ME = { userId: 'UBOT', botId: 'BBOT' }
const msg = (ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  ts,
  text,
  user: 'U1',
  ...extra,
})

test('Top-Posts nach ts sortiert, Antworten als Ebene 2, ID ist ts', () => {
  const history = [msg('1764000002.000000', 'B'), msg('1764000001.000000', 'A', { reply_count: 2 })]
  const replies = new Map([
    [
      '1764000001.000000',
      [msg('1764000001.000000', 'A'), msg('1764000004.000000', 'a2'), msg('1764000003.000000', 'a1')],
    ],
  ])
  assert.deepEqual(toThreads(history, replies, ME), [
    {
      id: '1764000001.000000',
      index: 0,
      top: { level: 1, text: 'A', author: 'U1' },
      replies: [
        { level: 2, text: 'a1', author: 'U1' },
        { level: 2, text: 'a2', author: 'U1' },
      ],
    },
    { id: '1764000002.000000', index: 1, top: { level: 1, text: 'B', author: 'U1' }, replies: [] },
  ])
})

test('eigene Nachrichten fallen weg, über user und über bot_id', () => {
  const history = [msg('1.000001', 'Bug', { reply_count: 3 })]
  const replies = new Map([
    [
      '1.000001',
      [
        msg('1.000002', 'Ticket angelegt', { user: 'UBOT' }),
        msg('1.000003', 'Status', { user: undefined, bot_id: 'BBOT' }),
        msg('1.000004', 'Danke'),
      ],
    ],
  ])
  assert.deepEqual(toThreads(history, replies, ME)[0]?.replies, [{ level: 2, text: 'Danke', author: 'U1' }])
})

test('Top-Post vom eigenen Bot fehlt samt Thread', () => {
  assert.deepEqual(toThreads([msg('1.000001', 'Hallo', { user: 'UBOT' })], new Map(), ME), [])
})

test('Systemnachrichten fallen weg, Meldungen mit Anhang bleiben', () => {
  const history = [
    msg('1.000001', 'ist beigetreten', { subtype: 'channel_join' }),
    msg('1.000002', 'Screenshot vom Fehler', { subtype: 'file_share' }),
  ]
  assert.deepEqual(
    toThreads(history, new Map(), ME).map((t) => t.top.text),
    ['Screenshot vom Fehler'],
  )
})

test('thread_broadcast zählt nur als Antwort, nicht als Top-Post', () => {
  const history = [
    msg('1.000001', 'Bug', { reply_count: 1 }),
    msg('1.000002', 'auch im Channel', { subtype: 'thread_broadcast' }),
  ]
  const replies = new Map([['1.000001', [msg('1.000002', 'auch im Channel', { subtype: 'thread_broadcast' })]]])
  const threads = toThreads(history, replies, ME)
  assert.equal(threads.length, 1)
  assert.deepEqual(threads[0]?.replies, [{ level: 2, text: 'auch im Channel', author: 'U1' }])
})

test('Nachricht ohne user hat keinen author', () => {
  const threads = toThreads([{ ts: '1.000001', text: 'Bug' }], new Map(), ME)
  assert.equal('author' in threads[0]!.top, false)
})

test('fehlende Bot-ID filtert keine fremden Nachrichten', () => {
  const threads = toThreads([msg('1.000001', 'Bug')], new Map(), { userId: 'UBOT', botId: '' })
  assert.equal(threads.length, 1)
})
