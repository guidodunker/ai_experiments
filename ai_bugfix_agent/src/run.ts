import { readFile } from 'node:fs/promises'
import { handleEvent, type RunModel } from './agent.ts'
import { diff } from './diff.ts'
import { parseChat } from './parser.ts'
import { applyEvent, isNotFound, loadState, saveState } from './state.ts'
import type { ChatEvent, ChatReply } from './types.ts'

export type RunDeps = {
  chatPath: string
  reply: ChatReply
  statePath: string
  ticketDir: string
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
  let text: string
  try {
    text = await readFile(deps.chatPath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return 'missing'
    throw error
  }

  const state = await loadState(deps.statePath)
  const persist = () => saveState(deps.statePath, state)
  const { events, warnings } = diff(parseChat(text), state)
  for (const warning of warnings) deps.log(`Warnung: ${warning}`)

  for (const event of events) {
    deps.log(summarize(event))
    await handleEvent(event, {
      state,
      ticketDir: deps.ticketDir,
      persist,
      runModel: deps.runModel,
      log: deps.log,
      now: deps.now ?? (() => new Date()),
      source: 'datei',
      reply: deps.reply,
    })
    applyEvent(state, event)
    await persist()
  }
  return 'ok'
}
