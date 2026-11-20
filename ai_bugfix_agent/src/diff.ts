import { hashText } from './state.ts'
import type { ChatEvent, State, Thread } from './types.ts'

/**
 * Ermittelt, was seit dem letzten Lauf neu ist. Threads werden über ihre
 * Position erkannt. Ein geänderter Top-Post ohne Ticket wird neu bewertet,
 * denn oft war beim ersten Mal nur ein halb getippter Stand gespeichert. Mit
 * Ticket wird er nur gemeldet, damit kein zweites Ticket entsteht.
 */
export function diff(threads: Thread[], state: State): { events: ChatEvent[]; warnings: string[] } {
  const events: ChatEvent[] = []
  const warnings: string[] = []

  for (const thread of threads) {
    const known = state.threads[thread.index]
    const changed = known !== undefined && known !== null && known.topHash !== hashText(thread.top.text)

    if (changed && known.ticket !== null) {
      warnings.push(`Thread ${thread.index}: Top-Post wurde geändert, Thread wird übersprungen.`)
      continue
    }

    if (known === undefined || known === null || changed) {
      if (changed) warnings.push(`Thread ${thread.index}: Top-Post wurde geändert, wird neu bewertet.`)
      events.push({ kind: 'NewThread', thread })
      thread.replies.forEach((reply, replyIndex) =>
        events.push({ kind: 'NewReply', thread, reply, replyIndex }),
      )
      continue
    }

    for (let replyIndex = known.replyCount; replyIndex < thread.replies.length; replyIndex++) {
      events.push({ kind: 'NewReply', thread, reply: thread.replies[replyIndex]!, replyIndex })
    }
  }

  return { events, warnings }
}
