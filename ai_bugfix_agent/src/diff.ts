import { hashText } from './state.ts'
import type { ChatEvent, State, Thread } from './types.ts'

/**
 * Ermittelt, was seit dem letzten Lauf neu ist. Threads werden über ihre
 * Position erkannt; ein geänderter Top-Post wird gemeldet, aber nicht neu
 * verarbeitet.
 */
export function diff(threads: Thread[], state: State): { events: ChatEvent[]; warnings: string[] } {
  const events: ChatEvent[] = []
  const warnings: string[] = []

  for (const thread of threads) {
    const known = state.threads[thread.index]
    if (known === undefined || known === null) {
      events.push({ kind: 'NewThread', thread })
      thread.replies.forEach((reply, replyIndex) =>
        events.push({ kind: 'NewReply', thread, reply, replyIndex }),
      )
      continue
    }

    if (known.topHash !== hashText(thread.top.text)) {
      warnings.push(`Thread ${thread.index}: Top-Post wurde geändert, Thread wird übersprungen.`)
      continue
    }

    for (let replyIndex = known.replyCount; replyIndex < thread.replies.length; replyIndex++) {
      events.push({ kind: 'NewReply', thread, reply: thread.replies[replyIndex]!, replyIndex })
    }
  }

  return { events, warnings }
}
