import type { StepResult } from '../steps/types.ts'
import type { Ticket } from '../ticketfile.ts'
import type { TicketFields } from '../tickets.ts'
import type { SourceName, Thread } from '../types.ts'

export type StoreName = 'datei' | 'github'

/** Wo Tickets liegen. Chat-Agent und Runner kennen nur diese Schnittstelle. */
export type TicketStore = {
  kind: StoreName
  /** Für Slack-Antworten und Logs: 'bug-5' bzw. '#7' */
  label(id: number): string
  /** Branch im Ziel-Repo: 'bugfix/bug-5' bzw. 'bugfix/issue-7' */
  branch(id: number): string
  create(
    thread: Thread,
    fields: TicketFields,
    source: SourceName,
    now: Date,
    link?: string,
  ): Promise<{ id: number; url?: string }>
  /** false, wenn das Ticket nicht existiert */
  appendReply(id: number, entry: { level: number; text: string }, now: Date): Promise<boolean>
  /** Offene Tickets des Agenten, aufsteigend */
  list(): Promise<number[]>
  read(id: number): Promise<Ticket>
  /** Setzt Status und Felder, hängt den Abschnitt an, liefert das Ticket danach */
  applyResult(id: number, result: StepResult): Promise<Ticket>
  /** Schließt das Ticket nach dem Merge. Bei Dateien genügt der Status, dort passiert nichts. */
  close(id: number): Promise<void>
}
