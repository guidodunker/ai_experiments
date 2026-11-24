import { test } from 'node:test'
import assert from 'node:assert/strict'
import { socketModeEvents, webApiClient } from '../src/sources/slack-client.ts'

// Prüft nur, dass sich die CommonJS-Pakete laden lassen. Es wird nichts gesendet.
test('webApiClient und socketModeEvents lassen sich ohne Netz anlegen', () => {
  const api = webApiClient('xoxb-test', 'CBUGS')
  assert.equal(api.channel, 'CBUGS')
  assert.equal(typeof socketModeEvents('xapp-test', () => {}).start, 'function')
})
