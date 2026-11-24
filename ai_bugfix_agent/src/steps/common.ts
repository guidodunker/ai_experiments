import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { z } from 'zod'
import { formatTicketFile, type Ticket } from '../ticketfile.ts'

/**
 * JSON-Schema für `outputFormat`. Ohne `$schema`: zod trägt Draft 2020-12 ein,
 * und Claude Code lehnt das Schema dann als ungültig ab.
 */
export function outputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

export function branchName(id: number): string {
  return `bugfix/bug-${id}`
}

/** Fester Pfad je Branch, damit ein Folgelauf liegengebliebene Worktrees findet. */
export function worktreePath(root: string, branch: string): string {
  return join(root, branch.replaceAll('/', '-'))
}

function normalizeDir(targetDir: string): string {
  return targetDir.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
}

/** Arbeitsbereich der Sitzung im Worktree; leeres `targetDir` = ganzer Worktree */
export function workdirOf(worktree: string, targetDir: string): string {
  const dir = normalizeDir(targetDir)
  return dir === '' ? worktree : join(worktree, dir)
}

/** Pfad relativ zum Arbeitsbereich → relativ zum Repo, mit `/` getrennt, wie `git status` ihn nennt */
export function toRepoPath(targetDir: string, path: string): string {
  const dir = normalizeDir(targetDir)
  const file = posix.normalize(path.replaceAll('\\', '/'))
  return dir === '' ? file : `${dir}/${file}`
}

/** Liegt ein Repo-Pfad im Arbeitsbereich? */
export function isUnder(targetDir: string, repoPath: string): boolean {
  const dir = normalizeDir(targetDir)
  return dir === '' || repoPath === dir || repoPath.startsWith(`${dir}/`)
}

/** Erster Satz der ersten Zeile, für die Logzeile. */
export function firstSentence(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim()
  const end = line.search(/[.!?](\s|$)/)
  return end === -1 ? line : line.slice(0, end + 1)
}

/** Das Ticket als markierter Block. Die Endmarke im Text wird entschärft, damit er den Block nicht schließt. */
export function quoteTicket(ticket: Ticket): string {
  const text = formatTicketFile(ticket).trimEnd().replaceAll('TICKET>>>', 'TICKET> > >')
  return `<<<TICKET\n${text}\nTICKET>>>`
}

export function loadPrompt(name: 'analyze' | 'plan'): string {
  return readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8')
}

export function bulletList(items: string[]): string {
  return items.length === 0 ? '- keine' : items.map((item) => `- ${item}`).join('\n')
}
