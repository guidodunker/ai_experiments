import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runShell } from '../src/command.ts'
import { initDemo } from '../src/demo.ts'
import { changedFiles, git } from '../src/git.ts'

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
