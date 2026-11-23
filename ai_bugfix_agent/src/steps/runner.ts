import { rm, writeFile } from 'node:fs/promises'
import { readTicket, setSection, writeTicket, type Ticket } from '../ticketfile.ts'
import { listTicketIds } from '../tickets.ts'
import type { Step, StepResult } from './types.ts'

export type RunnerDeps = {
  ticketDir: string
  lockPath: string
  steps: Step[]
  log: (message: string) => void
  /** Nur dieses Ticket bearbeiten */
  only?: number
}

export function applyResult(ticket: Ticket, result: StepResult): Ticket {
  const header = new Map(ticket.header)
  header.set('status', result.status)
  for (const [key, value] of Object.entries(result.fields ?? {})) header.set(key, value)
  const body =
    result.section === undefined ? ticket.body : setSection(ticket.body, result.section.heading, result.section.text)
  return { id: ticket.id, header, body }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyThere(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'EEXIST'
}

/** Wendet die Schritte an, bis für kein Ticket mehr einer passt. Liefert die Zahl gescheiterter Tickets. */
export async function runSteps(deps: RunnerDeps): Promise<number> {
  try {
    await writeFile(deps.lockPath, `${process.pid}\n`, { flag: 'wx' })
  } catch (error) {
    if (isAlreadyThere(error)) {
      throw new Error(`${deps.lockPath} existiert. Läuft schon ein Durchgang? Sonst die Datei löschen.`)
    }
    throw error
  }
  try {
    const ids = deps.only === undefined ? await listTicketIds(deps.ticketDir) : [deps.only]
    let failed = 0
    for (const id of ids) {
      if (!(await advance(id, deps))) failed++
    }
    return failed
  } finally {
    await rm(deps.lockPath, { force: true })
  }
}

/** Bringt ein Ticket so weit wie möglich voran. false, wenn etwas gescheitert ist. */
async function advance(id: number, deps: RunnerDeps): Promise<boolean> {
  // Ein Schritt, der den Status nicht ändert, würde sonst endlos wiederholt.
  const seen = new Set<string>()
  for (;;) {
    let ticket: Ticket
    try {
      ticket = await readTicket(deps.ticketDir, id)
    } catch (error) {
      deps.log(`Ticket ${id}: ${message(error)}`)
      return false
    }
    const status = ticket.header.get('status') ?? ''
    const step = deps.steps.find((s) => s.accepts === status)
    if (step === undefined || seen.has(status)) return true
    seen.add(status)

    try {
      const result = await step.run(ticket)
      // Neu lesen: Der Chat-Agent kann während des Schritts einen Nachtrag angehängt haben.
      await writeTicket(deps.ticketDir, applyResult(await readTicket(deps.ticketDir, id), result))
      deps.log(`Ticket ${id} ${step.name} → ${result.status} ${result.summary}`.trimEnd())
    } catch (error) {
      deps.log(`Ticket ${id} ${step.name} gescheitert: ${message(error)}`)
      return false
    }
  }
}
