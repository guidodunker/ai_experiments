import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSteps, type RunnerDeps } from '../src/steps/runner.ts'
import type { Step } from '../src/steps/types.ts'
import { appendToTicket } from '../src/tickets.ts'

const analyze: Step = {
  name: 'analyze',
  accepts: 'neu',
  run: async () => ({
    status: 'analysiert',
    fields: { branch: 'b' },
    section: { heading: 'Analyse', text: 'A' },
    summary: '(0.10 $): A',
  }),
}
const plan: Step = {
  name: 'plan',
  accepts: 'analysiert',
  run: async () => ({ status: 'geplant', section: { heading: 'Plan', text: 'P' }, summary: '(0.10 $): P' }),
}

function ticketText(id: number, status: string): string {
  return `id: ${id}\nstatus: ${status}\ntitel: T${id}\n\n## Nachträge\n`
}

async function setup(tickets: Record<number, string>, steps: Step[]) {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-runner-'))
  for (const [id, status] of Object.entries(tickets)) {
    await writeFile(join(dir, `bug_${id}.txt`), ticketText(Number(id), status))
  }
  const logs: string[] = []
  const deps: RunnerDeps = { ticketDir: dir, lockPath: join(dir, 'steps.lock'), steps, log: (m) => logs.push(m) }
  const read = (id: number) => readFile(join(dir, `bug_${id}.txt`), 'utf8')
  return { dir, deps, logs, read }
}

test('ein Lauf bringt ein Ticket von neu bis geplant', async () => {
  const env = await setup({ 1: 'neu' }, [analyze, plan])
  assert.equal(await runSteps(env.deps), 0)
  assert.equal(
    await env.read(1),
    'id: 1\nstatus: geplant\ntitel: T1\nbranch: b\n\n## Nachträge\n\n## Analyse\nA\n\n## Plan\nP\n',
  )
  assert.deepEqual(env.logs, ['Ticket 1 analyze → analysiert (0.10 $): A', 'Ticket 1 plan → geplant (0.10 $): P'])
  assert.equal(existsSync(env.deps.lockPath), false)
})

test('Tickets ohne passenden Schritt bleiben unverändert', async () => {
  const env = await setup({ 1: 'geplant', 2: 'nicht_reproduziert' }, [analyze, plan])
  assert.equal(await runSteps(env.deps), 0)
  assert.equal(await env.read(1), ticketText(1, 'geplant'))
  assert.deepEqual(env.logs, [])
})

test('ein gescheiterter Schritt hält die anderen Tickets nicht auf', async () => {
  const failing: Step = {
    name: 'analyze',
    accepts: 'neu',
    run: async (ticket) => {
      if (ticket.id === 1) throw new Error('Tests auf main schlagen schon fehl')
      return analyze.run(ticket)
    },
  }
  const env = await setup({ 1: 'neu', 2: 'neu' }, [failing])
  assert.equal(await runSteps(env.deps), 1)
  assert.equal(await env.read(1), ticketText(1, 'neu'))
  assert.match(await env.read(2), /^status: analysiert$/m)
  assert.equal(env.logs[0], 'Ticket 1 analyze gescheitert: Tests auf main schlagen schon fehl')
})

test('TICKET: nur dieses Ticket', async () => {
  const env = await setup({ 1: 'neu', 2: 'neu' }, [analyze])
  assert.equal(await runSteps({ ...env.deps, only: 2 }), 0)
  assert.equal(await env.read(1), ticketText(1, 'neu'))
  assert.match(await env.read(2), /^status: analysiert$/m)
})

test('TICKET mit unbekannter Nummer zählt als gescheitert', async () => {
  const env = await setup({}, [analyze])
  assert.equal(await runSteps({ ...env.deps, only: 9 }), 1)
})

test('vorhandene Sperrdatei: Abbruch, Datei bleibt', async () => {
  const env = await setup({ 1: 'neu' }, [analyze])
  await writeFile(env.deps.lockPath, '123\n')
  await assert.rejects(runSteps(env.deps), /steps\.lock existiert/)
  assert.equal(existsSync(env.deps.lockPath), true)
  assert.equal(await env.read(1), ticketText(1, 'neu'))
})

test('Schritt ohne Statuswechsel läuft nicht endlos', async () => {
  let calls = 0
  const stuck: Step = { name: 'x', accepts: 'neu', run: async () => (calls++, { status: 'neu', summary: '' }) }
  const env = await setup({ 1: 'neu' }, [stuck])
  assert.equal(await runSteps(env.deps), 0)
  assert.equal(calls, 1)
})

test('Nachtrag während des Schritts geht nicht verloren', async () => {
  const env = await setup({ 1: 'neu' }, [])
  const withReply: Step = {
    ...analyze,
    run: async (ticket) => {
      await appendToTicket(env.dir, 1, { level: 2, text: 'Nachtrag' }, new Date(2026, 10, 23, 12, 0, 0))
      return analyze.run(ticket)
    },
  }
  await runSteps({ ...env.deps, steps: [withReply] })
  const content = await env.read(1)
  assert.match(content, /## Nachträge\n\n### 2026-11-23T12:00:00 \(Antwort, Ebene 2\)\nNachtrag\n\n## Analyse\nA\n$/)
})
