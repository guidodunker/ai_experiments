import { z } from 'zod'
import { runShell, tailLines } from '../command.ts'
import { addWorktree, branchExists, changedFiles, commitAll, git, removeWorktree } from '../git.ts'
import type { Ticket } from '../ticketfile.ts'
import {
  branchName,
  bulletList,
  firstSentence,
  isUnder,
  loadPrompt,
  outputSchema,
  quoteTicket,
  toRepoPath,
  workdirOf,
  worktreePath,
} from './common.ts'
import type { Publisher, PullInput } from './publish.ts'
import type { RunSession } from './session.ts'
import type { Step, StepResult } from './types.ts'

const PROMPT = loadPrompt('fix')
const MAX_TURNS = 40
const OUTPUT_LINES = 30

export const FixOutput = z.object({ zusammenfassung: z.string(), dateien: z.array(z.string()) })
type FixOutput = z.infer<typeof FixOutput>

const SCHEMA = outputSchema(FixOutput)

export type FixDeps = {
  repo: string
  /** Basis des Pull Requests */
  base: string
  testCommand: string
  worktreeRoot: string
  runSession: RunSession
  publish: Publisher
  /** Bezeichnung des Tickets für Titel und Text des Pull Requests, z. B. '#7' */
  label: (id: number) => string
  /** Arbeitsbereich relativ zum Repo; Default: das ganze Repo */
  targetDir?: string
  /** Default: bugfix/bug-N */
  branchName?: (id: number) => string
}

function planSummary(body: string): string {
  return /(?:^|\n)## Plan\n### Zusammenfassung\n([\s\S]*?)(?=\n#{2,3} |\s*$)/.exec(body)?.[1]?.trim() ?? '–'
}

function pullBody(label: string, fixSummary: string, plan: string, test: string): string {
  return [
    `Automatischer Fix des Bugfix-Agenten für ${label}.`,
    '',
    `Bezug: ${label}`,
    '',
    '## Fix',
    fixSummary,
    '',
    '## Plan',
    plan,
    '',
    '## Test',
    `\`${test}\``,
  ].join('\n')
}

function formatFix(output: FixOutput, changed: string[], url?: string, reason?: string): string {
  const parts = ['### Zusammenfassung', output.zusammenfassung.trim(), '', '### Geänderte Dateien', bulletList(changed)]
  if (url !== undefined) parts.push('', '### Pull Request', url)
  if (reason !== undefined) parts.push('', '### Prüfung gescheitert', reason)
  return parts.join('\n')
}

/** Prüft selbst, was die Sitzung behauptet. undefined, wenn alles passt, sonst der Grund. */
async function verifyFix(
  changed: string[],
  targetDir: string,
  testFile: string,
  testCommand: string,
  workdir: string,
): Promise<string | undefined> {
  if (changed.length === 0) return 'Die Sitzung hat nichts geändert.'
  const outside = changed.filter((file) => !isUnder(targetDir, file))
  if (outside.length > 0) return `Änderungen außerhalb von ${targetDir}: ${outside.join(', ')}`
  if (changed.includes(toRepoPath(targetDir, testFile))) return `Die Testdatei ${testFile} wurde geändert.`
  const run = await runShell(testCommand, workdir)
  if (run.code !== 0) return `Die Tests laufen nach dem Fix nicht grün:\n${tailLines(run.output, OUTPUT_LINES)}`
  return undefined
}

export function createFixStep(deps: FixDeps): Step {
  async function openPull(input: PullInput): Promise<string> {
    return (await deps.publish.findOpenPull(input.head)) ?? (await deps.publish.createPull(input))
  }

  return {
    name: 'fix',
    accepts: 'geplant',
    async run(ticket: Ticket): Promise<StepResult> {
      const id = ticket.id
      const label = deps.label(id)
      const title = ticket.header.get('titel') ?? ''
      const test = ticket.header.get('test') ?? ''
      const testFile = test.split(' › ')[0]?.trim() ?? ''
      if (testFile === '') throw new Error('Das Ticket hat kein Kopffeld test.')
      const branch = ticket.header.get('branch') ?? (deps.branchName ?? branchName)(id)
      if (!(await branchExists(deps.repo, branch))) {
        throw new Error(`Branch ${branch} fehlt. Status auf neu setzen, dann wird neu analysiert.`)
      }
      const pull = (fixSummary: string): PullInput => ({
        title: `Fix ${label}: ${title}`,
        head: branch,
        base: deps.base,
        body: pullBody(label, fixSummary, planSummary(ticket.body), test),
      })

      // Ein früherer Lauf hat gepusht, aber keinen PR angelegt: nur den PR nachholen.
      const local = (await git(deps.repo, ['rev-parse', branch])).trim()
      const subject = (await git(deps.repo, ['log', '-1', '--format=%s', branch])).trim()
      if (subject.startsWith(`bug ${id}: Fix`) && (await deps.publish.remoteHead(branch)) === local) {
        const url = await openPull(pull('Siehe Commit auf dem Branch.'))
        return {
          status: 'pr_offen',
          fields: { pr: url },
          section: { heading: 'Fix', text: `### Pull Request\n${url}` },
          summary: `PR nachgeholt: ${url}`,
        }
      }

      const worktree = worktreePath(deps.worktreeRoot, branch)
      await removeWorktree(deps.repo, worktree)
      await addWorktree(deps.repo, worktree, branch)
      try {
        const red = (
          await git(worktree, ['log', '--format=%H', '-n', '1', '--fixed-strings', `--grep=bug ${id}: roter Test`])
        ).trim()
        if (red === '') throw new Error(`Auf ${branch} fehlt der Commit „bug ${id}: roter Test“.`)
        // Reste eines früheren Versuchs fallen weg, z. B. ein nicht gepushter Fix-Commit.
        await git(worktree, ['reset', '-q', '--hard', red])

        const targetDir = deps.targetDir ?? ''
        const workdir = workdirOf(worktree, targetDir)
        const session = await deps.runSession({
          mode: 'fix',
          cwd: workdir,
          instructions: PROMPT,
          prompt: `Testkommando: ${deps.testCommand}\n\n${quoteTicket(ticket)}`,
          schema: SCHEMA,
          maxTurns: MAX_TURNS,
        })
        const output = FixOutput.parse(session.output)
        const cost = session.costUsd.toFixed(2)
        const changed = await changedFiles(worktree)
        const reason = await verifyFix(changed, targetDir, testFile, deps.testCommand, workdir)
        if (reason !== undefined) {
          return {
            status: 'fix_gescheitert',
            fields: { kosten_fix: cost },
            section: { heading: 'Fix', text: formatFix(output, changed, undefined, reason) },
            summary: `(${cost} $): ${firstSentence(reason)}`,
          }
        }

        await commitAll(worktree, `bug ${id}: Fix – ${title}`)
        await deps.publish.push(worktree, branch)
        const url = await openPull(pull(output.zusammenfassung.trim()))
        return {
          status: 'pr_offen',
          fields: { pr: url, kosten_fix: cost },
          section: { heading: 'Fix', text: formatFix(output, changed, url) },
          summary: `(${cost} $): ${firstSentence(output.zusammenfassung)} ${url}`,
        }
      } finally {
        await removeWorktree(deps.repo, worktree)
      }
    },
  }
}
