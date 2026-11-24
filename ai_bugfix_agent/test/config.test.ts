import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chooseChat, slackReplyFromEnv } from '../src/sources/config.ts'

const ROOT = join('projekt', 'agent')
const log = () => {}
const SLACK = { CHAT_SOURCE: 'slack', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_CHANNEL_ID: 'CBUGS' }

test('ohne CHAT_SOURCE: Datei chat.txt und state.json', () => {
  const chat = chooseChat({}, ROOT, log)
  assert.ok(!('error' in chat))
  assert.equal(chat.source.name, 'datei')
  assert.equal(chat.source.label, join(ROOT, 'chat.txt'))
  assert.equal(chat.statePath, join(ROOT, 'state.json'))
  assert.equal(chat.link, undefined)
})

test('CHAT_FILE wählt eine andere Datei', () => {
  const chat = chooseChat({ CHAT_FILE: 'demo-chat.txt' }, ROOT, log)
  assert.ok(!('error' in chat))
  assert.equal(chat.source.label, 'demo-chat.txt')
})

test('slack mit allen Variablen: Slack-Quelle und state.slack.json', () => {
  const chat = chooseChat(SLACK, ROOT, log)
  assert.ok(!('error' in chat))
  assert.equal(chat.source.name, 'slack')
  assert.equal(chat.source.label, 'Slack-Channel CBUGS')
  assert.equal(chat.statePath, join(ROOT, 'state.slack.json'))
  assert.equal(typeof chat.link, 'function')
})

test('slack ohne Variable nennt sie', () => {
  assert.deepEqual(chooseChat({ ...SLACK, SLACK_APP_TOKEN: ' ' }, ROOT, log), {
    error: 'SLACK_APP_TOKEN fehlt. Trage es in .env ein (siehe .env.example).',
  })
})

test('unbekannte Quelle', () => {
  assert.deepEqual(chooseChat({ CHAT_SOURCE: 'teams' }, ROOT, log), {
    error: 'CHAT_SOURCE=teams ist unbekannt. Erlaubt: datei, slack.',
  })
})

test('slackReplyFromEnv braucht Bot-Token und Channel', () => {
  assert.equal(slackReplyFromEnv({ SLACK_BOT_TOKEN: 'xoxb-1' }), undefined)
  assert.equal(typeof slackReplyFromEnv(SLACK), 'function')
})
