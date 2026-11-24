import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitFile, git } from '../src/git.ts'
import { createFixStep } from '../src/steps/fix.ts'
import type { Publisher, PullInput } from '../src/steps/publish.ts'
import type { RunSession, SessionRequest } from '../src/steps/session.ts'
import { parseTicket } from '../src/ticketfile.ts'
import { createRepo } from './helpers/repo.ts'

const TEST_CMD = 'node --test'
const BRANCH = 'bugfix/issue-7'
const ticket = parseTicket(
  [
    'id: 7',
    'status: geplant',
    'titel: Summe falsch',
    `branch: ${BRANCH}`,
    'test: test/sum-bug.test.mjs › sum addiert zwei Zahlen',
    '',
    '## Plan',
    '### Zusammenfassung',
    'In sum.mjs plus statt minus.',
    '',
    '### Schritte',
    '1. sum.mjs – a + b',
    '',
  ].join('\n'),
)

const RED_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum } from '../sum.mjs'
test('sum addiert zwei Zahlen', () => assert.equal(sum(2, 3), 5))
`
const FIXED = 'export const sum = (a, b) => a + b\n'
const OUTPUT = { zusammenfassung: 'sum addiert jetzt. Der Test ist grün.', dateien: ['sum.mjs'] }

async function setup() {
  const repo = await createRepo({
    'sub/sum.mjs': 'export const sum = (a, b) => a - b\n',
    'sub/sum.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum } from './sum.mjs'
test('sum von 0 und 0', () => assert.equal(sum(0, 0), 0))
`,
    'README.md': 'Repo\n',
  })
  await git(repo, ['checkout', '-q', '-b', BRANCH])
  await mkdir(join(repo, 'sub', 'test'), { recursive: true })
  await writeFile(join(repo, 'sub', 'test', 'sum-bug.test.mjs'), RED_TEST)
  await commitFile(repo, 'sub/test/sum-bug.test.mjs', 'bug 7: roter Test – Summe falsch')
  await git(repo, ['checkout', '-q', 'main'])
  const bare = await mkdtemp(join(tmpdir(), 'bugagent-bare-'))
  await git(bare, ['init', '-q', '--bare'])
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'bugagent-wtroot-'))
  return { repo, bare, worktreeRoot, worktree: join(worktreeRoot, 'bugfix-issue-7') }
}

