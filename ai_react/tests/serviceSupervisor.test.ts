import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcilePlan } from '../server/services/supervisor.ts'

const declared = (name: string, enabled = true) => ({ name, enabled })

test('a declared service that is not running gets started', () => {
  assert.deepEqual(reconcilePlan([declared('api')], []), { toStart: ['api'], toStop: [] })
})

test('a running service that is no longer declared gets stopped', () => {
  // This is what makes rollback work: the manifest is gone, so the service dies.
  assert.deepEqual(reconcilePlan([], ['api']), { toStart: [], toStop: ['api'] })
})

test('a matching pair is left alone', () => {
  assert.deepEqual(reconcilePlan([declared('api')], ['api']), { toStart: [], toStop: [] })
})

test('a disabled service is never started, and is stopped if it runs', () => {
  assert.deepEqual(reconcilePlan([declared('api', false)], []), { toStart: [], toStop: [] })
  assert.deepEqual(reconcilePlan([declared('api', false)], ['api']), {
    toStart: [],
    toStop: ['api'],
  })
})

test('mixed state is handled in one pass', () => {
  assert.deepEqual(
    reconcilePlan([declared('a'), declared('b'), declared('c', false)], ['b', 'orphan']),
    { toStart: ['a'], toStop: ['orphan'] },
  )
})
