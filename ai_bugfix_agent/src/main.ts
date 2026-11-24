import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRouterModel } from './llm.ts'
import { createLog } from './log.ts'
import { runOnce, type RunDeps } from './run.ts'
import { chooseChat } from './sources/config.ts'
import { createSerialRunner } from './watch.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.env.OPENROUTER_MODEL ?? '~anthropic/claude-haiku-latest'

const log = createLog(join(ROOT, 'agent.log'))

function describeError(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? ` (HTTP ${String((error as { statusCode: unknown }).statusCode)})`
      : ''
  return `Fehler${status}: ${error instanceof Error ? error.message : String(error)}`
}

/** Exit-Codes: 2 = falsch aufgerufen, 1 = Lauf fehlgeschlagen. */
async function main(): Promise<number | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey === undefined || apiKey.trim() === '') {
    log('OPENROUTER_API_KEY fehlt. Trage ihn in .env ein (siehe .env.example).')
    return 2
  }

  const chat = chooseChat(process.env, ROOT, log)
  if ('error' in chat) {
    log(chat.error)
    return 2
  }

  const deps: RunDeps = {
    source: chat.source,
    reply: chat.reply,
    link: chat.link,
    statePath: chat.statePath,
    ticketDir: join(ROOT, 'tickets'),
    runModel: openRouterModel(apiKey, MODEL),
    log,
  }

  if (!process.argv.includes('--watch')) {
    try {
      if ((await runOnce(deps)) === 'missing') {
        log(`${chat.source.label} nicht gefunden.`)
        return 1
      }
      return 0
    } catch (error) {
      log(describeError(error))
      return 1
    }
  }

  const trigger = createSerialRunner(async () => {
    if ((await runOnce(deps)) === 'missing') log(`Warte auf ${chat.source.label} …`)
  }, (error) => log(describeError(error)))

  // Watcher bzw. Socket-Verbindung halten den Prozess am Leben, bis Strg+C.
  chat.source.watch(() => void trigger())
  log(`Beobachte ${chat.source.label} mit ${MODEL} (Strg+C beendet).`)
  await trigger()
  return undefined
}

process.exitCode = await main()
