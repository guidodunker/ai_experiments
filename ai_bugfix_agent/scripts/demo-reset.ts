import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetDemo } from '../src/demo.ts'
import { git } from '../src/git.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Tag auf dem Commit, der die Vorlage mit den drei Bugs angelegt hat.
const source = process.env.DEMO_SOURCE?.trim() || 'demo-start'

try {
  const repo = (await git(ROOT, ['rev-parse', '--show-toplevel'])).trim()
  const dir = relative(repo, join(ROOT, 'demo')).replaceAll('\\', '/')
  if (await resetDemo(repo, dir, source)) {
    const branch = (await git(repo, ['branch', '--show-current'])).trim()
    console.error(`${dir} auf ${source} zurückgesetzt und committet.`)
    console.error(`Damit Fixes und Pull Requests davon ausgehen: git push origin ${branch}`)
  } else {
    console.error(`${dir} entspricht schon ${source}, nichts zu tun.`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
