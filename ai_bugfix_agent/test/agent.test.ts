import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEvent, handleEvent, MAX_STEPS, type RunModel } from '../src/agent.ts'
import type { ChatEvent, State, Thread } from '../src/types.ts'

const thread: Thread = {
  index: 2,
  top: { level: 1, text: 'Export stürzt ab' },
  replies: [{ level: 2, text: 'Bei mir auch' }],
}
const newThread: ChatEvent = { kind: 'NewThread', thread }

async function deps(runModel: RunModel, state: State = { threads: [] }) {
  const logs: string[] = []
  return {
    logs,
    deps: {
      state,
      ticketDir: join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets'),
      persist: async () => {},
      runModel,
      log: (message: string) => logs.push(message),
      now: () => new Date(2026, 10, 20, 9, 0, 0),
    },
  }
}

test('describeEvent enthält Ereignis, Ticketstatus und Thread', () => {
  const text = describeEvent(newThread, null)
  assert.match(text, /Ereignis: NewThread/)
  assert.match(text, /Ticket: kein Ticket/)
  assert.match(text, /> Export stürzt ab/)
  assert.match(text, />> Bei mir auch/)
})

test('describeEvent nennt bei NewReply die Antwort und die Ticketnummer', () => {
  const event: ChatEvent = { kind: 'NewReply', thread, reply: thread.replies[0]!, replyIndex: 0 }
  const text = describeEvent(event, 5)
  assert.match(text, /Ereignis: NewReply/)
  assert.match(text, /Ticket: 5/)
  assert.match(text, /Betroffener Post \(Ebene 2\):\n>> Bei mir auch/)
})

test('handleEvent übergibt Prompt und Tools an das Modell', async () => {
  let seen: Parameters<RunModel>[0] | undefined
  const { deps: d } = await deps(async (request) => {
    seen = request
  })
  await handleEvent(newThread, d)
  assert.match(seen?.instructions ?? '', /create_ticket/)
  assert.deepEqual(seen?.tools.map((t) => t.name), ['create_ticket', 'append_to_ticket'])
})

test('Tool-Aufruf des Modells legt Ticket an', async () => {
  const { deps: d } = await deps(async ({ tools }) => {
    await tools.find((t) => t.name === 'create_ticket')!.execute({
      title: 'Export stürzt ab',
      description: 'Absturz beim Export.',
      component: 'Export',
      severity: 'hoch',
    })
  })
  await handleEvent(newThread, d)
  assert.equal(d.state.threads[2]?.ticket, 1)
  assert.deepEqual(await readdir(d.ticketDir), ['bug_1.txt'])
})

test('Warnung, wenn das Schrittlimit ausgeschöpft wird', async () => {
  const { deps: d, logs } = await deps(async ({ tools }) => {
    const append = tools.find((t) => t.name === 'append_to_ticket')!
    for (let i = 0; i < MAX_STEPS; i++) await append.execute({ ticket: 1, text: 'x' })
  })
  await handleEvent(newThread, d)
  assert.equal(logs.filter((l) => l.includes('Schrittlimit')).length, 1)
})
