import { test } from 'node:test'
import assert from 'node:assert/strict'
import { problemsFromServices, type ServiceStatus } from '../src/agent/serviceHealth.ts'

const base: ServiceStatus = {
  name: 'api',
  kind: 'process',
  state: 'ready',
  port: 4001,
  enabled: true,
}

test('a ready service is not a problem', () => {
  assert.deepEqual(problemsFromServices([base]), [])
})

test('a crashed service is reported with its exit code and logs', () => {
  const problems = problemsFromServices([
    { ...base, state: 'crashed', exitCode: 1, lastLogs: 'TypeError: x is not a function' },
  ])
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'service')
  assert.equal(problems[0].file, 'services/api')
  assert.match(problems[0].message, /exit code 1/)
  assert.match(problems[0].message, /TypeError/)
})

test('an enabled service that is not running is a problem', () => {
  const problems = problemsFromServices([{ ...base, state: 'stopped' }])
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /not running/)
})

test('a service still starting never became ready', () => {
  assert.match(
    problemsFromServices([{ ...base, state: 'starting' }])[0].message,
    /did not become ready/,
  )
})

test('a service the user disabled is left alone', () => {
  assert.deepEqual(problemsFromServices([{ ...base, state: 'stopped', enabled: false }]), [])
})

test('a failing container is infrastructure, not broken code', () => {
  const problems = problemsFromServices([{ ...base, kind: 'container', state: 'crashed' }])
  assert.equal(problems[0].kind, 'infra')
})
