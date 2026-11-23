import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatTicketFile, type Ticket } from '../ticketfile.ts'

export function branchName(id: number): string {
  return `bugfix/bug-${id}`
}

/** Fester Pfad je Ticket, damit ein Folgelauf liegengebliebene Worktrees findet. */
export function worktreePath(root: string, id: number): string {
  return join(root, `bugfix-bug-${id}`)
}

/** Erster Satz der ersten Zeile, für die Logzeile. */
export function firstSentence(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim()
  const end = line.search(/[.!?](\s|$)/)
  return end === -1 ? line : line.slice(0, end + 1)
}

/** Das Ticket als markierter Block. Die Endmarke im Text wird entschärft, damit er den Block nicht schließt. */
export function quoteTicket(ticket: Ticket): string {
  const text = formatTicketFile(ticket).trimEnd().replaceAll('TICKET>>>', 'TICKET> > >')
  return `<<<TICKET\n${text}\nTICKET>>>`
}

export function loadPrompt(name: 'analyze' | 'plan'): string {
  return readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8')
}

export function bulletList(items: string[]): string {
  return items.length === 0 ? '- keine' : items.map((item) => `- ${item}`).join('\n')
}
