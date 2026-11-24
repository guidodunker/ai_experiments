import type { Thread } from '../types.ts'

/** Die Felder einer Slack-Nachricht, die der Agent braucht */
export type SlackMessage = {
  ts: string
  text?: string
  user?: string
  bot_id?: string
  subtype?: string
  reply_count?: number
}

/** Wer der eigene Bot ist, aus `auth.test`. Leerer Text, wenn Slack den Wert nicht liefert. */
export type BotIdentity = { userId: string; botId: string }

/** `file_share` ist eine Meldung mit Anhang; es zählt nur ihr Text. */
const TOP_SUBTYPES = new Set<string | undefined>([undefined, 'file_share'])
/** `thread_broadcast` ist eine Antwort, die auch im Channel erscheint. */
const REPLY_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast'])

/** `ts` lässt sich als Text vergleichen: zehn Stellen Sekunden, Punkt, sechs Stellen. */
function byTs(a: SlackMessage, b: SlackMessage): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
}

/**
 * Baut Threads aus der Channel-History und den Antworten je Top-Post
 * (Schlüssel: `ts` des Top-Posts). Eigene Nachrichten des Bots und
 * Systemnachrichten fallen weg. Slack-Threads sind flach: Antworten haben Ebene 2.
 */
export function toThreads(history: SlackMessage[], replies: Map<string, SlackMessage[]>, me: BotIdentity): Thread[] {
  const isOwn = (m: SlackMessage): boolean =>
    (me.userId !== '' && m.user === me.userId) || (me.botId !== '' && m.bot_id === me.botId)

  return history
    .filter((m) => !isOwn(m) && TOP_SUBTYPES.has(m.subtype))
    .sort(byTs)
    .map((top, index) => ({
      id: top.ts,
      index,
      top: { level: 1, text: top.text ?? '' },
      replies: (replies.get(top.ts) ?? [])
        // conversations.replies liefert den Top-Post als erstes Element mit.
        .filter((m) => m.ts !== top.ts && !isOwn(m) && REPLY_SUBTYPES.has(m.subtype))
        .sort(byTs)
        .map((m) => ({ level: 2, text: m.text ?? '' })),
    }))
}
