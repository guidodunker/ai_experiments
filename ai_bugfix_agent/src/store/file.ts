import { branchName } from '../steps/common.ts'
import type { StepResult } from '../steps/types.ts'
import { readTicket, setSection, writeTicket, type Ticket } from '../ticketfile.ts'
import { appendToTicket, createTicket, listTicketIds } from '../tickets.ts'
import type { TicketStore } from './types.ts'

export function applyStepResult(ticket: Ticket, result: StepResult): Ticket {
  const header = new Map(ticket.header)
  header.set('status', result.status)
  for (const [key, value] of Object.entries(result.fields ?? {})) header.set(key, value)
  const body =
    result.section === undefined ? ticket.body : setSection(ticket.body, result.section.heading, result.section.text)
  return { id: ticket.id, header, body }
}

/** Tickets als `bug_N.txt` in einem Verzeichnis */
export function fileStore(dir: string): TicketStore {
  return {
    kind: 'datei',
    label: (id) => `bug-${id}`,
    branch: branchName,
    async create(thread, fields, source, now, link) {
      return { id: await createTicket(dir, thread, fields, now, source, link) }
    },
    appendReply: (id, entry, now) => appendToTicket(dir, id, entry, now),
    list: () => listTicketIds(dir),
    read: (id) => readTicket(dir, id),
    async applyResult(id, result) {
      // Neu lesen: Der Chat-Agent kann während des Schritts einen Nachtrag angehängt haben.
      const updated = applyStepResult(await readTicket(dir, id), result)
      await writeTicket(dir, updated)
      return updated
    },
  }
}
