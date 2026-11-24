import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchExists, git } from '../src/git.ts'
import { createAnalyzeStep } from '../src/steps/analyze.ts'
import type { RunSession, SessionRequest } from '../src/steps/session.ts'
import { parseTicket } from '../src/ticketfile.ts'
import { createRepo } from './helpers/repo.ts'

// `node --test` ohne Argumente findet **/*.test.mjs.
const TEST_CMD = 'node --test'
const ticket = parseTicket('id: 7\nstatus: neu\ntitel: Summe falsch\n\n## Beschreibung\nsum rechnet falsch\n')

const RED_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum } from '../sum.mjs'
test('sum addiert zwei Zahlen', () => assert.equal(sum(2, 3), 5))
`
const GREEN_TEST = RED_TEST.replace('sum(2, 3), 5', 'sum(3, 3), 0')

const REPRODUCED = {
  reproduziert: true,
  ursache: 'sum subtrahiert statt zu addieren. Betrifft alle Aufrufe.',
  stellen: [{ datei: 'sum.mjs', zeile: 1, beschreibung: 'a - b statt a + b' }],
  testdatei: 'test/sum-bug.test.mjs',
  testname: 'sum addiert zwei Zahlen',
  fehlende_angaben: [],
}

async function setup(baselineGreen = true) {
  const repo = await createRepo({
    'sum.mjs': 'export const sum = (a, b) => a - b\n',
    'sum.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum } from './sum.mjs'
test('sum von 0 und 0', () => assert.equal(sum(0, 0), ${baselineGreen ? 0 : 1}))
`,
  })
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'bugagent-wtroot-'))
  return { repo, worktreeRoot, worktree: join(worktreeRoot, 'bugfix-bug-7') }
}

function fakeSession(output: unknown, act?: (cwd: string) => Promise<void>) {
  const calls: SessionRequest[] = []
  const run: RunSession = async (request) => {
    calls.push(request)
    await act?.(request.cwd)
    return { output, costUsd: 0.5 }
  }
  return { run, calls }
}

async function writeTest(cwd: string, content: string): Promise<void> {
  await mkdir(join(cwd, 'test'), { recursive: true })
  await writeFile(join(cwd, 'test', 'sum-bug.test.mjs'), content)
}

function step(env: Awaited<ReturnType<typeof setup>>, run: RunSession) {
  return createAnalyzeStep({ repo: env.repo, base: 'main', testCommand: TEST_CMD, worktreeRoot: env.worktreeRoot, runSession: run })
}

