import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTscOutput } from '../server/tscCheck.ts'

test('parses diagnostics into structured entries', () => {
  const stdout = [
    "src/App.tsx(12,7): error TS2304: Cannot find name 'x'.",
    "src/components/TodoList.tsx(3,10): error TS6133: 'unused' is declared but its value is never read.",
    '',
    'Found 2 errors in 2 files.',
  ].join('\n')

  const diagnostics = parseTscOutput(stdout)

  assert.equal(diagnostics.length, 2)
  assert.deepEqual(diagnostics[0], {
    file: 'src/App.tsx',
    line: 12,
    col: 7,
    code: 'TS2304',
    message: "Cannot find name 'x'.",
  })
  assert.equal(diagnostics[1].code, 'TS6133')
})

test('normalises Windows path separators', () => {
  const diagnostics = parseTscOutput('src\\components\\A.tsx(1,1): error TS1005: expected.')
  assert.equal(diagnostics[0].file, 'src/components/A.tsx')
})

test('returns nothing for clean output', () => {
  assert.deepEqual(parseTscOutput('\n'), [])
  assert.deepEqual(parseTscOutput(''), [])
})

test('ignores summary and warning lines', () => {
  assert.deepEqual(parseTscOutput('Found 0 errors.\nsrc/A.tsx(1,1): warning TS0000: nope.'), [])
})
