import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatPost } from './parser.ts'
import { isNotFound } from './state.ts'
import type { Thread } from './types.ts'

export type Severity = 'niedrig' | 'mittel' | 'hoch'

/** Was das LLM zu einem Ticket beiträgt. Kopf und Originalmeldung schreibt der Code. */
export type TicketFields = {
  title: string
  description: string
  component: string
  severity: Severity
}

const TICKET_FILE = /^bug_(\d+)\.txt$/

export function ticketPath(dir: string, id: number): string {
  return join(dir, `bug_${id}.txt`)
}

/** ISO-Format in lokaler Zeit, ohne Zeitzone und Millisekunden. */
export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Nummern aller Tickets im Verzeichnis, aufsteigend. Fehlt das Verzeichnis, keine. */
export async function listTicketIds(dir: string): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  return names
    .flatMap((name) => {
      const match = TICKET_FILE.exec(name)
      return match === null ? [] : [Number(match[1])]
    })
    .sort((a, b) => a - b)
}

export async function nextTicketNumber(dir: string): Promise<number> {
  return Math.max(0, ...(await listTicketIds(dir))) + 1
}

/** Kopfwerte müssen einzeilig bleiben, sonst endet der Kopf zu früh. */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
}

export function formatTicket(id: number, thread: Thread, fields: TicketFields, created: Date): string {
  return [
    `id: ${id}`,
    'status: neu',
    `erstellt: ${formatTimestamp(created)}`,
    `thread: ${thread.id}`,
    `titel: ${oneLine(fields.title)}`,
    `komponente: ${oneLine(fields.component)}`,
    `schweregrad: ${fields.severity}`,
    '',
    '## Beschreibung',
    fields.description.trim(),
    '',
    '## Originalmeldung',
    formatPost(thread.top),
    '',
    '## Nachträge',
    '',
  ].join('\n')
}

/** Legt das nächste Ticket an und liefert seine Nummer. */
export async function createTicket(
  dir: string,
  thread: Thread,
  fields: TicketFields,
  now: Date,
): Promise<number> {
  await mkdir(dir, { recursive: true })
  const id = await nextTicketNumber(dir)
  // 'wx' schlägt fehl, falls die Datei inzwischen existiert, statt sie zu überschreiben.
  await writeFile(ticketPath(dir, id), formatTicket(id, thread, fields, now), { flag: 'wx' })
  return id
}

/** Hängt einen Nachtrag an. Liefert false, wenn das Ticket nicht existiert. */
export async function appendToTicket(
  dir: string,
  id: number,
  entry: { level: number; text: string },
  now: Date,
): Promise<boolean> {
  const path = ticketPath(dir, id)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
  const section = `\n### ${formatTimestamp(now)} (Antwort, Ebene ${entry.level})\n${entry.text.trim()}\n`
  await writeFile(path, insertIntoAddenda(content, section))
  return true
}

/** Fügt am Ende von `## Nachträge` ein, vor einem späteren Abschnitt wie `## Analyse`. */
function insertIntoAddenda(content: string, section: string): string {
  const heading = /^## Nachträge$/m.exec(content)
  if (heading === null) return content + section
  const afterHeading = heading.index + heading[0].length
  const next = /^## /m.exec(content.slice(afterHeading))
  if (next === null) return content + section
  const cut = afterHeading + next.index
  return `${content.slice(0, cut).replace(/\n+$/, '\n')}${section}\n${content.slice(cut)}`
}
