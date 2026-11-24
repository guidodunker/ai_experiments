import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { slackReply, slackSource, type SlackApi, type SlackEvents, type SlackPage } from '../src/sources/slack.ts'
import type { SlackMessage } from '../src/sources/slack-threads.ts'

function fakeApi(history: SlackPage[], replies: Record<string, SlackPage[]> = {}) {
  const calls: string[] = []
  const posts: [string, string][] = []
  const pageAt = (pages: SlackPage[], cursor?: string): SlackPage => pages[cursor === undefined ? 0 : Number(cursor)]!
  const api: SlackApi = {
    channel: 'CBUGS',
    whoAmI: async () => (calls.push('whoAmI'), { userId: 'UBOT', botId: 'BBOT' }),
    history: async (cursor) => (calls.push(`history:${cursor ?? ''}`), pageAt(history, cursor)),
    replies: async (ts, cursor) => (calls.push(`replies:${ts}:${cursor ?? ''}`), pageAt(replies[ts]!, cursor)),
    post: async (threadTs, text) => {
      posts.push([threadTs, text])
    },
  }
  return { api, calls, posts }
}

const m = (ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  ts,
  text,
  user: 'U1',
  ...extra,
})
const noEvents: SlackEvents = { start: () => {} }

test('readThreads folgt den Seiten von History und Replies', async () => {
  const { api } = fakeApi(
    [
      { messages: [m('1.000002', 'B')], nextCursor: '1' },
      { messages: [m('1.000001', 'A', { reply_count: 2 })] },
    ],
    {
      '1.000001': [
        { messages: [m('1.000001', 'A'), m('1.000003', 'a1')], nextCursor: '1' },
        { messages: [m('1.000004', 'a2')], nextCursor: '' },
      ],
    },
  )
  const threads = await slackSource(api, noEvents).readThreads()
  assert.notEqual(threads, 'missing')
  if (threads === 'missing') return
  assert.deepEqual(
    threads.map((t) => [t.id, t.top.text, t.replies.map((r) => r.text)]),
    [
      ['1.000001', 'A', ['a1', 'a2']],
      ['1.000002', 'B', []],
    ],
  )
})

test('auth.test nur einmal, Replies nur bei reply_count > 0', async () => {
  const { api, calls } = fakeApi([{ messages: [m('1.000001', 'A'), m('1.000002', 'B', { reply_count: 0 })] }])
  const source = slackSource(api, noEvents)
  await source.readThreads()
  await source.readThreads()
  assert.deepEqual(calls, ['whoAmI', 'history:', 'history:'])
})

test('Name und Label der Quelle', () => {
  const source = slackSource(fakeApi([]).api, noEvents)
  assert.equal(source.name, 'slack')
  assert.equal(source.label, 'Slack-Channel CBUGS')
})

test('watch: Nachrichten aus dem Channel lösen entprellt genau einmal aus, andere Channels nicht', async () => {
  let handlers: Parameters<SlackEvents['start']>[0] | undefined
  const events: SlackEvents = { start: (h) => (handlers = h) }
  let changes = 0
  slackSource(fakeApi([]).api, events, 20).watch(() => changes++)
  handlers!.message('CBUGS')
  handlers!.message('CBUGS')
  handlers!.message('CANDERS')
  await sleep(60)
  assert.equal(changes, 1)
  handlers!.message('CANDERS')
  await sleep(60)
  assert.equal(changes, 1)
})

test('watch: jedes Verbinden löst einen Lauf aus', async () => {
  let handlers: Parameters<SlackEvents['start']>[0] | undefined
  const events: SlackEvents = { start: (h) => (handlers = h) }
  let changes = 0
  slackSource(fakeApi([]).api, events, 20).watch(() => changes++)
  handlers!.connected()
  await sleep(60)
  handlers!.connected()
  await sleep(60)
  assert.equal(changes, 2)
})

test('slackReply postet in den Thread', async () => {
  const { api, posts } = fakeApi([])
  await slackReply(api)('1.000001', 'Ticket bug-1 angelegt: X (Y, hoch)')
  assert.deepEqual(posts, [['1.000001', 'Ticket bug-1 angelegt: X (Y, hoch)']])
})
