import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runShell } from '../src/command.ts'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { initDemo, resetDemo } from '../src/demo.ts'
import { changedFiles, commitAll, git } from '../src/git.ts'
import { createRepo } from './helpers/repo.ts'

const TEMPLATE = fileURLToPath(new URL('../demo', import.meta.url))

async function target(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'bugagent-demo-')), 'kontaktliste')
}

test('initDemo: Repo mit einem Commit auf main, Tests grün', async () => {
  const dir = await target()
  await initDemo(TEMPLATE, dir)
  assert.equal((await git(dir, ['rev-list', '--count', 'main'])).trim(), '1')
  assert.deepEqual(await changedFiles(dir), [])
  const run = await runShell('npm test', dir)
  assert.equal(run.code, 0, run.output)
})

test('initDemo: vorhandenes Ziel wird nicht angefasst', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-demo-'))
  await assert.rejects(initDemo(TEMPLATE, dir), /existiert schon/)
})

test('die drei Demo-Bugs lassen sich mit je einem Test zeigen', async () => {
  const dir = await target()
  await initDemo(TEMPLATE, dir)
  await writeFile(
    join(dir, 'test', 'bugs.test.ts'),
    `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate, search, sortByName } from '../src/contacts.ts'

test('bug1', () => assert.equal(search([{ name: 'MÜLLER', city: '' }], 'müller').length, 1))
test('bug2', () => assert.deepEqual(paginate([1, 2, 3], 2, 2), [3]))
test('bug3', () => {
  const names = sortByName([{ name: 'Zander', city: '' }, { name: 'Ärger', city: '' }]).map((c) => c.name)
  assert.deepEqual(names, ['Ärger', 'Zander'])
})
`,
  )
  const run = await runShell('npm test', dir)
  assert.notEqual(run.code, 0)
  assert.match(run.output, /fail 3/, run.output)
})

async function repoWithFixedDemo() {
  const repo = await createRepo({ 'demo/a.txt': 'bug\n', 'other.txt': 'x\n' })
  await git(repo, ['tag', 'demo-start'])
  await writeFile(join(repo, 'demo', 'a.txt'), 'behoben\n')
  await writeFile(join(repo, 'demo', 'neu.test.txt'), 'test\n')
  await writeFile(join(repo, 'other.txt'), 'y\n')
  await commitAll(repo, 'Fix')
  return repo
}

test('resetDemo: Vorlage auf den Startstand, neue Dateien weg, Rest unberührt, ein Commit', async () => {
  const repo = await repoWithFixedDemo()
  assert.equal(await resetDemo(repo, 'demo', 'demo-start'), true)
  assert.equal(await readFile(join(repo, 'demo', 'a.txt'), 'utf8'), 'bug\n')
  assert.equal(existsSync(join(repo, 'demo', 'neu.test.txt')), false)
  assert.equal(await readFile(join(repo, 'other.txt'), 'utf8'), 'y\n')
  assert.equal((await git(repo, ['log', '-1', '--format=%s'])).trim(), 'Bugfix-Agent: Demo-Vorlage auf demo-start zurückgesetzt')
  assert.deepEqual(await changedFiles(repo), [])
})

test('resetDemo: schon auf dem Startstand, kein Commit', async () => {
  const repo = await repoWithFixedDemo()
  await resetDemo(repo, 'demo', 'demo-start')
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  assert.equal(await resetDemo(repo, 'demo', 'demo-start'), false)
  assert.equal((await git(repo, ['rev-parse', 'HEAD'])).trim(), head)
})

test('resetDemo: nicht committete Änderungen in der Vorlage, Abbruch', async () => {
  const repo = await repoWithFixedDemo()
  await writeFile(join(repo, 'demo', 'a.txt'), 'in Arbeit\n')
  await assert.rejects(resetDemo(repo, 'demo', 'demo-start'), /nicht committete Änderungen/)
  assert.equal(await readFile(join(repo, 'demo', 'a.txt'), 'utf8'), 'in Arbeit\n')
})