import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSerialRunner } from '../src/watch.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('Auslöser während eines Laufs ergeben genau einen weiteren Lauf', async () => {
  let runs = 0
  const gate = deferred()
  const trigger = createSerialRunner(async () => {
    runs++
    if (runs === 1) await gate.promise
  }, () => {})

  const first = trigger()
  void trigger()
  void trigger()
  gate.resolve()
  await first
  assert.equal(runs, 2)
})

test('ein Fehler stoppt den Runner nicht', async () => {
  const errors: unknown[] = []
  let runs = 0
  const trigger = createSerialRunner(async () => {
    runs++
    if (runs === 1) throw new Error('kaputt')
  }, (error) => errors.push(error))

  await trigger()
  await trigger()
  assert.equal(runs, 2)
  assert.equal(errors.length, 1)
})
