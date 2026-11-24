import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunModel } from '../src/agent.ts'
import { runOnce, type RunDeps } from '../src/run.ts'
import { fileSource } from '../src/sources/file.ts'
import { fileStore } from '../src/store/file.ts'
import { formatTicketFile } from '../src/ticketfile.ts'
import type { ChatSource } from '../src/sources/types.ts'
import type { State } from '../src/types.ts'

const fakeModel: RunModel = async ({ input, tools }) => {
  const call = (name: string, args: unknown) => tools.find((t) => t.name === name)!.execute(args)
  const ticket = /^Ticket: (\d+)$/m.exec(input)?.[1]
  if (input.includes('Ereignis: NewThread') && input.includes('Bug')) {
    await call('create_ticket', { title: 'Bug', description: 'd', component: 'c', severity: 'mittel' })
  }
  if (input.includes('Ereignis: NewReply') && ticket !== undefined) {
    const reply = /Betroffener Post \(Ebene \d+\):\n>+ (.*)/.exec(input)?.[1] ?? ''
    await call('append_to_ticket', { ticket: Number(ticket), text: reply })
  }
}

async function setup(chat: string | null): Promise<{ deps: RunDeps; logs: string[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  if (chat !== null) await writeFile(join(dir, 'chat.txt'), chat)
  const logs: string[] = []
  return {
    dir,
    logs,
    deps: {
      source: fileSource(join(dir, 'chat.txt')),
      statePath: join(dir, 'state.json'),
      store: fileStore(join(dir, 'tickets')),
      runModel: fakeModel,
      log: (m) => logs.push(m),
      now: () => new Date(2026, 10, 20, 12, 0, 0),
      reply: async () => {},
    },
  }
}

test('fehlende chat.txt ergibt missing', async () => {
  const { deps } = await setup(null)
  assert.equal(await runOnce(deps), 'missing')
})

test('Bug-Thread ergibt Ticket mit Nachtrag, anderer Thread nichts', async () => {
  const { deps, dir } = await setup('> Bug im Login\n>> nur Firefox\n> Frage zum Urlaub\n')
  assert.equal(await runOnce(deps), 'ok')
  const ticket = await readFile(join(dir, 'tickets', 'bug_1.txt'), 'utf8')
  assert.match(ticket, /> Bug im Login/)
  assert.match(ticket, /\(Antwort, Ebene 2\)\nnur Firefox\n$/)
  const state = JSON.parse(await readFile(deps.statePath, 'utf8')) as State
  assert.deepEqual(
    Object.values(state.threads).map((t) => [t.ticket, t.replyCount]),
    [[1, 1], [null, 0]],
  )
})

test('zweiter Lauf verarbeitet nur Neues', async () => {
  const { deps, dir } = await setup('> Bug im Login\n')
  await runOnce(deps)
  await appendFile(join(dir, 'chat.txt'), '>> tritt seit gestern auf\n')
  await runOnce(deps)
  await runOnce(deps)
  const ticket = await readFile(join(dir, 'tickets', 'bug_1.txt'), 'utf8')
  assert.equal(ticket.match(/### /g)?.length, 1)
})

test('Modellfehler bricht ab, nächster Lauf wiederholt ohne doppeltes Ticket', async () => {
  const { deps, dir } = await setup('> Bug A\n>> Detail\n')
  let fail = true
  const flaky: RunModel = async (request) => {
    await fakeModel(request)
    if (fail && request.input.includes('Ereignis: NewThread')) {
      fail = false
      throw new Error('Timeout')
    }
  }
  await assert.rejects(runOnce({ ...deps, runModel: flaky }), /Timeout/)
  assert.equal(await runOnce({ ...deps, runModel: flaky }), 'ok')
  const ticket = await readFile(join(dir, 'tickets', 'bug_1.txt'), 'utf8')
  assert.match(ticket, /Detail/)
  await assert.rejects(readFile(join(dir, 'tickets', 'bug_2.txt'), 'utf8'))
})

test('halb getippter Top-Post ohne Ticket wird nach Fertigstellung zum Ticket', async () => {
  const { deps, dir } = await setup('> Tipp\n>> gesehen\n')
  await runOnce(deps)
  await writeFile(join(dir, 'chat.txt'), '> Tippfehler Bug auf der Startseite\n>> gesehen\n')
  await runOnce(deps)
  const ticket = await readFile(join(dir, 'tickets', 'bug_1.txt'), 'utf8')
  assert.match(ticket, /> Tippfehler Bug auf der Startseite/)
  assert.match(ticket, /\(Antwort, Ebene 2\)\ngesehen\n$/)
  const state = JSON.parse(await readFile(deps.statePath, 'utf8'))
  assert.deepEqual(state.threads['0'].replyCount, 1)
  await runOnce(deps)
  assert.equal((await readFile(join(dir, 'tickets', 'bug_1.txt'), 'utf8')).match(/### /g)?.length, 1)
})

test('geänderter Top-Post wird gemeldet', async () => {
  const { deps, dir, logs } = await setup('> Bug A\n')
  await runOnce(deps)
  await writeFile(join(dir, 'chat.txt'), '> Bug A, editiert\n')
  await runOnce(deps)
  assert.ok(logs.some((l) => l.includes('Top-Post wurde geändert')), logs.join('\n'))
})

test('Quelle mit eigenen IDs: Ticket trägt die ID, Antworten gehen an den Thread', async () => {
  const { deps, dir } = await setup(null)
  const source: ChatSource = {
    name: 'slack',
    label: 'Fake',
    readThreads: async () => [
      {
        id: '1764000000.000100',
        index: 0,
        top: { level: 1, text: 'Bug im Login' },
        replies: [{ level: 2, text: 'nur Firefox' }],
      },
    ],
    watch: () => {},
  }
  const sent: [string, string][] = []
  const reply = async (threadId: string, text: string) => {
    sent.push([threadId, text])
  }
  assert.equal(await runOnce({ ...deps, source, reply }), 'ok')
  const ticket = await readFile(join(dir, 'tickets', 'bug_1.txt'), 'utf8')
  assert.match(ticket, /^thread: 1764000000\.000100\nquelle: slack$/m)
  assert.deepEqual(sent, [
    ['1764000000.000100', 'Ticket bug-1 angelegt: Bug (c, mittel)'],
    ['1764000000.000100', 'Nachtrag an bug-1 angehängt.'],
  ])
})

async function withPrOpenTicket() {
  const env = await setup('> Bug im Login\n')
  await runOnce(env.deps)
  await env.deps.store.applyResult(1, {
    status: 'pr_offen',
    fields: { pr: 'https://github.com/o/r/pull/3' },
    summary: '',
  })
  const sent: string[] = []
  let modelCalls = 0
  const deps: RunDeps = {
    ...env.deps,
    reply: async (_threadId, text) => void sent.push(text),
    runModel: async (request) => {
      modelCalls++
      return fakeModel(request)
    },
  }
  return { ...env, deps, sent, modelCalls: () => modelCalls }
}

test('Freigabe bei pr_offen: Status, Feld, Nachtrag, Antwort, kein Modell', async () => {
  const env = await withPrOpenTicket()
  await appendFile(join(env.dir, 'chat.txt'), '>> Approved!\n')
  await runOnce(env.deps)
  const ticket = formatTicketFile(await env.deps.store.read(1))
  assert.match(ticket, /^status: freigegeben$/m)
  assert.match(ticket, /^freigegeben_von: unbekannt$/m)
  assert.match(ticket, /\(Antwort, Ebene 2\)\nFreigegeben im Slack-Thread von unbekannt\./)
  assert.deepEqual(env.sent, ['bug-1 freigegeben. Der nächste Lauf von npm run steps merged https://github.com/o/r/pull/3.'])
  assert.equal(env.modelCalls(), 0)
  assert.ok(env.logs.includes('Thread 0 → Freigabe für bug-1 von unbekannt.'), env.logs.join('\n'))
})

test('Freigabe doppelt: Antwort „schon freigegeben“', async () => {
  const env = await withPrOpenTicket()
  await appendFile(join(env.dir, 'chat.txt'), '>> approved\n>> freigegeben\n')
  await runOnce(env.deps)
  assert.deepEqual(env.sent.at(-1), 'bug-1 ist schon freigegeben.')
})

test('Freigabe vor dem PR: nur Antwort mit Status', async () => {
  const { deps } = await setup('> Bug im Login\n>> approved\n')
  const sent: string[] = []
  let modelCalls = 0
  await runOnce({
    ...deps,
    reply: async (_threadId, text) => void sent.push(text),
    runModel: async (request) => {
      modelCalls++
      return fakeModel(request)
    },
  })
  assert.equal(sent.at(-1), 'bug-1 kann noch nicht freigegeben werden, Status ist neu.')
  assert.equal(modelCalls, 1)
  assert.match(formatTicketFile(await deps.store.read(1)), /^status: neu$/m)
})

test('normale Antwort geht weiter ans Modell', async () => {
  const env = await withPrOpenTicket()
  await appendFile(join(env.dir, 'chat.txt'), '>> ok\n')
  await runOnce(env.deps)
  assert.equal(env.modelCalls(), 1)
  assert.match(formatTicketFile(await env.deps.store.read(1)), /^status: pr_offen$/m)
})

test('Freigabe aus Slack nennt den Absender', async () => {
  const { deps } = await setup(null)
  const thread = {
    id: '1.000001',
    index: 0,
    top: { level: 1, text: 'Bug im Login', author: 'U1' },
    replies: [] as { level: number; text: string; author?: string }[],
  }
  const source: ChatSource = { name: 'slack', label: 'Fake', readThreads: async () => [thread], watch: () => {} }
  await runOnce({ ...deps, source })
  await deps.store.applyResult(1, { status: 'pr_offen', fields: { pr: 'https://github.com/o/r/pull/3' }, summary: '' })
  thread.replies.push({ level: 2, text: 'approved', author: 'U0ABC' })
  await runOnce({ ...deps, source })
  assert.match(formatTicketFile(await deps.store.read(1)), /^freigegeben_von: U0ABC$/m)
})