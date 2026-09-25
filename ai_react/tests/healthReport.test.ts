import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReport,
  isAppBroken,
  signatureOf,
  type Problem,
} from '../src/agent/healthReport.ts'

const probe: Problem = { kind: 'probe', file: 'src/App.tsx', message: 'Failed to resolve import' }
const type6133: Problem = {
  kind: 'type',
  file: 'src/App.tsx',
  line: 3,
  col: 10,
  code: 'TS6133',
  message: "'x' is declared but its value is never read.",
}

test('type errors alone do not mean the app is broken', () => {
  assert.equal(isAppBroken([type6133]), false)
})

test('probe, runtime and hmr failures mean the app is broken', () => {
  assert.equal(isAppBroken([probe]), true)
  assert.equal(isAppBroken([{ kind: 'runtime', message: 'x is not a function' }]), true)
  assert.equal(isAppBroken([{ kind: 'hmr', message: 'parse error' }]), true)
  assert.equal(isAppBroken([type6133, probe]), true)
})

test('an empty problem list is not broken', () => {
  assert.equal(isAppBroken([]), false)
})

test('the signature ignores ordering', () => {
  assert.equal(signatureOf([probe, type6133]), signatureOf([type6133, probe]))
})

test('the signature changes when the problems change', () => {
  const moved: Problem = { ...type6133, line: 4 }
  assert.notEqual(signatureOf([type6133]), signatureOf([moved]))
})

test('the report names file, line and code, and tells the model what to do', () => {
  const report = buildReport([type6133], 1, 3)
  assert.match(report, /attempt 1 of 3/)
  assert.match(report, /src\/App\.tsx\(3,10\)/)
  assert.match(report, /TS6133/)
  assert.match(report, /build is broken/)
})

test('a crashed service breaks the app, infrastructure failures do not', () => {
  assert.equal(isAppBroken([{ kind: 'service', message: 'crashed' }]), true)
  assert.equal(isAppBroken([{ kind: 'infra', message: 'docker daemon unreachable' }]), false)
})

test('the report labels service problems', () => {
  const report = buildReport(
    [{ kind: 'service', file: 'services/api', message: 'exit code 1' }],
    1,
    3,
  )
  assert.match(report, /SERVICE FAILED/)
})

test('a broken app gets the rollback warning, a build error does not', () => {
  assert.match(buildReport([probe], 2, 3), /rolled back/)
  assert.doesNotMatch(buildReport([type6133], 2, 3), /rolled back/)
})
