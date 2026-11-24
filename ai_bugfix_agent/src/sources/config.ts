import { join } from 'node:path'
import type { ChatLink, ChatReply } from '../types.ts'
import { fileReply, fileSource } from './file.ts'
import { socketModeEvents, webApiClient } from './slack-client.ts'
import { slackLink, slackReply, slackSource } from './slack.ts'
import type { ChatSource } from './types.ts'

type Env = Record<string, string | undefined>

export type ChatSetup = { source: ChatSource; reply: ChatReply; link?: ChatLink; statePath: string }

const SLACK_SETTINGS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID'] as const

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Wählt die Quelle nach `CHAT_SOURCE`. Jede Quelle hat eine eigene
 * Zustandsdatei, damit sich Positionen und Slack-IDs nicht vermischen.
 */
export function chooseChat(env: Env, root: string, log: (message: string) => void): ChatSetup | { error: string } {
  const name = setting(env, 'CHAT_SOURCE') ?? 'datei'
  if (name === 'datei') {
    return {
      source: fileSource(setting(env, 'CHAT_FILE') ?? join(root, 'chat.txt')),
      reply: fileReply(log),
      statePath: join(root, 'state.json'),
    }
  }
  if (name !== 'slack') return { error: `CHAT_SOURCE=${name} ist unbekannt. Erlaubt: datei, slack.` }

  const missing = SLACK_SETTINGS.find((key) => setting(env, key) === undefined)
  if (missing !== undefined) return { error: `${missing} fehlt. Trage es in .env ein (siehe .env.example).` }
  const api = webApiClient(setting(env, 'SLACK_BOT_TOKEN')!, setting(env, 'SLACK_CHANNEL_ID')!)
  return {
    source: slackSource(api, socketModeEvents(setting(env, 'SLACK_APP_TOKEN')!, log)),
    reply: slackReply(api),
    link: slackLink(api),
    statePath: join(root, 'state.slack.json'),
  }
}

/** Für `npm run steps`: Antworten nach Slack, wenn Bot-Token und Channel gesetzt sind. */
export function slackReplyFromEnv(env: Env): ChatReply | undefined {
  const token = setting(env, 'SLACK_BOT_TOKEN')
  const channel = setting(env, 'SLACK_CHANNEL_ID')
  return token === undefined || channel === undefined ? undefined : slackReply(webApiClient(token, channel))
}
