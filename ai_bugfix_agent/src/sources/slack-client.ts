import socketMode from '@slack/socket-mode'
import webApi from '@slack/web-api'
import type { SlackMessage } from './slack-threads.ts'
import type { SlackApi, SlackEvents, SlackPage } from './slack.ts'

// Beide Pakete sind CommonJS. Benannte Importe scheitern unter Node zur Laufzeit, der Default-Import nicht.
const { SocketModeClient } = socketMode
const { WebClient, retryPolicies, LogLevel } = webApi

type RawMessage = {
  ts?: string
  text?: string
  user?: string
  bot_id?: string
  subtype?: string
  reply_count?: number
}

function toMessage(raw: RawMessage): SlackMessage {
  return {
    ts: raw.ts ?? '',
    text: raw.text,
    user: raw.user,
    bot_id: raw.bot_id,
    subtype: raw.subtype,
    reply_count: raw.reply_count,
  }
}

function toPage(response: { messages?: RawMessage[]; response_metadata?: { next_cursor?: string } }): SlackPage {
  return { messages: (response.messages ?? []).map(toMessage), nextCursor: response.response_metadata?.next_cursor }
}

export function webApiClient(token: string, channel: string): SlackApi {
  const client = new WebClient(token, {
    // Fünf Versuche in fünf Minuten statt zehn in dreißig: Ein Lauf soll nicht eine halbe Stunde hängen.
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    logLevel: LogLevel.ERROR,
  })
  return {
    channel,
    async whoAmI() {
      const response = await client.auth.test()
      return { userId: response.user_id ?? '', botId: response.bot_id ?? '' }
    },
    async history(cursor) {
      return toPage(await client.conversations.history({ channel, cursor, limit: 200 }))
    },
    async replies(ts, cursor) {
      return toPage(await client.conversations.replies({ channel, ts, cursor, limit: 200 }))
    },
    async post(threadTs, text) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text })
    },
  }
}

export function socketModeEvents(appToken: string, log: (message: string) => void): SlackEvents {
  return {
    start(handlers) {
      const client = new SocketModeClient({ appToken, logLevel: socketMode.LogLevel.ERROR })
      client.on('message', async ({ event, ack }: { event?: { channel?: string }; ack: () => Promise<void> }) => {
        // Sofort bestätigen, sonst stellt Slack das Event erneut zu.
        await ack()
        handlers.message(event?.channel ?? '')
      })
      client.on('connected', () => handlers.connected())
      client.start().catch((error: unknown) => {
        log(`Socket Mode: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
  }
}
