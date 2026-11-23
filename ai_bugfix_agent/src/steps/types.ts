import type { Ticket } from '../ticketfile.ts'

export type StepResult = {
  status: string
  /** Neue oder geänderte Kopffelder */
  fields?: Record<string, string>
  /** Wird als `## heading` angehängt oder ersetzt einen gleichnamigen Abschnitt. */
  section?: { heading: string; text: string }
  /** Eine Zeile für Konsole und agent.log */
  summary: string
}

/** Ein Arbeitsschritt für Tickets mit `status: accepts`. Das Ticket schreibt der Runner. */
export type Step = {
  name: string
  accepts: string
  run(ticket: Ticket): Promise<StepResult>
}
