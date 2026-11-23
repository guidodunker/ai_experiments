import { readFile, writeFile } from 'node:fs/promises'
import { ticketPath } from './tickets.ts'

/** Kopf aus `schlüssel: wert`-Zeilen bis zur ersten Leerzeile, danach der Rumpf. */
export type Ticket = { id: number; header: Map<string, string>; body: string }

export function parseTicket(text: string): Ticket {
  const normalized = text.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n\n')
  const head = end === -1 ? normalized : normalized.slice(0, end)
  const body = end === -1 ? '' : normalized.slice(end + 2)
  const header = new Map<string, string>()
  for (const line of head.split('\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) header.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  const id = Number(header.get('id'))
  if (!Number.isInteger(id)) throw new Error('Ticket ohne gültige id im Kopf')
  return { id, header, body }
}

export function formatTicketFile(ticket: Ticket): string {
  const head = [...ticket.header].map(([key, value]) => `${key}: ${value}`).join('\n')
  return `${head}\n\n${ticket.body}`
}

/**
 * Ersetzt den Abschnitt `## heading` bis zum nächsten `## ` oder hängt ihn ans Ende.
 * `heading` ist ein festes Wort aus dem Code (Analyse, Plan), kein Regex-Sonderzeichen.
 */
export function setSection(body: string, heading: string, text: string): string {
  const section = `## ${heading}\n${text.trim()}\n`
  const start = new RegExp(`^## ${heading}$`, 'm').exec(body)
  if (start === null) return `${body.replace(/\n*$/, '\n')}\n${section}`
  const rest = body.slice(start.index + start[0].length)
  const next = /^## /m.exec(rest)
  const tail = next === null ? '' : `\n${rest.slice(next.index)}`
  return body.slice(0, start.index) + section + tail
}

export async function readTicket(dir: string, id: number): Promise<Ticket> {
  return parseTicket(await readFile(ticketPath(dir, id), 'utf8'))
}

export async function writeTicket(dir: string, ticket: Ticket): Promise<void> {
  await writeFile(ticketPath(dir, ticket.id), formatTicketFile(ticket))
}
