import { appendToTicketTool } from './append_to_ticket.ts'
import { createTicketTool } from './create_ticket.ts'
import type { AgentTool } from './types.ts'

/** Alle Tools des Agenten. Ein neues Verhalten: Tool hier eintragen und in prompt.md beschreiben. */
export const TOOLS: AgentTool[] = [createTicketTool, appendToTicketTool]
