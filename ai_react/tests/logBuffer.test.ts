import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogBuffer } from '../server/services/logBuffer.ts'

test('chunks that split a line mid-way are joined', () => {
  const buf = createLogBuffer(10)
  buf.push('hello ')
  buf.push('world\n')
  assert.equal(buf.tail(10), 'hello world')
})

test('tail returns the last n lines, newest last', () => {
  const buf = createLogBuffer(10)
  buf.push('a\nb\nc\n')
  assert.equal(buf.tail(2), 'b\nc')
})

test('an unterminated final line is still visible', () => {
  const buf = createLogBuffer(10)
  buf.push('done\nstill typing')
  assert.equal(buf.tail(10), 'done\nstill typing')
})

test('the buffer never grows past its cap', () => {
  const buf = createLogBuffer(3)
  buf.push('1\n2\n3\n4\n5\n')
  assert.equal(buf.tail(100), '3\n4\n5')
})

test('carriage returns from Windows output are stripped', () => {
  const buf = createLogBuffer(10)
  buf.push('line\r\n')
  assert.equal(buf.tail(10), 'line')
})

test('clear empties both completed and partial lines', () => {
  const buf = createLogBuffer(10)
  buf.push('a\npartial')
  buf.clear()
  assert.equal(buf.tail(10), '')
})
