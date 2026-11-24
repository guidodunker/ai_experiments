export type Contact = { name: string; city: string }

/** Kontakte, deren Name den Suchbegriff enthält, ohne Rücksicht auf Groß- und Kleinschreibung. */
export function search(contacts: Contact[], term: string): Contact[] {
  const needle = normalize(term)
  return contacts.filter((contact) => normalize(contact.name).includes(needle))
}

function normalize(text: string): string {
  return text.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Seite `page` (ab 1) mit höchstens `size` Einträgen. */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  const first = (page - 1) * size
  const last = Math.min(first + size, items.length)
  return items.slice(first, last)
}

/** Nach Namen sortiert; die übergebene Liste bleibt unverändert. */
export function sortByName(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
