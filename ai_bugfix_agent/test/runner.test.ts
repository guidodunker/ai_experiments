import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSteps, type RunnerDeps } from '../src/steps/runner.ts'
import { fileStore } from '../src/store/file.ts'
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
  const deps: RunnerDeps = { store: fileStore(dir), lockPath: join(dir, 'steps.lock'), steps, log: (m) => logs.push(m) }
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
  assert.deepEqual(env.logs, [
    'Ticket 1: status geplant, kein Schritt.',
    'Ticket 2: status nicht_reproduziert, kein Schritt. Zum Wiederholen den Status auf neu setzen.',
  ])
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

async function slackSetup(reply: RunnerDeps['reply']) {
  const env = await setup({}, [analyze, plan])
  await writeFile(
    join(env.dir, 'bug_1.txt'),
    'id: 1\nstatus: neu\nthread: 1764000000.000100\nquelle: slack\ntitel: T1\n\n## Nachträge\n',
  )
  return { ...env, deps: { ...env.deps, reply } }
}

test('Slack-Ticket: jeder Statuswechsel erscheint im Thread', async () => {
  const sent: [string, string][] = []
  const env = await slackSetup(async (threadId, text) => {
    sent.push([threadId, text])
  })
  assert.equal(await runSteps(env.deps), 0)
  assert.deepEqual(sent, [
    ['1764000000.000100', 'bug-1: analysiert (0.10 $): A'],
    ['1764000000.000100', 'bug-1: geplant (0.10 $): P'],
  ])
})

test('Datei-Ticket und Ticket ohne quelle: keine Antwort', async () => {
  const sent: string[] = []
  const env = await setup({ 1: 'neu' }, [analyze])
  await writeFile(join(env.dir, 'bug_2.txt'), 'id: 2\nstatus: neu\nthread: 0\nquelle: datei\ntitel: T2\n\n## Nachträge\n')
  assert.equal(await runSteps({ ...env.deps, reply: async (_id, text) => void sent.push(text) }), 0)
  assert.deepEqual(sent, [])
})

test('scheiternde Antwort: Statuswechsel gilt, Warnung im Log', async () => {
  const env = await slackSetup(async () => {
    throw new Error('not_in_channel')
  })
  assert.equal(await runSteps(env.deps), 0)
  assert.match(await env.read(1), /^status: geplant$/m)
  assert.ok(
    env.logs.includes('Warnung: Antwort an Thread 1764000000.000100 gescheitert: not_in_channel'),
    env.logs.join('\n'),
  )
})

test('Slack-Ticket ohne Slack-Konfiguration: Warnung statt Antwort', async () => {
  const env = await slackSetup(undefined)
  assert.equal(await runSteps(env.deps), 0)
  assert.ok(
    env.logs.includes(
      'Warnung: Ticket 1 stammt aus Slack, aber SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID fehlt. Keine Antwort im Thread.',
    ),
    env.logs.join('\n'),
  )
})

test('Statusmeldung nutzt die Bezeichnung des Stores', async () => {
  const sent: string[] = []
  const env = await slackSetup(async (_threadId, text) => void sent.push(text))
  const store = { ...fileStore(env.dir), label: (id: number) => `#${id}` }
  assert.equal(await runSteps({ ...env.deps, store }), 0)
  assert.deepEqual(sent, ['#1: analysiert (0.10 $): A', '#1: geplant (0.10 $): P'])
})

test('Speichern scheitert: eigene Meldung mit Ergebnis, Ticket gilt als gescheitert', async () => {
  const env = await setup({ 1: 'neu' }, [analyze])
  const store = {
    ...fileStore(env.dir),
    applyResult: async () => {
      throw new Error('HTTP 502')
    },
  }
  assert.equal(await runSteps({ ...env.deps, store }), 1)
  assert.deepEqual(env.logs, [
    'Ticket 1 analyze: Ergebnis nicht gespeichert: HTTP 502. Ergebnis war: analysiert (0.10 $): A',
  ])
  assert.equal(await env.read(1), ticketText(1, 'neu'))
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
