import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { commitAll, commitPath, git, initRepo } from './git.ts'

/** Kopiert die Vorlage nach `target` und legt dort ein Git-Repo mit einem ersten Commit auf `main` an. */
export async function initDemo(template: string, target: string): Promise<void> {
  if (existsSync(target)) throw new Error(`${target} existiert schon.`)
  await cp(template, target, { recursive: true })
  await initRepo(target)
  await commitAll(target, 'Kontaktliste')
}

/**
 * Setzt die Vorlage `dir` im Repo auf den Stand von `source` zurück, z. B. nach
 * einem gemergten Fix, und committet das. Dateien, die es in `source` nicht gab,
 * fallen weg. false, wenn die Vorlage schon so aussah.
 */
export async function resetDemo(repo: string, dir: string, source: string): Promise<boolean> {
  if ((await git(repo, ['status', '--porcelain', '--', dir])).trim() !== '') {
    throw new Error(`${dir} hat nicht committete Änderungen. Erst committen oder verwerfen.`)
  }
  await git(repo, ['restore', `--source=${source}`, '--staged', '--worktree', '--', dir])
  if ((await git(repo, ['status', '--porcelain', '--', dir])).trim() === '') return false
  await commitPath(repo, dir, `Bugfix-Agent: Demo-Vorlage auf ${source} zurückgesetzt`)
  return true
}
