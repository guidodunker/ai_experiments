import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunModel } from '../src/agent.ts'
import { runOnce, type RunDeps } from '../src/run.ts'

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
      chatPath: join(dir, 'chat.txt'),
      statePath: join(dir, 'state.json'),
      ticketDir: join(dir, 'tickets'),
      runModel: fakeModel,
      log: (m) => logs.push(m),
      now: () => new Date(2026, 10, 20, 12, 0, 0),
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
  const state = JSON.parse(await readFile(deps.statePath, 'utf8'))
  assert.deepEqual(
    state.threads.map((t: { ticket: number | null; replyCount: number }) => [t.ticket, t.replyCount]),
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
  assert.deepEqual(state.threads[0].replyCount, 1)
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
