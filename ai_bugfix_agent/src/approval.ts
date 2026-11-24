import type { TicketStore } from './store/types.ts'
import type { ChatReply, Post } from './types.ts'

const APPROVAL = /^(approved|freigegeben)[!.]?$/i

/** Nur genau dieses Wort, damit „approved? noch nicht“ keinen Merge auslöst. */
export function isApproval(text: string): boolean {
  return APPROVAL.test(text.trim())
}

export type ApprovalDeps = {
  store: TicketStore
  reply: ChatReply
  log: (message: string) => void
  now: () => Date
}

/**
 * Freigabe im Chat: setzt ein Ticket mit `pr_offen` auf `freigegeben`. Der
 * Merge selbst folgt im nächsten Lauf von `npm run steps`. Wer freigibt, wird
 * nicht geprüft (siehe Spec, Sicherheit).
 */
export async function handleApproval(
  ticketId: number,
  thread: { id: string; index: number },
  post: Post,
  deps: ApprovalDeps,
): Promise<void> {
  const say = async (text: string): Promise<void> => {
    try {
      await deps.reply(thread.id, text)
    } catch (error) {
      deps.log(
        `Warnung: Antwort an Thread ${thread.index} gescheitert: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const ticket = await deps.store.read(ticketId)
  const label = deps.store.label(ticketId)
  const status = ticket.header.get('status') ?? ''
  if (status === 'freigegeben') return say(`${label} ist schon freigegeben.`)
  if (status !== 'pr_offen') return say(`${label} kann noch nicht freigegeben werden, Status ist ${status}.`)

  const author = post.author ?? 'unbekannt'
  await deps.store.appendReply(
    ticketId,
    { level: post.level, text: `Freigegeben im Slack-Thread von ${author}.` },
    deps.now(),
  )
  await deps.store.applyResult(ticketId, { status: 'freigegeben', fields: { freigegeben_von: author }, summary: '' })
  deps.log(`Thread ${thread.index} → Freigabe für ${label} von ${author}.`)
  await say(`${label} freigegeben. Der nächste Lauf von npm run steps merged ${ticket.header.get('pr') ?? 'den Pull Request'}.`)
}
