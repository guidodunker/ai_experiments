import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRouterModel } from './llm.ts'
import { runOnce, type RunDeps } from './run.ts'
import { formatTimestamp } from './tickets.ts'
import { createSerialRunner, watchChat } from './watch.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.env.OPENROUTER_MODEL ?? '~anthropic/claude-haiku-latest'
/** Editoren speichern auch halb getippte Zeilen; erst nach einer Tipp-Pause auswerten. */
const DEBOUNCE_MS = 3000

const LOG_FILE = join(ROOT, 'agent.log')

/** Konsole und agent.log; dort stehen auch die Begründungen des Modells. */
function log(message: string): void {
  process.stderr.write(`${message}\n`)
  appendFileSync(LOG_FILE, `${formatTimestamp(new Date())} ${message}\n`)
}

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

  const deps: RunDeps = {
    chatPath: process.env.CHAT_FILE ?? join(ROOT, 'chat.txt'),
    statePath: join(ROOT, 'state.json'),
    ticketDir: join(ROOT, 'tickets'),
    runModel: openRouterModel(apiKey, MODEL),
    log,
  }

  if (!process.argv.includes('--watch')) {
    try {
      if ((await runOnce(deps)) === 'missing') {
        log(`${deps.chatPath} nicht gefunden.`)
        return 1
      }
      return 0
    } catch (error) {
      log(describeError(error))
      return 1
    }
  }

  const trigger = createSerialRunner(async () => {
    if ((await runOnce(deps)) === 'missing') log(`Warte auf ${deps.chatPath} …`)
  }, (error) => log(describeError(error)))

  // Der Watcher hält den Prozess am Leben, bis Strg+C.
  watchChat(deps.chatPath, () => void trigger(), DEBOUNCE_MS)
  log(`Beobachte ${deps.chatPath} mit ${MODEL} (Strg+C beendet).`)
  await trigger()
  return undefined
}

process.exitCode = await main()
