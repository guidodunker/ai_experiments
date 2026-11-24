import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortByName, type Contact } from '../src/contacts.ts'

test('sortByName ordnet Namen mit Ä alphabetisch ein', () => {
  const contacts: Contact[] = [
    { name: 'Zander', city: '' },
    { name: 'Ärzte', city: '' },
    { name: 'Meier', city: '' },
    { name: 'Albers', city: '' },
  ]

  const sorted = sortByName(contacts).map((c) => c.name)

  assert.deepEqual(sorted, ['Albers', 'Ärzte', 'Meier', 'Zander'])
})
