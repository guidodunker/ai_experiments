import { branchExists, deleteBranch } from '../git.ts'
import type { GitHubApi } from '../store/github.ts'
import type { Ticket } from '../ticketfile.ts'
import { branchName } from './common.ts'
import type { Step, StepResult } from './types.ts'

export type MergeGitHub = Pick<GitHubApi, 'getPull' | 'mergePull' | 'deleteBranch'>

export type MergeDeps = {
  repo: string
  /** Ziel des Merges, nur für Texte; das eigentliche Ziel steht im PR */
  base: string
  github: MergeGitHub
  closeTicket: (id: number) => Promise<void>
  label: (id: number) => string
  log: (message: string) => void
  /** Default: bugfix/bug-N */
  branchName?: (id: number) => string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(reason: string): StepResult {
  return { status: 'merge_gescheitert', section: { heading: 'Merge', text: `### Grund\n${reason}` }, summary: reason }
}

export function createMergeStep(deps: MergeDeps): Step {
  return {
    name: 'merge',
    accepts: 'freigegeben',
    async run(ticket: Ticket): Promise<StepResult> {
      const id = ticket.id
      const pr = ticket.header.get('pr')
      const number = Number(/(\d+)\/?$/.exec(pr ?? '')?.[1])
      if (pr === undefined || !Number.isInteger(number)) {
        throw new Error('Das Ticket hat kein Kopffeld pr mit PR-Nummer.')
      }
      const branch = ticket.header.get('branch') ?? (deps.branchName ?? branchName)(id)
      const title = ticket.header.get('titel') ?? ''

      const pull = await deps.github.getPull(number)
      let sha = pull.mergeCommit
      if (!pull.merged) {
        if (pull.state === 'closed') return failed(`PR #${number} ist geschlossen.`)
        const result = await deps.github.mergePull(number, `Fix ${deps.label(id)}: ${title} (#${number})`)
        if (!result.merged) return failed(`PR #${number} ließ sich nicht mergen: ${result.message}`)
        sha = result.sha
      }

      // Aufräumen darf scheitern, der Merge zählt trotzdem.
      try {
        await deps.github.deleteBranch(branch)
      } catch (error) {
        deps.log(`Warnung: Branch ${branch} auf GitHub nicht gelöscht: ${message(error)}`)
      }
      if (await branchExists(deps.repo, branch)) {
        try {
          await deleteBranch(deps.repo, branch)
        } catch (error) {
          deps.log(`Warnung: Branch ${branch} lokal nicht gelöscht: ${message(error)}`)
        }
      }

      // Scheitert das, bleibt der Status freigegeben; der nächste Lauf findet den PR gemergt und holt es nach.
      await deps.closeTicket(id)
      return {
        status: 'erledigt',
        fields: { merge_commit: sha ?? '' },
        section: {
          heading: 'Merge',
          text: ['### Pull Request', pr, '', '### Merge-Commit', sha ?? '–', '', '### Basis', deps.base].join('\n'),
        },
        summary: `gemergt in ${deps.base}: ${pr}`,
      }
    },
  }
}
