import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { commitAll, initRepo } from '../../src/git.ts'

/** Legt ein Git-Repo mit den Dateien an und committet sie auf `main`. */
export async function createRepo(files: Record<string, string>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'bugagent-repo-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, name)), { recursive: true })
    await writeFile(join(repo, name), content)
  }
  await initRepo(repo)
  await commitAll(repo, 'Start')
  return repo
}
