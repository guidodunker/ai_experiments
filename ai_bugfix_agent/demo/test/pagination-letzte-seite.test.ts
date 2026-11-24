import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate, search, type Contact } from '../src/contacts.ts'

const contacts: Contact[] = [
  { name: 'Albers', city: 'Köln' },
  { name: 'Baumann', city: 'Berlin' },
  { name: 'Conrad', city: 'Hamburg' },
  { name: 'Dietrich', city: 'Bremen' },
  { name: 'Engel', city: 'Leipzig' },
]

test('paginate liefert den letzten Kontakt der letzten Seite', () => {
  // Fünf Kontakte, Seitengröße 2 => drei Seiten, die letzte mit einem Eintrag.
  assert.deepStrictEqual(paginate(contacts, 3, 2).map((c) => c.name), ['Engel'])

  // Auch eine volle letzte Seite verliert ihren letzten Eintrag.
  assert.deepStrictEqual(paginate(contacts, 2, 2).map((c) => c.name), ['Conrad', 'Dietrich'])

  // Gleiches Verhalten in der Suchergebnisliste.
  const treffer = search(contacts, 'e')
  assert.deepStrictEqual(
    paginate(treffer, 2, 2).map((c) => c.name),
    treffer.slice(2, 4).map((c) => c.name),
  )
})
