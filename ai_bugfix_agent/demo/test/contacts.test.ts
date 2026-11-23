import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate, search, sortByName, type Contact } from '../src/contacts.ts'

const contacts: Contact[] = [
  { name: 'Meier', city: 'Berlin' },
  { name: 'MEIER', city: 'Hamburg' },
  { name: 'Albers', city: 'Köln' },
]

test('search ignoriert Groß- und Kleinschreibung', () => {
  assert.deepEqual(search(contacts, 'meier').map((c) => c.city), ['Berlin', 'Hamburg'])
})

test('search ohne Treffer', () => {
  assert.deepEqual(search(contacts, 'Zander'), [])
})

test('paginate liefert die ersten Seiten vollständig', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  assert.deepEqual(paginate(items, 1, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(paginate(items, 2, 10), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
})

test('sortByName sortiert alphabetisch', () => {
  const names = sortByName([{ name: 'Meier', city: '' }, { name: 'Albers', city: '' }, { name: 'Zander', city: '' }])
  assert.deepEqual(names.map((c) => c.name), ['Albers', 'Meier', 'Zander'])
})
