import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { addWorktree, removeWorktree } from '../git.ts'
import type { Ticket } from '../ticketfile.ts'
import {
  branchName,
  bulletList,
  firstSentence,
  loadPrompt,
  outputSchema,
  quoteTicket,
  workdirOf,
  worktreePath,
} from './common.ts'
import { isInside } from './policy.ts'
import type { RunSession } from './session.ts'
import type { Step, StepResult } from './types.ts'

const PROMPT = loadPrompt('plan')
const MAX_TURNS = 25

export const PlanOutput = z.object({
  zusammenfassung: z.string(),
  schritte: z.array(z.object({ datei: z.string(), neu: z.boolean(), aenderung: z.string() })),
  risiken: z.array(z.string()),
  offene_fragen: z.array(z.string()),
})
export type PlanOutput = z.infer<typeof PlanOutput>

const SCHEMA = outputSchema(PlanOutput)

export type PlanDeps = {
  repo: string
  worktreeRoot: string
  runSession: RunSession
  /** Default: bugfix/bug-N */
  branchName?: (id: number) => string
  /** Arbeitsbereich relativ zum Repo; Default: das ganze Repo */
  targetDir?: string
}

function formatPlan(output: PlanOutput): string {
  const steps = output.schritte.map(
    (s, i) => `${i + 1}. ${s.datei}${s.neu ? ' (neu)' : ''} – ${s.aenderung}`,
  )
  return [
    '### Zusammenfassung',
    output.zusammenfassung.trim(),
    '',
    '### Schritte',
    steps.join('\n'),
    '',
    '### Risiken',
    bulletList(output.risiken),
    '',
    '### Offene Fragen',
    bulletList(output.offene_fragen),
  ].join('\n')
}

export function createPlanStep(deps: PlanDeps): Step {
  return {
    name: 'plan',
    accepts: 'analysiert',
    async run(ticket: Ticket): Promise<StepResult> {
      const branch = ticket.header.get('branch') ?? (deps.branchName ?? branchName)(ticket.id)
      const worktree = worktreePath(deps.worktreeRoot, branch)
      await removeWorktree(deps.repo, worktree)
      await addWorktree(deps.repo, worktree, branch)
      const workdir = workdirOf(worktree, deps.targetDir ?? '')
      try {
        const session = await deps.runSession({
          mode: 'plan',
          cwd: workdir,
          instructions: PROMPT,
          prompt: quoteTicket(ticket),
          schema: SCHEMA,
          maxTurns: MAX_TURNS,
        })
        const output = PlanOutput.parse(session.output)
        if (output.schritte.length === 0) throw new Error('Der Plan enthält keine Schritte.')
        for (const step of output.schritte) {
          if (!isInside(workdir, step.datei)) throw new Error(`Der Plan nennt ${step.datei} außerhalb des Repos.`)
          if (!step.neu && !existsSync(resolve(workdir, step.datei))) {
            throw new Error(`Der Plan nennt ${step.datei}, die Datei gibt es nicht.`)
          }
        }
        const cost = session.costUsd.toFixed(2)
        return {
          status: 'geplant',
          fields: { kosten_plan: cost },
          section: { heading: 'Plan', text: formatPlan(output) },
          summary: `(${cost} $): ${firstSentence(output.zusammenfassung)}`,
        }
      } finally {
        await removeWorktree(deps.repo, worktree)
      }
    },
  }
}
