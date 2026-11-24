import type { ChatReply } from '../types.ts'
import { toThreads, type BotIdentity, type SlackMessage } from './slack-threads.ts'
import type { ChatSource } from './types.ts'

export type SlackPage = { messages: SlackMessage[]; nextCursor?: string }

/** Die Web-API-Aufrufe für einen Channel. Echt in `slack-client.ts`, in Tests ein Fake. */
export type SlackApi = {
  channel: string
  whoAmI(): Promise<BotIdentity>
  history(cursor?: string): Promise<SlackPage>
  replies(ts: string, cursor?: string): Promise<SlackPage>
  post(threadTs: string, text: string): Promise<void>
}

/** Socket Mode: meldet Nachrichten-Events mit ihrem Channel und jedes Verbinden, auch nach einem Reconnect. */
export type SlackEvents = {
  start(handlers: { message(channel: string): void; connected(): void }): void
}

/** Mehrere Events kurz hintereinander, etwa Nachricht und Bearbeitung, ergeben einen Lauf. */
export const SLACK_DEBOUNCE_MS = 1000

async function readAll(fetchPage: (cursor?: string) => Promise<SlackPage>): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    messages.push(...page.messages)
    cursor = page.nextCursor
  } while (cursor !== undefined && cursor !== '')
  return messages
}

/**
 * Liest bei jedem Lauf den ganzen Channel neu. Events lösen nur einen Lauf aus
 * und werden nicht selbst ausgewertet; so holt der erste Lauf nach einer Pause alles nach.
 */
export function slackSource(api: SlackApi, events: SlackEvents, debounceMs = SLACK_DEBOUNCE_MS): ChatSource {
  let me: BotIdentity | undefined
  return {
    name: 'slack',
    label: `Slack-Channel ${api.channel}`,
    async readThreads() {
      me ??= await api.whoAmI()
      const history = await readAll((cursor) => api.history(cursor))
      const replies = new Map<string, SlackMessage[]>()
      for (const top of history) {
        if ((top.reply_count ?? 0) > 0) {
          replies.set(top.ts, await readAll((cursor) => api.replies(top.ts, cursor)))
        }
      }
      return toThreads(history, replies, me)
    },
    watch(onChange) {
      let timer: NodeJS.Timeout | undefined
      const later = (): void => {
        clearTimeout(timer)
        timer = setTimeout(onChange, debounceMs)
      }
      events.start({
        message: (channel) => {
          if (channel === api.channel) later()
        },
        connected: later,
      })
    },
  }
}

export function slackReply(api: SlackApi): ChatReply {
  return (threadId, text) => api.post(threadId, text)
}
