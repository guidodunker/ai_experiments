import { z } from 'zod'
import { ensureThread, hashText } from '../state.ts'
import { createTicket, oneLine } from '../tickets.ts'
import { defineTool } from './types.ts'

export const createTicketTool = defineTool({
  name: 'create_ticket',
  description:
    'Legt ein Bug-Ticket für den Thread des aktuellen Ereignisses an. ' +
    'Nur aufrufen, wenn der Top-Post eine Bug-Meldung ist. Höchstens einmal pro Thread.',
  inputSchema: z.object({
    title: z.string().describe('Kurzer, sachlicher Titel, höchstens 80 Zeichen'),
    description: z.string().describe('Was laut Meldung passiert und welche Angaben fehlen'),
    component: z.string().describe('Betroffener Bereich, z. B. "Suche", sonst "unbekannt"'),
    severity: z.enum(['niedrig', 'mittel', 'hoch']),
  }),
  execute: async (input, ctx) => {
    const entry = ensureThread(ctx.state, ctx.event.thread)
    // Zurückgegeben statt geworfen: das LLM kann darauf reagieren, der Lauf geht weiter.
    if (entry.ticket !== null) {
      return { error: `Thread ${ctx.event.thread.index} hat bereits Ticket ${entry.ticket}.` }
    }
    const link = await ctx.link()
    const id = await createTicket(ctx.ticketDir, ctx.event.thread, input, ctx.now(), ctx.source, link)
    entry.ticket = id
    // Das Ticket gilt für diesen Text; seine Antworten sind noch nicht angehängt.
    entry.topHash = hashText(ctx.event.thread.top.text)
    entry.replyCount = 0
    // Sofort speichern, damit ein Abbruch danach kein zweites Ticket erzeugt.
    await ctx.persist()
    await ctx.reply(`Ticket bug-${id} angelegt: ${oneLine(input.title)} (${oneLine(input.component)}, ${input.severity})`)
    return { ticket: id }
  },
})