test('roter Test: analysiert, Commit auf dem Branch, Worktree entfernt', async () => {
  const env = await setup()
  const session = fakeSession(REPRODUCED, (cwd) => writeTest(cwd, RED_TEST))
  const result = await step(env, session.run).run(ticket)

  assert.equal(result.status, 'analysiert')
  assert.deepEqual(result.fields, {
    branch: 'bugfix/bug-7',
    test: 'test/sum-bug.test.mjs › sum addiert zwei Zahlen',
    kosten_analyse: '0.50',
  })
  assert.equal(result.section?.heading, 'Analyse')
  assert.match(result.section?.text ?? '', /### Ursache\nsum subtrahiert/)
  assert.match(result.section?.text ?? '', /- sum\.mjs:1 – a - b statt a \+ b/)
  assert.match(result.section?.text ?? '', /### Roter Test\n```text\n[\s\S]*sum addiert zwei Zahlen/)
  assert.equal(result.summary, '(0.50 $): sum subtrahiert statt zu addieren.')
  assert.equal((await git(env.repo, ['rev-list', '--count', 'main..bugfix/bug-7'])).trim(), '1')
  assert.equal(existsSync(env.worktree), false)

  const request = session.calls[0]!
  assert.equal(request.mode, 'analyze')
  assert.equal(request.cwd, env.worktree)
  assert.match(request.prompt, /^Testkommando: node --test\n\n<<<TICKET\nid: 7/)
  assert.equal(request.maxTurns, 40)
})

test('zusätzlich geänderte Quelldatei: nicht_reproduziert, Branch gelöscht', async () => {
  const env = await setup()
  const session = fakeSession(REPRODUCED, async (cwd) => {
    await writeTest(cwd, RED_TEST)
    await writeFile(join(cwd, 'sum.mjs'), 'export const sum = (a, b) => a + b\n')
  })
  const result = await step(env, session.run).run(ticket)
  assert.equal(result.status, 'nicht_reproduziert')
  assert.deepEqual(result.fields, { kosten_analyse: '0.50' })
  assert.match(result.section?.text ?? '', /### Prüfung gescheitert\nErwartet war nur eine Änderung an test\/sum-bug\.test\.mjs/)
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), false)
  assert.equal(existsSync(env.worktree), false)
})

test('Test ist grün: nicht_reproduziert', async () => {
  const env = await setup()
  const session = fakeSession(REPRODUCED, (cwd) => writeTest(cwd, GREEN_TEST))
  const result = await step(env, session.run).run(ticket)
  assert.equal(result.status, 'nicht_reproduziert')
  assert.match(result.section?.text ?? '', /alle Tests grün/)
})

test('Testname nicht in der Ausgabe: nicht_reproduziert', async () => {
  const env = await setup()
  const session = fakeSession({ ...REPRODUCED, testname: 'anderer Name' }, (cwd) => writeTest(cwd, RED_TEST))
  const result = await step(env, session.run).run(ticket)
  assert.equal(result.status, 'nicht_reproduziert')
  assert.match(result.section?.text ?? '', /„anderer Name“ kommt in der Testausgabe nicht vor/)
})

test('reproduziert false: nicht_reproduziert mit fehlenden Angaben', async () => {
  const env = await setup()
  const session = fakeSession({
    reproduziert: false,
    ursache: 'Es gibt keinen Export im Code.',
    stellen: [],
    fehlende_angaben: ['Welche Funktion ist gemeint?'],
  })
  const result = await step(env, session.run).run(ticket)
  assert.equal(result.status, 'nicht_reproduziert')
  assert.match(result.section?.text ?? '', /### Stellen\n- keine/)
  assert.match(result.section?.text ?? '', /### Fehlende Angaben\n- Welche Funktion ist gemeint\?/)
  assert.doesNotMatch(result.section?.text ?? '', /Prüfung gescheitert/)
  assert.equal(result.summary, '(0.50 $): Es gibt keinen Export im Code.')
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), false)
})

test('rote Basis: Fehler ohne Sitzung, Branch gelöscht', async () => {
  const env = await setup(false)
  const session = fakeSession(REPRODUCED)
  await assert.rejects(step(env, session.run).run(ticket), /schlagen schon fehl/)
  assert.equal(session.calls.length, 0)
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), false)
})

test('Sitzung wirft: Fehler, Branch und Worktree entfernt', async () => {
  const env = await setup()
  const run: RunSession = async () => {
    throw new Error('Sitzung abgebrochen: error_max_budget_usd')
  }
  await assert.rejects(step(env, run).run(ticket), /error_max_budget_usd/)
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), false)
  assert.equal(existsSync(env.worktree), false)
})

test('ungültiges Ergebnis: Fehler', async () => {
  const env = await setup()
  await assert.rejects(step(env, fakeSession({ reproduziert: 'ja' }).run).run(ticket))
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), false)
})

test('Branch existiert schon: Fehler mit Löschbefehl, Branch bleibt', async () => {
  const env = await setup()
  await git(env.repo, ['branch', 'bugfix/bug-7'])
  const session = fakeSession(REPRODUCED)
  await assert.rejects(step(env, session.run).run(ticket), /existiert schon\. Löschen mit: git -C .* branch -D bugfix\/bug-7/)
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), true)
  assert.equal(session.calls.length, 0)
})

test('Branch-Name aus den Deps', async () => {
  const env = await setup()
  const session = fakeSession(REPRODUCED, (cwd) => writeTest(cwd, RED_TEST))
  const analyzeStep = createAnalyzeStep({
    repo: env.repo,
    base: 'main',
    testCommand: TEST_CMD,
    worktreeRoot: env.worktreeRoot,
    runSession: session.run,
    branchName: (id) => `bugfix/issue-${id}`,
  })
  const result = await analyzeStep.run(ticket)
  assert.equal(result.fields?.branch, 'bugfix/issue-7')
  assert.equal(session.calls[0]?.cwd, join(env.worktreeRoot, 'bugfix-issue-7'))
  assert.equal(await branchExists(env.repo, 'bugfix/issue-7'), true)
})
