import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises'
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

export async function nextTicketNumber(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isNotFound(error)) return 1
    throw error
  }
  const numbers = names.flatMap((name) => {
    const match = TICKET_FILE.exec(name)
    return match === null ? [] : [Number(match[1])]
  })
  return Math.max(0, ...numbers) + 1
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
    `thread: ${thread.index}`,
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
  const section = `\n### ${formatTimestamp(now)} (Antwort, Ebene ${entry.level})\n${entry.text.trim()}\n`
  try {
    // 'r+' öffnet nur vorhandene Dateien; appendFile allein würde eine neue anlegen.
    await writeFile(ticketPath(dir, id), '', { flag: 'r+' })
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
  await appendFile(ticketPath(dir, id), section)
  return true
}
