import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashText } from '../src/state.ts'
import { appendToTicketTool } from '../src/tools/append_to_ticket.ts'
import { createTicketTool } from '../src/tools/create_ticket.ts'
import type { ToolContext } from '../src/tools/types.ts'
import type { ChatEvent, State, Thread } from '../src/types.ts'

const thread: Thread = {
  id: '0',
  index: 0,
  top: { level: 1, text: 'Login geht nicht' },
  replies: [{ level: 2, text: 'Nur in Firefox' }],
}
const input = { title: 'Login schlägt fehl', description: 'Login geht nicht.', component: 'Login', severity: 'hoch' as const }

async function context(event: ChatEvent): Promise<{ ctx: ToolContext; persisted: () => number; replies: string[] }> {
  let saves = 0
  const replies: string[] = []
  const state: State = { threads: {} }
  const ctx: ToolContext = {
    event,
    state,
    ticketDir: join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets'),
    persist: async () => {
      saves++
    },
    now: () => new Date(2026, 10, 20, 10, 0, 0),
    source: 'datei',
    reply: async (text) => {
      replies.push(text)
    },
    link: async () => undefined,
  }
  return { ctx, persisted: () => saves, replies }
}

test('create_ticket legt Ticket an und speichert die Nummer sofort', async () => {
  const { ctx, persisted } = await context({ kind: 'NewThread', thread })
  assert.deepEqual(await createTicketTool.execute(input, ctx), { ticket: 1 })
  assert.equal(ctx.state.threads['0']?.ticket, 1)
  assert.equal(persisted(), 1)
  assert.match(await readFile(join(ctx.ticketDir, 'bug_1.txt'), 'utf8'), /^titel: Login schlägt fehl$/m)
})

test('create_ticket bei Neubewertung speichert neuen Hash und offene Antworten', async () => {
  const { ctx } = await context({ kind: 'NewThread', thread })
  ctx.state.threads['0'] = { topHash: hashText('Login'), replyCount: 1, ticket: null }
  await createTicketTool.execute(input, ctx)
  assert.deepEqual(ctx.state.threads['0'], { topHash: hashText('Login geht nicht'), replyCount: 0, ticket: 1 })
})

test('create_ticket lehnt ein zweites Ticket für denselben Thread ab', async () => {
  const { ctx } = await context({ kind: 'NewThread', thread })
  await createTicketTool.execute(input, ctx)
  const result = await createTicketTool.execute(input, ctx)
  assert.deepEqual(result, { error: 'Thread 0 hat bereits Ticket 1.' })
})

test('append_to_ticket hängt mit der Ebene der Antwort an', async () => {
  const { ctx } = await context({ kind: 'NewThread', thread })
  await createTicketTool.execute(input, ctx)
  const replyCtx: ToolContext = {
    ...ctx,
    event: { kind: 'NewReply', thread, reply: thread.replies[0]!, replyIndex: 0 },
  }
  assert.deepEqual(await appendToTicketTool.execute({ ticket: 1, text: 'Nur in Firefox' }, replyCtx), { ok: true })
  assert.match(await readFile(join(ctx.ticketDir, 'bug_1.txt'), 'utf8'), /\(Antwort, Ebene 2\)\nNur in Firefox\n$/)
})

test('append_to_ticket meldet unbekannte Nummer als Fehlertext', async () => {
  const { ctx } = await context({ kind: 'NewThread', thread })
  assert.deepEqual(await appendToTicketTool.execute({ ticket: 42, text: 'x' }, ctx), {
    error: 'Ticket 42 existiert nicht.',
  })
})

test('create_ticket antwortet im Thread mit Nummer, Titel, Komponente und Schweregrad', async () => {
  const { ctx, replies } = await context({ kind: 'NewThread', thread })
  await createTicketTool.execute(input, ctx)
  assert.deepEqual(replies, ['Ticket bug-1 angelegt: Login schlägt fehl (Login, hoch)'])
  assert.match(await readFile(join(ctx.ticketDir, 'bug_1.txt'), 'utf8'), /^quelle: datei$/m)
})

test('create_ticket antwortet nicht, wenn es ablehnt', async () => {
  const { ctx, replies } = await context({ kind: 'NewThread', thread })
  await createTicketTool.execute(input, ctx)
  await createTicketTool.execute(input, ctx)
  assert.equal(replies.length, 1)
})

test('append_to_ticket antwortet im Thread', async () => {
  const { ctx, replies } = await context({ kind: 'NewReply', thread, reply: thread.replies[0]!, replyIndex: 0 })
  await createTicketTool.execute(input, ctx)
  await appendToTicketTool.execute({ ticket: 1, text: 'Nur in Firefox' }, ctx)
  assert.equal(replies.at(-1), 'Nachtrag an bug-1 angehängt.')
})

test('append_to_ticket antwortet nicht bei unbekannter Nummer', async () => {
  const { ctx, replies } = await context({ kind: 'NewThread', thread })
  await appendToTicketTool.execute({ ticket: 42, text: 'x' }, ctx)
  assert.deepEqual(replies, [])
})