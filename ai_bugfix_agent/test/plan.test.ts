import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchExists, git } from '../src/git.ts'
import { createPlanStep } from '../src/steps/plan.ts'
import type { RunSession, SessionRequest } from '../src/steps/session.ts'
import { parseTicket } from '../src/ticketfile.ts'
import { createRepo } from './helpers/repo.ts'

const ticket = parseTicket(
  'id: 7\nstatus: analysiert\nbranch: bugfix/bug-7\n\n## Analyse\n### Ursache\nsum subtrahiert.\n',
)

const PLAN = {
  zusammenfassung: 'In sum.mjs plus statt minus. Danach ist der rote Test grün.',
  schritte: [
    { datei: 'sum.mjs', neu: false, aenderung: 'a - b durch a + b ersetzen' },
    { datei: 'docs/sum.md', neu: true, aenderung: 'kurze Doku' },
  ],
  risiken: [],
  offene_fragen: ['Gibt es Aufrufer, die sich auf die Subtraktion verlassen?'],
}

async function setup() {
  const repo = await createRepo({ 'sum.mjs': 'export const sum = (a, b) => a - b\n' })
  await git(repo, ['branch', 'bugfix/bug-7'])
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'bugagent-wtroot-'))
  return { repo, worktreeRoot, worktree: join(worktreeRoot, 'bugfix-bug-7') }
}

function fakeSession(output: unknown) {
  const calls: SessionRequest[] = []
  const run: RunSession = async (request) => {
    calls.push(request)
    return { output, costUsd: 0.25 }
  }
  return { run, calls }
}

test('gültiger Plan: geplant, Abschnitt Plan, Worktree entfernt, Branch bleibt', async () => {
  const env = await setup()
  const session = fakeSession(PLAN)
  const result = await createPlanStep({ repo: env.repo, worktreeRoot: env.worktreeRoot, runSession: session.run }).run(ticket)

  assert.equal(result.status, 'geplant')
  assert.deepEqual(result.fields, { kosten_plan: '0.25' })
  assert.equal(result.section?.heading, 'Plan')
  assert.equal(
    result.section?.text,
    [
      '### Zusammenfassung',
      'In sum.mjs plus statt minus. Danach ist der rote Test grün.',
      '',
      '### Schritte',
      '1. sum.mjs – a - b durch a + b ersetzen',
      '2. docs/sum.md (neu) – kurze Doku',
      '',
      '### Risiken',
      '- keine',
      '',
      '### Offene Fragen',
      '- Gibt es Aufrufer, die sich auf die Subtraktion verlassen?',
    ].join('\n'),
  )
  assert.equal(result.summary, '(0.25 $): In sum.mjs plus statt minus.')
  assert.equal(existsSync(env.worktree), false)
  assert.equal(await branchExists(env.repo, 'bugfix/bug-7'), true)

  const request = session.calls[0]!
  assert.equal(request.mode, 'plan')
  assert.equal(request.maxTurns, 25)
  assert.match(request.prompt, /^<<<TICKET\nid: 7/)
})

test('Plan nennt eine fehlende Datei: Fehler, Worktree entfernt', async () => {
  const env = await setup()
  const output = { ...PLAN, schritte: [{ datei: 'gibts-nicht.mjs', neu: false, aenderung: 'x' }] }
  const step = createPlanStep({ repo: env.repo, worktreeRoot: env.worktreeRoot, runSession: fakeSession(output).run })
  await assert.rejects(step.run(ticket), /gibts-nicht\.mjs, die Datei gibt es nicht/)
  assert.equal(existsSync(env.worktree), false)
})

test('Plan nennt eine Datei außerhalb des Repos: Fehler', async () => {
  const env = await setup()
  const output = { ...PLAN, schritte: [{ datei: '../x.mjs', neu: true, aenderung: 'x' }] }
  const step = createPlanStep({ repo: env.repo, worktreeRoot: env.worktreeRoot, runSession: fakeSession(output).run })
  await assert.rejects(step.run(ticket), /außerhalb des Repos/)
})

test('Plan ohne Schritte: Fehler', async () => {
  const env = await setup()
  const step = createPlanStep({ repo: env.repo, worktreeRoot: env.worktreeRoot, runSession: fakeSession({ ...PLAN, schritte: [] }).run })
  await assert.rejects(step.run(ticket), /keine Schritte/)
})
