import { handleEvent, type RunModel } from './agent.ts'
import { handleApproval, isApproval } from './approval.ts'
import { diff } from './diff.ts'
import type { ChatSource } from './sources/types.ts'
import { applyEvent, loadState, saveState } from './state.ts'
import type { TicketStore } from './store/types.ts'
import type { ChatEvent, ChatLink, ChatReply } from './types.ts'

export type RunDeps = {
  source: ChatSource
  reply: ChatReply
  link?: ChatLink
  statePath: string
  store: TicketStore
  runModel: RunModel
  log: (message: string) => void
  now?: () => Date
}

function summarize(event: ChatEvent): string {
  return event.kind === 'NewThread'
    ? `Thread ${event.thread.index}: neuer Top-Post`
    : `Thread ${event.thread.index}: neue Antwort ${event.replyIndex + 1}`
}

/**
 * Verarbeitet alles, was seit dem letzten Lauf neu ist. Der Zustand wird nach
 * jedem Ereignis gespeichert; ein Fehler bricht ab und der nächste Lauf
 * setzt beim fehlgeschlagenen Ereignis wieder an.
 */
export async function runOnce(deps: RunDeps): Promise<'ok' | 'missing'> {
  const threads = await deps.source.readThreads()
  if (threads === 'missing') return 'missing'

  const state = await loadState(deps.statePath)
  const persist = () => saveState(deps.statePath, state)
  const { events, warnings } = diff(threads, state)
  for (const warning of warnings) deps.log(`Warnung: ${warning}`)

  for (const event of events) {
    deps.log(summarize(event))
    const now = deps.now ?? (() => new Date())
    const ticket = state.threads[event.thread.id]?.ticket ?? null
    if (event.kind === 'NewReply' && ticket !== null && isApproval(event.reply.text)) {
      // Fest im Code statt beim LLM: Eine Meldung kann keine Freigabe herbeiformulieren.
      await handleApproval(ticket, event.thread, event.reply, {
        store: deps.store,
        reply: deps.reply,
        log: deps.log,
        now,
      })
    } else {
      await handleEvent(event, {
        state,
        store: deps.store,
        persist,
        runModel: deps.runModel,
        log: deps.log,
        now,
        source: deps.source.name,
        reply: deps.reply,
        link: deps.link,
      })
    }
    applyEvent(state, event)
    await persist()
  }
  return 'ok'
}
