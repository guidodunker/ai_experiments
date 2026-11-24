import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRouterModel } from './llm.ts'
import { createLog } from './log.ts'
import { runOnce, type RunDeps } from './run.ts'
import { fileReply, fileSource } from './sources/file.ts'
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

  const source = fileSource(process.env.CHAT_FILE ?? join(ROOT, 'chat.txt'))
  const deps: RunDeps = {
    source,
    reply: fileReply(log),
    statePath: join(ROOT, 'state.json'),
    ticketDir: join(ROOT, 'tickets'),
    runModel: openRouterModel(apiKey, MODEL),
    log,
  }

  if (!process.argv.includes('--watch')) {
    try {
      if ((await runOnce(deps)) === 'missing') {
        log(`${source.label} nicht gefunden.`)
        return 1
      }
      return 0
    } catch (error) {
      log(describeError(error))
      return 1
    }
  }

  const trigger = createSerialRunner(async () => {
    if ((await runOnce(deps)) === 'missing') log(`Warte auf ${source.label} …`)
  }, (error) => log(describeError(error)))

  // Der Watcher hält den Prozess am Leben, bis Strg+C.
  source.watch(() => void trigger())
  log(`Beobachte ${source.label} mit ${MODEL} (Strg+C beendet).`)
  await trigger()
  return undefined
}

process.exitCode = await main()
