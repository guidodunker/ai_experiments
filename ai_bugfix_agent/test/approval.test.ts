import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isApproval } from '../src/approval.ts'

test('Freigaben', () => {
  for (const text of ['approved', 'Approved!', ' APPROVED. ', 'freigegeben', 'Freigegeben!']) {
    assert.equal(isApproval(text), true, text)
  }
})

test('keine Freigaben', () => {
  for (const text of ['approved? noch nicht', 'ok', 'approved bitte', '👍', 'nicht approved', 'approved!!', '']) {
    assert.equal(isApproval(text), false, text)
  }
})
