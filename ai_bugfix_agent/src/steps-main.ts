import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isGitRepo } from './git.ts'
import { createLog } from './log.ts'
import { slackReplyFromEnv } from './sources/config.ts'
import { createAnalyzeStep } from './steps/analyze.ts'
import { createPlanStep } from './steps/plan.ts'
import { runSteps } from './steps/runner.ts'
import { agentSdkSession } from './steps/session.ts'
import { fileStore } from './store/file.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const log = createLog(join(ROOT, 'agent.log'))

function setting(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Exit-Codes: 2 = falsch aufgerufen, 1 = Lauf oder mindestens ein Schritt gescheitert. */
async function main(): Promise<number> {
  const repoSetting = setting('TARGET_REPO')
  if (repoSetting === undefined) {
    log('TARGET_REPO fehlt. Trage es in .env ein (siehe .env.example).')
    return 2
  }
  const repo = resolve(ROOT, repoSetting)
  if (!(await isGitRepo(repo))) {
    log(`${repo} ist kein Git-Repo.`)
    return 2
  }

  const ticketSetting = setting('TICKET')
  const only = ticketSetting === undefined ? undefined : Number(ticketSetting)
  if (only !== undefined && !Number.isInteger(only)) {
    log(`TICKET=${ticketSetting} ist keine Ticketnummer.`)
    return 2
  }

  const budget = Number(setting('STEPS_MAX_BUDGET_USD') ?? '2')
  if (!(budget > 0)) {
    log('STEPS_MAX_BUDGET_USD muss eine positive Zahl sein.')
    return 2
  }

  const testCommand = setting('TARGET_TEST_CMD') ?? 'npm test'
  const model = setting('STEPS_MODEL') ?? 'claude-opus-5'
  const runSession = agentSdkSession({ model, maxBudgetUsd: budget, testCommand, log })
  const store = fileStore(join(ROOT, 'tickets'))
  const common = { repo, worktreeRoot: tmpdir(), runSession, branchName: (id: number) => store.branch(id) }

  log(`Schritte für ${repo} mit ${model}${only === undefined ? '' : `, nur Ticket ${only}`}.`)
  try {
    const failed = await runSteps({
      store,
      lockPath: join(ROOT, 'steps.lock'),
      log,
      only,
      reply: slackReplyFromEnv(process.env),
      steps: [
        createAnalyzeStep({ ...common, base: setting('TARGET_BASE') ?? 'main', testCommand }),
        createPlanStep(common),
      ],
    })
    return failed === 0 ? 0 : 1
  } catch (error) {
    log(`Fehler: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exitCode = await main()
