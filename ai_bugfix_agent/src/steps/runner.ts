import { rm, writeFile } from 'node:fs/promises'
import type { TicketStore } from '../store/types.ts'
import type { Ticket } from '../ticketfile.ts'
import type { ChatReply } from '../types.ts'
import type { Step, StepResult } from './types.ts'

export type RunnerDeps = {
  store: TicketStore
  lockPath: string
  steps: Step[]
  log: (message: string) => void
  /** Nur dieses Ticket bearbeiten */
  only?: number
  /** Antwortet in Slack-Threads. Fehlt, wenn SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID nicht gesetzt ist. */
  reply?: ChatReply
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
    const ids = deps.only === undefined ? await deps.store.list() : [deps.only]
    let failed = 0
    for (const id of ids) {
      if (!(await advance(id, deps))) failed++
    }
    return failed
  } finally {
    await rm(deps.lockPath, { force: true })
  }
}

/** Meldet einen Statuswechsel im Slack-Thread des Tickets. Wirft nie. */
async function announce(ticket: Ticket, text: string, deps: RunnerDeps): Promise<void> {
  if (ticket.header.get('quelle') !== 'slack') return
  const thread = ticket.header.get('thread')
  if (deps.reply === undefined || thread === undefined) {
    deps.log(
      `Warnung: Ticket ${ticket.id} stammt aus Slack, aber SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID fehlt. Keine Antwort im Thread.`,
    )
    return
  }
  try {
    await deps.reply(thread, text)
  } catch (error) {
    deps.log(`Warnung: Antwort an Thread ${thread} gescheitert: ${message(error)}`)
  }
}

/** Bringt ein Ticket so weit wie möglich voran. false, wenn etwas gescheitert ist. */
async function advance(id: number, deps: RunnerDeps): Promise<boolean> {
  // Ein Schritt, der den Status nicht ändert, würde sonst endlos wiederholt.
  const seen = new Set<string>()
  for (;;) {
    let ticket: Ticket
    try {
      ticket = await deps.store.read(id)
    } catch (error) {
      deps.log(`Ticket ${id}: ${message(error)}`)
      return false
    }
    const status = ticket.header.get('status') ?? ''
    const step = deps.steps.find((s) => s.accepts === status)
    if (step === undefined && seen.size === 0) {
      // Sonst endet ein Lauf ohne Zeile, und man weiß nicht, warum nichts passiert.
      const hint = status === 'nicht_reproduziert' ? ' Zum Wiederholen den Status auf neu setzen.' : ''
      deps.log(`Ticket ${id}: status ${status}, kein Schritt.${hint}`)
    }
    if (step === undefined || seen.has(status)) return true
    seen.add(status)

    let result: StepResult
    try {
      result = await step.run(ticket)
    } catch (error) {
      deps.log(`Ticket ${id} ${step.name} gescheitert: ${message(error)}`)
      return false
    }

    const change = `${result.status} ${result.summary}`.trimEnd()
    let updated: Ticket
    try {
      updated = await deps.store.applyResult(id, result)
    } catch (error) {
      // Die Sitzung ist bezahlt; das Ergebnis steht wenigstens im Log.
      deps.log(`Ticket ${id} ${step.name}: Ergebnis nicht gespeichert: ${message(error)}. Ergebnis war: ${change}`)
      return false
    }
    deps.log(`Ticket ${id} ${step.name} → ${change}`)
    await announce(updated, `${deps.store.label(id)}: ${change}`, deps)
  }
}
