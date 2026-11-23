import { relative, resolve } from 'node:path'
import { z } from 'zod'
import { runShell, tailLines } from '../command.ts'
import { addWorktree, branchExists, changedFiles, commitFile, deleteBranch, removeWorktree } from '../git.ts'
import type { Ticket } from '../ticketfile.ts'
import { branchName, bulletList, firstSentence, loadPrompt, outputSchema, quoteTicket, worktreePath } from './common.ts'
import type { RunSession } from './session.ts'
import type { Step, StepResult } from './types.ts'

const PROMPT = loadPrompt('analyze')
const MAX_TURNS = 40
const OUTPUT_LINES = 30

export const AnalyzeOutput = z.object({
  reproduziert: z.boolean(),
  ursache: z.string(),
  stellen: z.array(
    z.object({ datei: z.string(), zeile: z.number().int().optional(), beschreibung: z.string() }),
  ),
  testdatei: z.string().optional(),
  testname: z.string().optional(),
  fehlende_angaben: z.array(z.string()),
})
export type AnalyzeOutput = z.infer<typeof AnalyzeOutput>

const SCHEMA = outputSchema(AnalyzeOutput)

export type AnalyzeDeps = {
  repo: string
  base: string
  testCommand: string
  worktreeRoot: string
  runSession: RunSession
}

type Check = { ok: true; file: string; testOutput: string } | { ok: false; reason: string }

/** Prüft selbst, was die Sitzung behauptet: genau die Testdatei geändert, Test rot, Name in der Ausgabe. */
async function verifyRedTest(worktree: string, output: AnalyzeOutput, testCommand: string): Promise<Check> {
  if (output.testdatei === undefined || output.testname === undefined) {
    return { ok: false, reason: 'Das Ergebnis nennt keine Testdatei oder keinen Testnamen.' }
  }
  const file = relative(worktree, resolve(worktree, output.testdatei)).replaceAll('\\', '/')
  const changed = await changedFiles(worktree)
  if (changed.length !== 1 || changed[0] !== file) {
    return { ok: false, reason: `Erwartet war nur eine Änderung an ${file}, geändert: ${changed.join(', ') || 'nichts'}.` }
  }
  const run = await runShell(testCommand, worktree)
  if (run.code === 0) return { ok: false, reason: 'Mit dem neuen Test laufen alle Tests grün.' }
  if (!run.output.includes(output.testname)) {
    return { ok: false, reason: `Der Testname „${output.testname}“ kommt in der Testausgabe nicht vor.` }
  }
  return { ok: true, file, testOutput: excerptFrom(run.output, output.testname) }
}

/** Ausschnitt ab der ersten Zeile mit `needle`; die Zusammenfassung am Ende der Ausgabe zeigt den Fehler nicht. */
function excerptFrom(text: string, needle: string): string {
  const lines = text.trimEnd().split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes(needle))
  return lines.slice(start, start + OUTPUT_LINES).join('\n')
}

function formatAnalysis(output: AnalyzeOutput, check: Check | undefined): string {
  const places = output.stellen.map(
    (s) => `${s.datei}${s.zeile === undefined ? '' : `:${s.zeile}`} – ${s.beschreibung}`,
  )
  const parts = ['### Ursache', output.ursache.trim(), '', '### Stellen', bulletList(places)]
  if (check?.ok) parts.push('', '### Roter Test', '```text', check.testOutput, '```')
  if (output.fehlende_angaben.length > 0) parts.push('', '### Fehlende Angaben', bulletList(output.fehlende_angaben))
  if (check !== undefined && !check.ok) parts.push('', '### Prüfung gescheitert', check.reason)
  return parts.join('\n')
}

export function createAnalyzeStep(deps: AnalyzeDeps): Step {
  return {
    name: 'analyze',
    accepts: 'neu',
    async run(ticket: Ticket): Promise<StepResult> {
      const branch = branchName(ticket.id)
      const worktree = worktreePath(deps.worktreeRoot, ticket.id)
      await removeWorktree(deps.repo, worktree)
      if (await branchExists(deps.repo, branch)) {
        throw new Error(`Branch ${branch} existiert schon. Löschen mit: git -C "${deps.repo}" branch -D ${branch}`)
      }
      await addWorktree(deps.repo, worktree, branch, deps.base)

      let keepBranch = false
      try {
        const baseline = await runShell(deps.testCommand, worktree)
        if (baseline.code !== 0) {
          throw new Error(`Tests auf ${deps.base} schlagen schon fehl:\n${tailLines(baseline.output, OUTPUT_LINES)}`)
        }

        const session = await deps.runSession({
          mode: 'analyze',
          cwd: worktree,
          instructions: PROMPT,
          prompt: `Testkommando: ${deps.testCommand}\n\n${quoteTicket(ticket)}`,
          schema: SCHEMA,
          maxTurns: MAX_TURNS,
        })
        const output = AnalyzeOutput.parse(session.output)
        const cost = session.costUsd.toFixed(2)
        const check = output.reproduziert ? await verifyRedTest(worktree, output, deps.testCommand) : undefined
        const section = { heading: 'Analyse', text: formatAnalysis(output, check) }

        if (check?.ok) {
          await commitFile(worktree, check.file, `bug ${ticket.id}: roter Test – ${ticket.header.get('titel') ?? ''}`)
          keepBranch = true
          return {
            status: 'analysiert',
            fields: { branch, test: `${check.file} › ${output.testname ?? ''}`, kosten_analyse: cost },
            section,
            summary: `(${cost} $): ${firstSentence(output.ursache)}`,
          }
        }
        return {
          status: 'nicht_reproduziert',
          fields: { kosten_analyse: cost },
          section,
          summary: `(${cost} $): ${check === undefined ? firstSentence(output.ursache) : check.reason}`,
        }
      } finally {
        await removeWorktree(deps.repo, worktree)
        // Ein Branch ohne roten Test hat keinen Wert; ein erneuter Versuch beginnt sauber.
        if (!keepBranch) await deleteBranch(deps.repo, branch)
      }
    },
  }
}
