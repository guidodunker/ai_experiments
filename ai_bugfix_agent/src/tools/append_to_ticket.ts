import { z } from 'zod'
import { appendToTicket } from '../tickets.ts'
import { defineTool } from './types.ts'

export const appendToTicketTool = defineTool({
  name: 'append_to_ticket',
  description:
    'Hängt einen Nachtrag an ein bestehendes Bug-Ticket an, z. B. eine Antwort ' +
    'mit Details, Bestätigung, Workaround oder Rückfrage.',
  inputSchema: z.object({
    ticket: z.number().int().describe('Ticketnummer'),
    text: z.string().describe('Antwort im Wortlaut oder als kurze Zusammenfassung'),
  }),
  execute: async (input, ctx) => {
    const level = ctx.event.kind === 'NewReply' ? ctx.event.reply.level : 1
    const ok = await appendToTicket(ctx.ticketDir, input.ticket, { level, text: input.text }, ctx.now())
    return ok ? { ok: true } : { error: `Ticket ${input.ticket} existiert nicht.` }
  },
})