function publisher(bare: string, existingPull?: string) {
  const pulls: PullInput[] = []
  const pushes: string[] = []
  const p: Publisher = {
    remoteHead: async (branch) =>
      (await git(bare, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`])).trim() || undefined,
    push: async (worktree, branch) => {
      pushes.push(branch)
      await git(worktree, ['push', '-q', bare, `refs/heads/${branch}:refs/heads/${branch}`])
    },
    findOpenPull: async () => existingPull,
    createPull: async (input) => (pulls.push(input), 'https://github.com/o/r/pull/3'),
  }
  return { p, pulls, pushes }
}

function fakeSession(output: unknown, act?: (cwd: string) => Promise<void>) {
  const calls: SessionRequest[] = []
  const run: RunSession = async (request) => {
    calls.push(request)
    await act?.(request.cwd)
    return { output, costUsd: 0.6 }
  }
  return { run, calls }
}

function step(env: Awaited<ReturnType<typeof setup>>, run: RunSession, publish: Publisher) {
  return createFixStep({
    repo: env.repo,
    base: 'main',
    testCommand: TEST_CMD,
    worktreeRoot: env.worktreeRoot,
    targetDir: 'sub',
    runSession: run,
    publish,
    label: (id) => `#${id}`,
  })
}

const subjects = async (repo: string, branch: string) =>
  (await git(repo, ['log', '--format=%s', branch])).trim().split('\n')

test('Fix macht den Test grün: Commit, Push, Pull Request, pr_offen', async () => {
  const env = await setup()
  const pub = publisher(env.bare)
  const session = fakeSession(OUTPUT, (cwd) => writeFile(join(cwd, 'sum.mjs'), FIXED))
  const result = await step(env, session.run, pub.p).run(ticket)

  assert.equal(result.status, 'pr_offen')
  assert.deepEqual(result.fields, { pr: 'https://github.com/o/r/pull/3', kosten_fix: '0.60' })
  assert.equal(result.summary, '(0.60 $): sum addiert jetzt. https://github.com/o/r/pull/3')
  assert.equal(result.section?.heading, 'Fix')
  assert.match(result.section?.text ?? '', /### Geänderte Dateien\n- sub\/sum\.mjs/)
  assert.match(result.section?.text ?? '', /### Pull Request\nhttps:\/\/github\.com\/o\/r\/pull\/3/)

  assert.deepEqual(await subjects(env.bare, BRANCH), [
    'bug 7: Fix – Summe falsch',
    'bug 7: roter Test – Summe falsch',
    'Start',
  ])
  const pull = pub.pulls[0]!
  assert.equal(pull.title, 'Fix #7: Summe falsch')
  assert.equal(pull.head, BRANCH)
  assert.equal(pull.base, 'main')
  assert.match(pull.body, /Bezug: #7/)
  assert.match(pull.body, /In sum\.mjs plus statt minus\./)
  assert.match(pull.body, /test\/sum-bug\.test\.mjs › sum addiert zwei Zahlen/)

  const request = session.calls[0]!
  assert.equal(request.mode, 'fix')
  assert.equal(request.cwd, join(env.worktree, 'sub'))
  assert.equal(request.maxTurns, 40)
  assert.match(request.prompt, /^Testkommando: node --test\n\n<<<TICKET\nid: 7/)
  assert.equal(existsSync(env.worktree), false)
})

test('Testdatei geändert: fix_gescheitert, nichts gepusht, Branch unverändert', async () => {
  const env = await setup()
  const pub = publisher(env.bare)
  const session = fakeSession(OUTPUT, async (cwd) => {
    await writeFile(join(cwd, 'sum.mjs'), FIXED)
    await writeFile(join(cwd, 'test', 'sum-bug.test.mjs'), `${RED_TEST}// angepasst\n`)
  })
  const result = await step(env, session.run, pub.p).run(ticket)
  assert.equal(result.status, 'fix_gescheitert')
  assert.deepEqual(result.fields, { kosten_fix: '0.60' })
  assert.match(
    result.section?.text ?? '',
    /### Prüfung gescheitert\nDie Testdatei test\/sum-bug\.test\.mjs wurde geändert\./,
  )
  assert.deepEqual(pub.pushes, [])
  assert.equal((await subjects(env.repo, BRANCH))[0], 'bug 7: roter Test – Summe falsch')
})

test('Änderung außerhalb des Arbeitsbereichs: fix_gescheitert', async () => {
  const env = await setup()
  const session = fakeSession(OUTPUT, async (cwd) => {
    await writeFile(join(cwd, 'sum.mjs'), FIXED)
    await writeFile(join(cwd, '..', 'README.md'), 'geändert\n')
  })
  const result = await step(env, session.run, publisher(env.bare).p).run(ticket)
  assert.equal(result.status, 'fix_gescheitert')
  assert.match(result.section?.text ?? '', /Änderungen außerhalb von sub: README\.md/)
})

test('Tests bleiben rot: fix_gescheitert', async () => {
  const env = await setup()
  const session = fakeSession(OUTPUT, (cwd) => writeFile(join(cwd, 'sum.mjs'), 'export const sum = (a, b) => a * b\n'))
  const result = await step(env, session.run, publisher(env.bare).p).run(ticket)
  assert.equal(result.status, 'fix_gescheitert')
  assert.match(result.section?.text ?? '', /Die Tests laufen nach dem Fix nicht grün/)
})

test('Sitzung ändert nichts: fix_gescheitert', async () => {
  const env = await setup()
  const result = await step(env, fakeSession(OUTPUT).run, publisher(env.bare).p).run(ticket)
  assert.equal(result.status, 'fix_gescheitert')
  assert.match(result.section?.text ?? '', /Die Sitzung hat nichts geändert\./)
})

test('Branch fehlt: Fehler mit Hinweis, keine Sitzung', async () => {
  const env = await setup()
  const session = fakeSession(OUTPUT)
  const other = parseTicket('id: 9\nstatus: geplant\ntitel: X\nbranch: bugfix/issue-9\ntest: test/x.test.mjs › x\n\n## Plan\n')
  await assert.rejects(
    step(env, session.run, publisher(env.bare).p).run(other),
    /Branch bugfix\/issue-9 fehlt\. Status auf neu setzen/,
  )
  assert.equal(session.calls.length, 0)
})

test('PR-Anlage scheitert nach dem Push: nächster Lauf legt nur den PR an', async () => {
  const env = await setup()
  const pub = publisher(env.bare)
  const create = pub.p.createPull
  let fail = true
  pub.p.createPull = async (input) => {
    if (fail) {
      fail = false
      throw new Error('HTTP 502')
    }
    return create(input)
  }
  const first = fakeSession(OUTPUT, (cwd) => writeFile(join(cwd, 'sum.mjs'), FIXED))
  await assert.rejects(step(env, first.run, pub.p).run(ticket), /HTTP 502/)

  const second = fakeSession(OUTPUT)
  const result = await step(env, second.run, pub.p).run(ticket)
  assert.equal(second.calls.length, 0)
  assert.equal(result.status, 'pr_offen')
  assert.deepEqual(result.fields, { pr: 'https://github.com/o/r/pull/3' })
  assert.equal(result.summary, 'PR nachgeholt: https://github.com/o/r/pull/3')
  assert.equal(pub.pushes.length, 1)
})

test('Push scheitert: nächster Lauf setzt zurück und fixt neu, ein Fix-Commit', async () => {
  const env = await setup()
  const pub = publisher(env.bare)
  const push = pub.p.push
  let fail = true
  pub.p.push = async (worktree, branch) => {
    if (fail) {
      fail = false
      throw new Error('Push abgelehnt')
    }
    return push(worktree, branch)
  }
  const act = (cwd: string) => writeFile(join(cwd, 'sum.mjs'), FIXED)
  await assert.rejects(step(env, fakeSession(OUTPUT, act).run, pub.p).run(ticket), /Push abgelehnt/)
  const second = fakeSession(OUTPUT, act)
  const result = await step(env, second.run, pub.p).run(ticket)
  assert.equal(second.calls.length, 1)
  assert.equal(result.status, 'pr_offen')
  assert.deepEqual(await subjects(env.bare, BRANCH), [
    'bug 7: Fix – Summe falsch',
    'bug 7: roter Test – Summe falsch',
    'Start',
  ])
})

test('offener PR wird wiederverwendet', async () => {
  const env = await setup()
  const pub = publisher(env.bare, 'https://github.com/o/r/pull/1')
  const session = fakeSession(OUTPUT, (cwd) => writeFile(join(cwd, 'sum.mjs'), FIXED))
  const result = await step(env, session.run, pub.p).run(ticket)
  assert.deepEqual(pub.pulls, [])
  assert.equal(result.fields?.pr, 'https://github.com/o/r/pull/1')
})

test('Sitzung wirft: Fehler, Branch unverändert, Worktree entfernt', async () => {
  const env = await setup()
  const run: RunSession = async () => {
    throw new Error('Budget erschöpft')
  }
  await assert.rejects(step(env, run, publisher(env.bare).p).run(ticket), /Budget erschöpft/)
  assert.equal((await subjects(env.repo, BRANCH))[0], 'bug 7: roter Test – Summe falsch')
  assert.equal(existsSync(env.worktree), false)
})
