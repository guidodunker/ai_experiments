import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortByName, type Contact } from '../src/contacts.ts'

test('sortByName einsortiert Umlaut-Namen bei den Grundbuchstaben', () => {
  const contacts: Contact[] = [
    { name: 'Meier', city: '' },
    { name: 'Albers', city: '' },
    { name: 'Zander', city: '' },
    { name: 'Öhler', city: '' },
    { name: 'Ärger', city: '' },
    { name: 'Overbeck', city: '' },
  ]
  const names = sortByName(contacts).map((c) => c.name)
  assert.deepEqual(names, ['Albers', 'Ärger', 'Meier', 'Öhler', 'Overbeck', 'Zander'])
})
