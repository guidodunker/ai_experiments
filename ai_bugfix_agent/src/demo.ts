import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { commitAll, initRepo } from './git.ts'

/** Kopiert die Vorlage nach `target` und legt dort ein Git-Repo mit einem ersten Commit auf `main` an. */
export async function initDemo(template: string, target: string): Promise<void> {
  if (existsSync(target)) throw new Error(`${target} existiert schon.`)
  await cp(template, target, { recursive: true })
  await initRepo(target)
  await commitAll(target, 'Kontaktliste')
}
