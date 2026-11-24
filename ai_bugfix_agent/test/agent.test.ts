import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEvent, handleEvent, MAX_STEPS, type RunModel } from '../src/agent.ts'
import { fileStore } from '../src/store/file.ts'
import { formatTicketFile } from '../src/ticketfile.ts'
import type { ChatEvent, ChatLink, State, Thread } from '../src/types.ts'

const thread: Thread = {
  id: '2',
  index: 2,
  top: { level: 1, text: 'Export stürzt ab' },
  replies: [{ level: 2, text: 'Bei mir auch' }],
}
const newThread: ChatEvent = { kind: 'NewThread', thread }

async function deps(runModel: RunModel, state: State = { threads: {} }) {
  const logs: string[] = []
  return {
    logs,
    deps: {
      state,
      store: fileStore(join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets')),
      persist: async () => {},
      runModel,
      log: (message: string) => logs.push(message),
      now: () => new Date(2026, 10, 20, 9, 0, 0),
      source: 'datei' as const,
      reply: async (_threadId: string, _text: string) => {},
      link: undefined as ChatLink | undefined,
    },
  }
}

const createExport: RunModel = async ({ tools }) => {
  await tools.find((t) => t.name === 'create_ticket')!.execute({
    title: 'Export stürzt ab',
    description: 'Absturz.',
    component: 'Export',
    severity: 'hoch',
  })
}

test('Link der Quelle landet im Ticket', async () => {
  const { deps: d } = await deps(createExport)
  d.link = async (threadId) => `https://x.slack.com/archives/C1/p${threadId}`
  await handleEvent(newThread, d)
  assert.match(formatTicketFile(await d.store.read(1)), /^link: https:\/\/x\.slack\.com\/archives\/C1\/p2$/m)
})

test('scheiternder Link ist nur eine Warnung, Ticket ohne Link', async () => {
  const { deps: d, logs } = await deps(createExport)
  d.link = async () => {
    throw new Error('message_not_found')
  }
  await handleEvent(newThread, d)
  assert.doesNotMatch(formatTicketFile(await d.store.read(1)), /^link:/m)
  assert.deepEqual(logs, ['Warnung: Link zu Thread 2 nicht ermittelt: message_not_found'])
})

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
  assert.equal(d.state.threads['2']?.ticket, 1)
  assert.deepEqual(await d.store.list(), [1])
})

test('Begründung des Modells wird mit Thread-Index geloggt', async () => {
  const { deps: d, logs } = await deps(async () => 'Kein Ticket: Smalltalk, keine Fehlermeldung.')
  await handleEvent(newThread, d)
  assert.deepEqual(logs, ['Thread 2 → Kein Ticket: Smalltalk, keine Fehlermeldung.'])
})

test('reply geht an die ID des Threads', async () => {
  const sent: [string, string][] = []
  const { deps: d } = await deps(async ({ tools }) => {
    await tools.find((t) => t.name === 'create_ticket')!.execute({
      title: 'Export stürzt ab',
      description: 'Absturz.',
      component: 'Export',
      severity: 'hoch',
    })
  })
  d.reply = async (threadId, text) => {
    sent.push([threadId, text])
  }
  await handleEvent(newThread, d)
  assert.deepEqual(sent, [['2', 'Ticket bug-1 angelegt: Export stürzt ab (Export, hoch)']])
})

test('scheiternde Antwort ist nur eine Warnung, das Ticket bleibt', async () => {
  const { deps: d, logs } = await deps(async ({ tools }) => {
    await tools.find((t) => t.name === 'create_ticket')!.execute({
      title: 'Export stürzt ab',
      description: 'Absturz.',
      component: 'Export',
      severity: 'hoch',
    })
  })
  d.reply = async () => {
    throw new Error('not_in_channel')
  }
  await handleEvent(newThread, d)
  assert.equal(d.state.threads['2']?.ticket, 1)
  assert.deepEqual(logs, ['Warnung: Antwort an Thread 2 gescheitert: not_in_channel'])
})

test('Warnung, wenn das Schrittlimit ausgeschöpft wird', async () => {
  const { deps: d, logs } = await deps(async ({ tools }) => {
    const append = tools.find((t) => t.name === 'append_to_ticket')!
    for (let i = 0; i < MAX_STEPS; i++) await append.execute({ ticket: 1, text: 'x' })
  })
  await handleEvent(newThread, d)
  assert.equal(logs.filter((l) => l.includes('Schrittlimit')).length, 1)
})
