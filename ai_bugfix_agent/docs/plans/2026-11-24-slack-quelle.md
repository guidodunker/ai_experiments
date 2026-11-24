# Slack als Chat-Quelle – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Chat-Agent liest wahlweise `chat.txt` oder den Slack-Channel `#bugs` und antwortet bei Slack im Thread: bei Ticket-Anlage, bei Nachträgen und bei Statuswechseln aus `npm run steps`.

**Architecture:** Eine Schnittstelle `ChatSource` liefert bei jedem Lauf den vollständigen Stand als `Thread[]`. Das vorhandene `diff()` ermittelt daraus die Ereignisse. Slack-Events über den Socket Mode lösen nur einen Lauf aus. Threads werden über eine stabile `id` erkannt (bei Slack der `ts` des Top-Posts), der Zustand ist ein Objekt mit der ID als Schlüssel. Rückmeldungen erzeugt der Code, nicht das LLM. Eine scheiternde Rückmeldung ist nur eine Warnung.

**Tech Stack:** TypeScript mit Node 22 `--experimental-strip-types`, `node:test`, `@slack/web-api` 8.5.0, `@slack/socket-mode` 3.2.0.

**Spec:** `docs/specs/2026-11-24-slack-quelle-design.md`

---

## Hinweise für alle Tasks

- Alle Pfade gelten relativ zu `ai_bugfix_agent/`. Alle Befehle laufen in diesem Verzeichnis (PowerShell: `Set-Location C:\workspace\tests\ai_experiments\ai_bugfix_agent`).
- Eine Testdatei allein: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/<name>.test.ts`
- Alle Tests: `npm test`. Typen: `npm run typecheck`.
- Relative Importe enden auf `.ts`. Reine Typ-Importe mit `import type`. Kein `enum`, kein `namespace` (Node entfernt nur Typen).
- Kommentare, Log-Texte und Commit-Nachrichten auf Deutsch, Commit-Präfix `Bugfix-Agent:`.
- Die beiden Slack-Pakete sind CommonJS. Benannte Importe (`import { WebClient } from '@slack/web-api'`) scheitern unter Node 22 zur Laufzeit. Immer den Default-Import verwenden und destrukturieren (Task 6).

## Dateien

| Datei | Änderung | Aufgabe |
|---|---|---|
| `src/types.ts` | ändern | `Thread.id`, `State` als Objekt, `SourceName`, `ChatReply` |
| `src/parser.ts` | ändern | setzt `id` |
| `src/state.ts` | ändern | Schlüssel `id`, Umrechnung des alten Array-Formats |
| `src/diff.ts` | ändern | erkennt Threads über `id` |
| `src/tickets.ts` | ändern | Kopf `thread: <id>`, neues Feld `quelle`, `oneLine` exportiert |
| `src/tools/types.ts` | ändern | `ToolContext.source`, `ToolContext.reply` |
| `src/tools/create_ticket.ts` | ändern | antwortet nach der Anlage |
| `src/tools/append_to_ticket.ts` | ändern | antwortet nach dem Nachtrag |
| `src/agent.ts` | ändern | bindet `reply` an den Thread, fängt Fehler ab |
| `src/sources/types.ts` | neu | `ChatSource` |
| `src/sources/file.ts` | neu | `fileSource`, `fileReply` |
| `src/sources/slack-threads.ts` | neu | Slack-Nachrichten → `Thread[]`, reine Funktion |
| `src/sources/slack.ts` | neu | `slackSource`, `slackReply` gegen die Schnittstellen `SlackApi` und `SlackEvents` |
| `src/sources/slack-client.ts` | neu | echte Umsetzung von `SlackApi` und `SlackEvents` mit den Slack-Paketen |
| `src/sources/config.ts` | neu | wählt die Quelle aus der Umgebung |
| `src/run.ts` | ändern | liest über `ChatSource` |
| `src/main.ts` | ändern | nutzt `chooseChat` |
| `src/steps/runner.ts` | ändern | meldet Statuswechsel im Slack-Thread |
| `src/steps-main.ts` | ändern | übergibt `slackReplyFromEnv` |
| `.env.example`, `.gitignore`, `README.md`, `package.json` | ändern | Konfiguration, Doku, Abhängigkeiten |

`ChatReply` und `SourceName` stehen in `src/types.ts` statt in `src/sources/types.ts`, weil Tools und Tickets sie brauchen. Das weicht von der Dateitabelle der Spec ab, nicht vom Verhalten.

---

### Task 1: Thread-ID und Zustand als Objekt

**Files:**
- Modify: `src/types.ts`, `src/parser.ts`, `src/state.ts`, `src/diff.ts`, `src/agent.ts:77`, `src/tickets.ts:63`
- Test: `test/state.test.ts`, `test/diff.test.ts`, `test/parser.test.ts`, `test/tools.test.ts`, `test/agent.test.ts`, `test/tickets.test.ts`, `test/ticketfile.test.ts`, `test/run.test.ts`

- [ ] **Step 1: Tests für das neue Zustandsformat schreiben**

`test/state.test.ts` vollständig ersetzen:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvent, ensureThread, hashText, loadState, saveState } from '../src/state.ts'
import type { State, Thread } from '../src/types.ts'

const thread: Thread = {
  id: '0',
  index: 0,
  top: { level: 1, text: 'Bug' },
  replies: [{ level: 2, text: 'a' }, { level: 2, text: 'b' }],
}

test('fehlende Zustandsdatei ergibt leeren Zustand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  assert.deepEqual(await loadState(join(dir, 'state.json')), { threads: {} })
})

test('Zustand übersteht Speichern und Laden', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  const path = join(dir, 'state.json')
  const state: State = { threads: { '1764000000.000100': { topHash: 'x', replyCount: 2, ticket: 7 } } }
  await saveState(path, state)
  assert.deepEqual(await loadState(path), state)
})

test('altes Array-Format wird zum Objekt mit der Position als Schlüssel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  const path = join(dir, 'state.json')
  const a = { topHash: 'a', replyCount: 1, ticket: 2 }
  const c = { topHash: 'c', replyCount: 0, ticket: null }
  await writeFile(path, JSON.stringify({ threads: [a, null, c] }))
  assert.deepEqual(await loadState(path), { threads: { '0': a, '2': c } })
})

test('ensureThread legt Eintrag an und liefert danach denselben', () => {
  const state: State = { threads: {} }
  const entry = ensureThread(state, thread)
  assert.deepEqual(entry, { topHash: hashText('Bug'), replyCount: 0, ticket: null })
  assert.equal(ensureThread(state, thread), entry)
  assert.deepEqual(Object.keys(state.threads), ['0'])
})

test('applyEvent bei NewThread übernimmt neuen Hash und setzt Antworten zurück', () => {
  const state: State = { threads: { '0': { topHash: hashText('B'), replyCount: 2, ticket: 9 } } }
  applyEvent(state, { kind: 'NewThread', thread })
  assert.deepEqual(state.threads['0'], { topHash: hashText('Bug'), replyCount: 0, ticket: 9 })
})

test('applyEvent zählt Antworten hoch', () => {
  const state: State = { threads: {} }
  applyEvent(state, { kind: 'NewThread', thread })
  applyEvent(state, { kind: 'NewReply', thread, reply: thread.replies[1]!, replyIndex: 1 })
  assert.equal(state.threads['0']?.replyCount, 2)
})
```

In `test/diff.test.ts`:
- `const thread: Thread = {` bekommt als erste Zeile `id: '0',`.
- `diff([thread], { threads: [] })` → `diff([thread], { threads: {} })`.
- Jedes `{ threads: [{ … }] }` → `{ threads: { '0': { … } } }` (vier Stellen, Inhalt der Einträge unverändert).
- Am Ende ergänzen:

```ts
test('Thread wird über id erkannt, auch wenn sich index verschiebt', () => {
  const moved: Thread = { ...thread, id: 'a', index: 5 }
  const state: State = { threads: { a: { topHash: hashText('Bug'), replyCount: 2, ticket: 1 } } }
  assert.deepEqual(diff([moved], state), { events: [], warnings: [] })
})
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/state.test.ts test/diff.test.ts`
Expected: FAIL, u. a. `{ threads: [] }` statt `{ threads: {} }` und der neue diff-Test liefert Ereignisse.

- [ ] **Step 3: Typen, Parser, Zustand und diff umstellen**

`src/types.ts` vollständig:

```ts
/** Ein Beitrag im Chat. Ebene 1 ist ein Top-Post, 2 eine Antwort darauf usw. */
export type Post = { level: number; text: string }

/**
 * Ein Top-Post mit allen Antworten. `id` erkennt den Thread über Läufe hinweg
 * wieder: in `chat.txt` die Position, in Slack der `ts` des Top-Posts.
 * `index` zählt ab 0 in der aktuellen Reihenfolge und dient nur Log-Zeilen.
 */
export type Thread = { id: string; index: number; top: Post; replies: Post[] }

export type ChatEvent =
  | { kind: 'NewThread'; thread: Thread }
  | { kind: 'NewReply'; thread: Thread; reply: Post; replyIndex: number }

export type ThreadState = { topHash: string; replyCount: number; ticket: number | null }

/** Schlüssel ist die Thread-ID. */
export type State = { threads: Record<string, ThreadState> }
```

`src/parser.ts`, Zeile mit `threads.push(...)`:

```ts
      threads.push({ id: String(threads.length), index: threads.length, top: post, replies: [] })
```

`src/state.ts`, `loadState` und `ensureThread` ersetzen:

```ts
export async function loadState(path: string): Promise<State> {
  let raw: { threads: unknown }
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as { threads: unknown }
  } catch (error) {
    if (isNotFound(error)) return { threads: {} }
    throw error
  }
  return { threads: migrateThreads(raw.threads) }
}

/** Bis Stufe 2 war `threads` ein Array mit der Position als Schlüssel und `null` in Lücken. */
function migrateThreads(threads: unknown): Record<string, ThreadState> {
  if (!Array.isArray(threads)) return threads as Record<string, ThreadState>
  const result: Record<string, ThreadState> = {}
  threads.forEach((entry: ThreadState | null, index) => {
    if (entry !== null) result[String(index)] = entry
  })
  return result
}
```

```ts
/** Liefert den Zustand eines Threads und legt ihn beim ersten Mal an. */
export function ensureThread(state: State, thread: Thread): ThreadState {
  const existing = state.threads[thread.id]
  if (existing !== undefined) return existing
  const created: ThreadState = { topHash: hashText(thread.top.text), replyCount: 0, ticket: null }
  state.threads[thread.id] = created
  return created
}
```

`src/diff.ts`, Rumpf der Schleife bis `continue` des Neubewertungs-Zweigs:

```ts
  for (const thread of threads) {
    const known = state.threads[thread.id]
    const changed = known !== undefined && known.topHash !== hashText(thread.top.text)

    if (changed && known.ticket !== null) {
      warnings.push(`Thread ${thread.index}: Top-Post wurde geändert, Thread wird übersprungen.`)
      continue
    }

    if (known === undefined || changed) {
```

Den Doc-Kommentar über `diff` anpassen: „Threads werden über ihre Position erkannt.“ → „Threads werden über ihre `id` erkannt.“

`src/agent.ts:77`:

```ts
  const ticket = deps.state.threads[event.thread.id]?.ticket ?? null
```

`src/tickets.ts:63`:

```ts
    `thread: ${thread.id}`,
```

- [ ] **Step 4: Übrige Tests an `id` anpassen**

- `test/parser.test.ts`: in jedem erwarteten Thread `id` vor `index` ergänzen: `{ id: '0', index: 0, … }`, `{ id: '1', index: 1, … }` (vier Stellen).
- `test/tools.test.ts`: `const thread: Thread = {` bekommt `id: '0',`; `const state: State = { threads: [] }` → `{ threads: {} }`; `ctx.state.threads[0]` → `ctx.state.threads['0']` (drei Stellen).
- `test/agent.test.ts`: `const thread: Thread = {` bekommt `id: '2',`; `state: State = { threads: [] }` → `{ threads: {} }`; `d.state.threads[2]` → `d.state.threads['2']`.
- `test/tickets.test.ts:16`: `const thread: Thread = { id: '4', index: 4, … }`.
- `test/ticketfile.test.ts:28`: `const thread = { id: '0', index: 0, … }`.
- `test/run.test.ts:52`: `state.threads.map(` → `Object.values(state.threads).map(`; Zeile 93: `state.threads[0].replyCount` → `state.threads['0'].replyCount`.

- [ ] **Step 5: Alle Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle Tests PASS (bisher 99 plus 2 neue), `tsc` ohne Fehler.

- [ ] **Step 6: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Threads über stabile ID erkennen, Zustand als Objekt"
```

---

### Task 2: Rückmeldung aus den Tools, Kopffeld `quelle`

**Files:**
- Modify: `src/types.ts`, `src/tickets.ts`, `src/tools/types.ts`, `src/tools/create_ticket.ts`, `src/tools/append_to_ticket.ts`, `src/agent.ts`, `src/run.ts`, `src/main.ts`
- Test: `test/tools.test.ts`, `test/tickets.test.ts`, `test/ticketfile.test.ts`, `test/agent.test.ts`, `test/run.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/tickets.test.ts`:
- Jeder Aufruf `createTicket(dir, thread, fields, NOW)` bekommt als fünftes Argument `'datei'` (fünf Stellen).
- Im Test „createTicket schreibt das Ticketformat“ nach `'thread: 4',` die Zeile `'quelle: datei',` einfügen.
- Ergänzen:

```ts
test('createTicket schreibt Slack-Thread-ID und Quelle', async () => {
  const dir = await tempDir()
  await createTicket(dir, { ...thread, id: '1764000000.123456' }, fields, NOW, 'slack')
  const content = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.match(content, /^thread: 1764000000\.123456\nquelle: slack$/m)
})
```

`test/ticketfile.test.ts:30`: `createTicket(dir, thread, fields, new Date(2026, 10, 23, 9, 0, 0), 'datei')`.

`test/tools.test.ts`, Funktion `context` ersetzen und Tests ergänzen:

```ts
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
  }
  return { ctx, persisted: () => saves, replies }
}
```

```ts
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
  assert.deepEqual(replies.at(-1), 'Nachtrag an bug-1 angehängt.')
})

test('append_to_ticket antwortet nicht bei unbekannter Nummer', async () => {
  const { ctx, replies } = await context({ kind: 'NewThread', thread })
  await appendToTicketTool.execute({ ticket: 42, text: 'x' }, ctx)
  assert.deepEqual(replies, [])
})
```

`test/agent.test.ts`, in `deps(...)` innerhalb des `deps`-Objekts ergänzen:

```ts
      source: 'datei' as const,
      reply: async (_threadId: string, _text: string) => {},
```

und Tests ergänzen:

```ts
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
```

`test/run.test.ts`, in `setup` im `deps`-Objekt ergänzen:

```ts
      reply: async () => {},
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/tools.test.ts test/tickets.test.ts test/agent.test.ts`
Expected: FAIL, keine Antworten, keine Zeile `quelle:`.

- [ ] **Step 3: Implementieren**

`src/types.ts` ergänzen:

```ts
export type SourceName = 'datei' | 'slack'

/** Antwortet im Thread mit dieser ID. Wirft bei einem Fehler. */
export type ChatReply = (threadId: string, text: string) => Promise<void>
```

`src/tickets.ts`:
- `import type { SourceName, Thread } from './types.ts'`
- `function oneLine` → `export function oneLine`
- `formatTicket` bekommt den Parameter `source: SourceName` nach `created` und schreibt nach der `thread`-Zeile `` `quelle: ${source}`, ``.
- `createTicket`:

```ts
/** Legt das nächste Ticket an und liefert seine Nummer. */
export async function createTicket(
  dir: string,
  thread: Thread,
  fields: TicketFields,
  now: Date,
  source: SourceName,
): Promise<number> {
  await mkdir(dir, { recursive: true })
  const id = await nextTicketNumber(dir)
  // 'wx' schlägt fehl, falls die Datei inzwischen existiert, statt sie zu überschreiben.
  await writeFile(ticketPath(dir, id), formatTicket(id, thread, fields, now, source), { flag: 'wx' })
  return id
}
```

`src/tools/types.ts`, `ToolContext`:

```ts
import type { ChatEvent, SourceName, State } from '../types.ts'

/** Was ein Tool vom Agenten bekommt. Das LLM sieht davon nichts. */
export type ToolContext = {
  event: ChatEvent
  state: State
  ticketDir: string
  /** Schreibt den Zustand sofort auf die Platte. */
  persist: () => Promise<void>
  now: () => Date
  source: SourceName
  /** Antwortet im Thread des Ereignisses. Wirft nie, Fehler stehen als Warnung im Log. */
  reply: (text: string) => Promise<void>
}
```

`src/tools/create_ticket.ts`, `execute` ab `const id = …`:

```ts
    const id = await createTicket(ctx.ticketDir, ctx.event.thread, input, ctx.now(), ctx.source)
    entry.ticket = id
    // Das Ticket gilt für diesen Text; seine Antworten sind noch nicht angehängt.
    entry.topHash = hashText(ctx.event.thread.top.text)
    entry.replyCount = 0
    // Sofort speichern, damit ein Abbruch danach kein zweites Ticket erzeugt.
    await ctx.persist()
    await ctx.reply(`Ticket bug-${id} angelegt: ${oneLine(input.title)} (${oneLine(input.component)}, ${input.severity})`)
    return { ticket: id }
```

Import: `import { createTicket, oneLine } from '../tickets.ts'`.

`src/tools/append_to_ticket.ts`, `execute`:

```ts
  execute: async (input, ctx) => {
    const level = ctx.event.kind === 'NewReply' ? ctx.event.reply.level : 1
    const ok = await appendToTicket(ctx.ticketDir, input.ticket, { level, text: input.text }, ctx.now())
    if (!ok) return { error: `Ticket ${input.ticket} existiert nicht.` }
    await ctx.reply(`Nachtrag an bug-${input.ticket} angehängt.`)
    return { ok: true }
  },
```

`src/agent.ts`:
- Import: `import type { ChatEvent, ChatReply, SourceName, State } from './types.ts'`
- `AgentDeps` ergänzen:

```ts
  source: SourceName
  /** Antwortweg der Quelle. Fehler fängt `handleEvent` ab. */
  reply: ChatReply
```

- In `handleEvent` den `ctx` ersetzen:

```ts
  const ctx: ToolContext = {
    event,
    state: deps.state,
    ticketDir: deps.ticketDir,
    persist: deps.persist,
    now: deps.now,
    source: deps.source,
    // Nicht wiederholen: Das Ticket ist schon geschrieben, ein zweiter Versuch im nächsten Lauf gäbe ein Duplikat.
    reply: async (text) => {
      try {
        await deps.reply(event.thread.id, text)
      } catch (error) {
        deps.log(
          `Warnung: Antwort an Thread ${event.thread.index} gescheitert: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
```

`src/run.ts`: `RunDeps` um `reply: ChatReply` ergänzen (Import `import type { ChatEvent, ChatReply } from './types.ts'`) und im Aufruf von `handleEvent` ergänzen:

```ts
      source: 'datei',
      reply: deps.reply,
```

`src/main.ts`, im `deps`-Objekt ergänzen (wird in Task 3 ersetzt):

```ts
    reply: async (threadId, text) => log(`Antwort an Thread ${threadId}: ${text}`),
```

- [ ] **Step 4: Alle Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Tools antworten im Thread, Ticketkopf mit quelle"
```

---

### Task 3: `ChatSource` und `FileSource`

**Files:**
- Create: `src/sources/types.ts`, `src/sources/file.ts`
- Modify: `src/run.ts`, `src/main.ts`
- Test: `test/run.test.ts`, `test/file-source.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/file-source.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileReply, fileSource } from '../src/sources/file.ts'

test('fileSource liest chat.txt als Threads mit Position als id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  await writeFile(join(dir, 'chat.txt'), '> A\n>> a\n> B\n')
  const source = fileSource(join(dir, 'chat.txt'))
  assert.equal(source.name, 'datei')
  const threads = await source.readThreads()
  assert.notEqual(threads, 'missing')
  if (threads !== 'missing') assert.deepEqual(threads.map((t) => [t.id, t.top.text]), [['0', 'A'], ['1', 'B']])
})

test('fileSource meldet fehlende Datei als missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  assert.equal(await fileSource(join(dir, 'chat.txt')).readThreads(), 'missing')
})

test('fileReply schreibt die Antwort ins Log', async () => {
  const logs: string[] = []
  await fileReply((m) => logs.push(m))('3', 'Ticket bug-1 angelegt: X (Y, hoch)')
  assert.deepEqual(logs, ['Antwort an Thread 3: Ticket bug-1 angelegt: X (Y, hoch)'])
})
```

`test/run.test.ts`:
- Import ergänzen: `import { fileSource } from '../src/sources/file.ts'` und `import type { ChatSource } from '../src/sources/types.ts'`
- Im `deps`-Objekt von `setup` die Zeile `chatPath: join(dir, 'chat.txt'),` ersetzen durch `source: fileSource(join(dir, 'chat.txt')),`
- Ergänzen:

```ts
test('Quelle mit eigenen IDs: Ticket trägt die ID, Antworten gehen an den Thread', async () => {
  const { deps, dir } = await setup(null)
  const source: ChatSource = {
    name: 'slack',
    label: 'Fake',
    readThreads: async () => [
      { id: '1764000000.000100', index: 0, top: { level: 1, text: 'Bug im Login' }, replies: [{ level: 2, text: 'nur Firefox' }] },
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
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/file-source.test.ts test/run.test.ts`
Expected: FAIL, `Cannot find module '…/src/sources/file.ts'`.

- [ ] **Step 3: Implementieren**

`src/sources/types.ts`:

```ts
import type { SourceName, Thread } from '../types.ts'

/** Woher der Chat kommt. Ein Lauf liest immer den vollständigen Stand. */
export type ChatSource = {
  name: SourceName
  /** Für Log-Zeilen, z. B. der Dateipfad oder der Channel */
  label: string
  /** Vollständiger Stand. 'missing', wenn die Datei fehlt. */
  readThreads(): Promise<Thread[] | 'missing'>
  /** Ruft onChange bei jeder Änderung auf, entprellt. Hält den Prozess am Leben. */
  watch(onChange: () => void): void
}
```

`src/sources/file.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { parseChat } from '../parser.ts'
import { isNotFound } from '../state.ts'
import type { ChatReply } from '../types.ts'
import { watchChat } from '../watch.ts'
import type { ChatSource } from './types.ts'

/** Editoren speichern auch halb getippte Zeilen; erst nach einer Tipp-Pause auswerten. */
export const FILE_DEBOUNCE_MS = 3000

export function fileSource(chatPath: string, debounceMs = FILE_DEBOUNCE_MS): ChatSource {
  return {
    name: 'datei',
    label: chatPath,
    async readThreads() {
      try {
        return parseChat(await readFile(chatPath, 'utf8'))
      } catch (error) {
        if (isNotFound(error)) return 'missing'
        throw error
      }
    },
    watch(onChange) {
      watchChat(chatPath, onChange, debounceMs)
    },
  }
}

/** Eine Datei hat keinen Rückkanal: Die Antwort steht nur im Log. */
export function fileReply(log: (message: string) => void): ChatReply {
  return async (threadId, text) => log(`Antwort an Thread ${threadId}: ${text}`)
}
```

`src/run.ts` vollständig:

```ts
import { handleEvent, type RunModel } from './agent.ts'
import { diff } from './diff.ts'
import type { ChatSource } from './sources/types.ts'
import { applyEvent, loadState, saveState } from './state.ts'
import type { ChatEvent, ChatReply } from './types.ts'

export type RunDeps = {
  source: ChatSource
  reply: ChatReply
  statePath: string
  ticketDir: string
  runModel: RunModel
  log: (message: string) => void
  now?: () => Date
}

function summarize(event: ChatEvent): string {
  return event.kind === 'NewThread'
    ? `Thread ${event.thread.index}: neuer Top-Post`
    : `Thread ${event.thread.index}: neue Antwort ${event.replyIndex + 1}`
}

/**
 * Verarbeitet alles, was seit dem letzten Lauf neu ist. Der Zustand wird nach
 * jedem Ereignis gespeichert; ein Fehler bricht ab und der nächste Lauf
 * setzt beim fehlgeschlagenen Ereignis wieder an.
 */
export async function runOnce(deps: RunDeps): Promise<'ok' | 'missing'> {
  const threads = await deps.source.readThreads()
  if (threads === 'missing') return 'missing'

  const state = await loadState(deps.statePath)
  const persist = () => saveState(deps.statePath, state)
  const { events, warnings } = diff(threads, state)
  for (const warning of warnings) deps.log(`Warnung: ${warning}`)

  for (const event of events) {
    deps.log(summarize(event))
    await handleEvent(event, {
      state,
      ticketDir: deps.ticketDir,
      persist,
      runModel: deps.runModel,
      log: deps.log,
      now: deps.now ?? (() => new Date()),
      source: deps.source.name,
      reply: deps.reply,
    })
    applyEvent(state, event)
    await persist()
  }
  return 'ok'
}
```

`src/main.ts`:
- Import `import { createSerialRunner, watchChat } from './watch.ts'` → `import { createSerialRunner } from './watch.ts'`, dazu `import { fileReply, fileSource } from './sources/file.ts'`.
- Konstante `DEBOUNCE_MS` samt Kommentar löschen.
- Vor `const deps` einfügen: `const source = fileSource(process.env.CHAT_FILE ?? join(ROOT, 'chat.txt'))`
- Im `deps`-Objekt `chatPath: …` und `reply: …` ersetzen durch `source,` und `reply: fileReply(log),`.
- `deps.chatPath` an drei Stellen → `source.label`.
- `watchChat(deps.chatPath, () => void trigger(), DEBOUNCE_MS)` → `source.watch(() => void trigger())`.

- [ ] **Step 4: Alle Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Chat-Quelle als Schnittstelle, Datei als erste Umsetzung"
```

---

### Task 4: Slack-Nachrichten zu Threads

**Files:**
- Create: `src/sources/slack-threads.ts`
- Test: `test/slack-threads.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/slack-threads.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toThreads, type SlackMessage } from '../src/sources/slack-threads.ts'

const ME = { userId: 'UBOT', botId: 'BBOT' }
const msg = (ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({ ts, text, user: 'U1', ...extra })

test('Top-Posts nach ts sortiert, Antworten als Ebene 2, ID ist ts', () => {
  const history = [msg('1764000002.000000', 'B'), msg('1764000001.000000', 'A', { reply_count: 2 })]
  const replies = new Map([
    ['1764000001.000000', [msg('1764000001.000000', 'A'), msg('1764000004.000000', 'a2'), msg('1764000003.000000', 'a1')]],
  ])
  assert.deepEqual(toThreads(history, replies, ME), [
    {
      id: '1764000001.000000',
      index: 0,
      top: { level: 1, text: 'A' },
      replies: [{ level: 2, text: 'a1' }, { level: 2, text: 'a2' }],
    },
    { id: '1764000002.000000', index: 1, top: { level: 1, text: 'B' }, replies: [] },
  ])
})

test('eigene Nachrichten fallen weg, über user und über bot_id', () => {
  const history = [msg('1.000001', 'Bug', { reply_count: 3 })]
  const replies = new Map([
    ['1.000001', [msg('1.000002', 'Ticket angelegt', { user: 'UBOT' }), msg('1.000003', 'Status', { user: undefined, bot_id: 'BBOT' }), msg('1.000004', 'Danke')]],
  ])
  assert.deepEqual(toThreads(history, replies, ME)[0]?.replies, [{ level: 2, text: 'Danke' }])
})

test('Top-Post vom eigenen Bot fehlt samt Thread', () => {
  assert.deepEqual(toThreads([msg('1.000001', 'Hallo', { user: 'UBOT' })], new Map(), ME), [])
})

test('Systemnachrichten fallen weg, Meldungen mit Anhang bleiben', () => {
  const history = [
    msg('1.000001', 'ist beigetreten', { subtype: 'channel_join' }),
    msg('1.000002', 'Screenshot vom Fehler', { subtype: 'file_share' }),
  ]
  assert.deepEqual(toThreads(history, new Map(), ME).map((t) => t.top.text), ['Screenshot vom Fehler'])
})

test('thread_broadcast zählt nur als Antwort, nicht als Top-Post', () => {
  const history = [msg('1.000001', 'Bug', { reply_count: 1 }), msg('1.000002', 'auch im Channel', { subtype: 'thread_broadcast' })]
  const replies = new Map([['1.000001', [msg('1.000002', 'auch im Channel', { subtype: 'thread_broadcast' })]]])
  const threads = toThreads(history, replies, ME)
  assert.equal(threads.length, 1)
  assert.deepEqual(threads[0]?.replies, [{ level: 2, text: 'auch im Channel' }])
})

test('fehlende Bot-ID filtert keine fremden Nachrichten', () => {
  const threads = toThreads([msg('1.000001', 'Bug')], new Map(), { userId: 'UBOT', botId: '' })
  assert.equal(threads.length, 1)
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/slack-threads.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/sources/slack-threads.ts`:

```ts
import type { Thread } from '../types.ts'

/** Die Felder einer Slack-Nachricht, die der Agent braucht */
export type SlackMessage = {
  ts: string
  text?: string
  user?: string
  bot_id?: string
  subtype?: string
  reply_count?: number
}

/** Wer der eigene Bot ist, aus `auth.test`. Leerer Text, wenn Slack den Wert nicht liefert. */
export type BotIdentity = { userId: string; botId: string }

/** `file_share` ist eine Meldung mit Anhang; es zählt nur ihr Text. */
const TOP_SUBTYPES = new Set<string | undefined>([undefined, 'file_share'])
/** `thread_broadcast` ist eine Antwort, die auch im Channel erscheint. */
const REPLY_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast'])

/** `ts` lässt sich als Text vergleichen: zehn Stellen Sekunden, Punkt, sechs Stellen. */
function byTs(a: SlackMessage, b: SlackMessage): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
}

/**
 * Baut Threads aus der Channel-History und den Antworten je Top-Post
 * (Schlüssel: `ts` des Top-Posts). Eigene Nachrichten des Bots und
 * Systemnachrichten fallen weg. Slack-Threads sind flach: Antworten haben Ebene 2.
 */
export function toThreads(history: SlackMessage[], replies: Map<string, SlackMessage[]>, me: BotIdentity): Thread[] {
  const isOwn = (m: SlackMessage): boolean =>
    (me.userId !== '' && m.user === me.userId) || (me.botId !== '' && m.bot_id === me.botId)

  return history
    .filter((m) => !isOwn(m) && TOP_SUBTYPES.has(m.subtype))
    .sort(byTs)
    .map((top, index) => ({
      id: top.ts,
      index,
      top: { level: 1, text: top.text ?? '' },
      replies: (replies.get(top.ts) ?? [])
        // conversations.replies liefert den Top-Post als erstes Element mit.
        .filter((m) => m.ts !== top.ts && !isOwn(m) && REPLY_SUBTYPES.has(m.subtype))
        .sort(byTs)
        .map((m) => ({ level: 2, text: m.text ?? '' })),
    }))
}
```

- [ ] **Step 4: Test laufen lassen, er besteht**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/slack-threads.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 5: Commit**

```powershell
git add src/sources/slack-threads.ts test/slack-threads.test.ts
git commit -m "Bugfix-Agent: Slack-Nachrichten zu Threads"
```

---

### Task 5: `SlackSource` gegen Schnittstellen

**Files:**
- Create: `src/sources/slack.ts`
- Test: `test/slack-source.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/slack-source.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { slackReply, slackSource, type SlackApi, type SlackEvents, type SlackPage } from '../src/sources/slack.ts'
import type { SlackMessage } from '../src/sources/slack-threads.ts'

function fakeApi(history: SlackPage[], replies: Record<string, SlackPage[]> = {}) {
  const calls: string[] = []
  const posts: [string, string][] = []
  const pageAt = (pages: SlackPage[], cursor?: string): SlackPage => pages[cursor === undefined ? 0 : Number(cursor)]!
  const api: SlackApi = {
    channel: 'CBUGS',
    whoAmI: async () => (calls.push('whoAmI'), { userId: 'UBOT', botId: 'BBOT' }),
    history: async (cursor) => (calls.push(`history:${cursor ?? ''}`), pageAt(history, cursor)),
    replies: async (ts, cursor) => (calls.push(`replies:${ts}:${cursor ?? ''}`), pageAt(replies[ts]!, cursor)),
    post: async (threadTs, text) => {
      posts.push([threadTs, text])
    },
  }
  return { api, calls, posts }
}

const m = (ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({ ts, text, user: 'U1', ...extra })
const noEvents: SlackEvents = { start: () => {} }

test('readThreads folgt den Seiten von History und Replies', async () => {
  const { api } = fakeApi(
    [
      { messages: [m('1.000002', 'B')], nextCursor: '1' },
      { messages: [m('1.000001', 'A', { reply_count: 2 })] },
    ],
    {
      '1.000001': [
        { messages: [m('1.000001', 'A'), m('1.000003', 'a1')], nextCursor: '1' },
        { messages: [m('1.000004', 'a2')], nextCursor: '' },
      ],
    },
  )
  const threads = await slackSource(api, noEvents).readThreads()
  assert.notEqual(threads, 'missing')
  if (threads === 'missing') return
  assert.deepEqual(
    threads.map((t) => [t.id, t.top.text, t.replies.map((r) => r.text)]),
    [['1.000001', 'A', ['a1', 'a2']], ['1.000002', 'B', []]],
  )
})

test('auth.test nur einmal, Replies nur bei reply_count > 0', async () => {
  const { api, calls } = fakeApi([{ messages: [m('1.000001', 'A'), m('1.000002', 'B', { reply_count: 0 })] }])
  const source = slackSource(api, noEvents)
  await source.readThreads()
  await source.readThreads()
  assert.deepEqual(calls, ['whoAmI', 'history:', 'history:'])
})

test('Name und Label der Quelle', () => {
  const source = slackSource(fakeApi([]).api, noEvents)
  assert.equal(source.name, 'slack')
  assert.equal(source.label, 'Slack-Channel CBUGS')
})

test('watch: Nachrichten aus dem Channel lösen entprellt genau einmal aus, andere Channels nicht', async () => {
  let handlers: Parameters<SlackEvents['start']>[0] | undefined
  const events: SlackEvents = { start: (h) => (handlers = h) }
  let changes = 0
  slackSource(fakeApi([]).api, events, 20).watch(() => changes++)
  handlers!.message('CBUGS')
  handlers!.message('CBUGS')
  handlers!.message('CANDERS')
  await sleep(60)
  assert.equal(changes, 1)
  handlers!.message('CANDERS')
  await sleep(60)
  assert.equal(changes, 1)
})

test('watch: jedes Verbinden löst einen Lauf aus', async () => {
  let handlers: Parameters<SlackEvents['start']>[0] | undefined
  const events: SlackEvents = { start: (h) => (handlers = h) }
  let changes = 0
  slackSource(fakeApi([]).api, events, 20).watch(() => changes++)
  handlers!.connected()
  await sleep(60)
  handlers!.connected()
  await sleep(60)
  assert.equal(changes, 2)
})

test('slackReply postet in den Thread', async () => {
  const { api, posts } = fakeApi([])
  await slackReply(api)('1.000001', 'Ticket bug-1 angelegt: X (Y, hoch)')
  assert.deepEqual(posts, [['1.000001', 'Ticket bug-1 angelegt: X (Y, hoch)']])
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/slack-source.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/sources/slack.ts`:

```ts
import type { ChatReply } from '../types.ts'
import { toThreads, type BotIdentity, type SlackMessage } from './slack-threads.ts'
import type { ChatSource } from './types.ts'

export type SlackPage = { messages: SlackMessage[]; nextCursor?: string }

/** Die Web-API-Aufrufe für einen Channel. Echt in `slack-client.ts`, in Tests ein Fake. */
export type SlackApi = {
  channel: string
  whoAmI(): Promise<BotIdentity>
  history(cursor?: string): Promise<SlackPage>
  replies(ts: string, cursor?: string): Promise<SlackPage>
  post(threadTs: string, text: string): Promise<void>
}

/** Socket Mode: meldet Nachrichten-Events mit ihrem Channel und jedes Verbinden, auch nach einem Reconnect. */
export type SlackEvents = {
  start(handlers: { message(channel: string): void; connected(): void }): void
}

/** Mehrere Events kurz hintereinander, etwa Nachricht und Bearbeitung, ergeben einen Lauf. */
export const SLACK_DEBOUNCE_MS = 1000

async function readAll(fetchPage: (cursor?: string) => Promise<SlackPage>): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    messages.push(...page.messages)
    cursor = page.nextCursor
  } while (cursor !== undefined && cursor !== '')
  return messages
}

/**
 * Liest bei jedem Lauf den ganzen Channel neu. Events lösen nur einen Lauf aus
 * und werden nicht selbst ausgewertet; so holt der erste Lauf nach einer Pause alles nach.
 */
export function slackSource(api: SlackApi, events: SlackEvents, debounceMs = SLACK_DEBOUNCE_MS): ChatSource {
  let me: BotIdentity | undefined
  return {
    name: 'slack',
    label: `Slack-Channel ${api.channel}`,
    async readThreads() {
      me ??= await api.whoAmI()
      const history = await readAll((cursor) => api.history(cursor))
      const replies = new Map<string, SlackMessage[]>()
      for (const top of history) {
        if ((top.reply_count ?? 0) > 0) {
          replies.set(top.ts, await readAll((cursor) => api.replies(top.ts, cursor)))
        }
      }
      return toThreads(history, replies, me)
    },
    watch(onChange) {
      let timer: NodeJS.Timeout | undefined
      const later = (): void => {
        clearTimeout(timer)
        timer = setTimeout(onChange, debounceMs)
      }
      events.start({
        message: (channel) => {
          if (channel === api.channel) later()
        },
        connected: later,
      })
    },
  }
}

export function slackReply(api: SlackApi): ChatReply {
  return (threadId, text) => api.post(threadId, text)
}
```

- [ ] **Step 4: Test laufen lassen, er besteht**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/slack-source.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 5: Commit**

```powershell
git add src/sources/slack.ts test/slack-source.test.ts
git commit -m "Bugfix-Agent: Slack-Quelle liest Channel neu, Events lösen Lauf aus"
```

---

### Task 6: Echter Slack-Client

**Files:**
- Create: `src/sources/slack-client.ts`
- Modify: `package.json`, `package-lock.json`

Dieser Task hat keinen Unit-Test: Er übersetzt nur zwischen den Slack-Paketen und den Schnittstellen aus Task 5. Geprüft wird er durch `tsc`, einen Import-Test und den manuellen Lauf in Task 9.

- [ ] **Step 1: Pakete installieren**

Run: `npm install --save-exact @slack/web-api@8.5.0 @slack/socket-mode@3.2.0`
Expected: `package.json` hat unter `dependencies` die Einträge `"@slack/socket-mode": "3.2.0"` und `"@slack/web-api": "8.5.0"`.

- [ ] **Step 2: Import-Test schreiben**

`test/slack-client.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { socketModeEvents, webApiClient } from '../src/sources/slack-client.ts'

// Prüft nur, dass sich die CommonJS-Pakete laden lassen. Es wird nichts gesendet.
test('webApiClient und socketModeEvents lassen sich ohne Netz anlegen', () => {
  const api = webApiClient('xoxb-test', 'CBUGS')
  assert.equal(api.channel, 'CBUGS')
  assert.equal(typeof socketModeEvents('xapp-test', () => {}).start, 'function')
})
```

- [ ] **Step 3: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/slack-client.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 4: Implementieren**

`src/sources/slack-client.ts`:

```ts
import socketMode from '@slack/socket-mode'
import webApi from '@slack/web-api'
import type { SlackMessage } from './slack-threads.ts'
import type { SlackApi, SlackEvents, SlackPage } from './slack.ts'

// Beide Pakete sind CommonJS. Benannte Importe scheitern unter Node zur Laufzeit, der Default-Import nicht.
const { SocketModeClient } = socketMode
const { WebClient, retryPolicies, LogLevel } = webApi

type RawMessage = { ts?: string; text?: string; user?: string; bot_id?: string; subtype?: string; reply_count?: number }

function toMessage(raw: RawMessage): SlackMessage {
  return {
    ts: raw.ts ?? '',
    text: raw.text,
    user: raw.user,
    bot_id: raw.bot_id,
    subtype: raw.subtype,
    reply_count: raw.reply_count,
  }
}

function toPage(response: { messages?: RawMessage[]; response_metadata?: { next_cursor?: string } }): SlackPage {
  return { messages: (response.messages ?? []).map(toMessage), nextCursor: response.response_metadata?.next_cursor }
}

export function webApiClient(token: string, channel: string): SlackApi {
  const client = new WebClient(token, {
    // Fünf Versuche in fünf Minuten statt zehn in dreißig: Ein Lauf soll nicht eine halbe Stunde hängen.
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    logLevel: LogLevel.ERROR,
  })
  return {
    channel,
    async whoAmI() {
      const response = await client.auth.test()
      return { userId: response.user_id ?? '', botId: response.bot_id ?? '' }
    },
    async history(cursor) {
      return toPage(await client.conversations.history({ channel, cursor, limit: 200 }))
    },
    async replies(ts, cursor) {
      return toPage(await client.conversations.replies({ channel, ts, cursor, limit: 200 }))
    },
    async post(threadTs, text) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text })
    },
  }
}

export function socketModeEvents(appToken: string, log: (message: string) => void): SlackEvents {
  return {
    start(handlers) {
      const client = new SocketModeClient({ appToken, logLevel: socketMode.LogLevel.ERROR })
      client.on('message', async ({ event, ack }: { event?: { channel?: string }; ack: () => Promise<void> }) => {
        // Sofort bestätigen, sonst stellt Slack das Event erneut zu.
        await ack()
        handlers.message(event?.channel ?? '')
      })
      client.on('connected', () => handlers.connected())
      client.start().catch((error: unknown) => {
        log(`Socket Mode: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
  }
}
```

Meldet `tsc` in Step 5, dass `MessageElement` nicht zu `RawMessage` passt, `RawMessage` an die Felder von `MessageElement` aus `node_modules/@slack/web-api/dist/types/response/ConversationsHistoryResponse.d.ts` angleichen. Die Felder von `SlackMessage` bleiben unverändert.

- [ ] **Step 5: Tests und Typen prüfen**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/slack-client.test.ts; npm run typecheck`
Expected: PASS, `tsc` ohne Fehler.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json src/sources/slack-client.ts test/slack-client.test.ts
git commit -m "Bugfix-Agent: Slack-Client mit Web-API und Socket Mode"
```

---

### Task 7: Quelle aus der Konfiguration wählen

**Files:**
- Create: `src/sources/config.ts`
- Modify: `src/main.ts`, `.env.example`, `.gitignore`, `package.json` (Beschreibung)
- Test: `test/config.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chooseChat, slackReplyFromEnv } from '../src/sources/config.ts'

const ROOT = join('projekt', 'agent')
const log = () => {}
const SLACK = { CHAT_SOURCE: 'slack', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_CHANNEL_ID: 'CBUGS' }

test('ohne CHAT_SOURCE: Datei chat.txt und state.json', () => {
  const chat = chooseChat({}, ROOT, log)
  assert.ok(!('error' in chat))
  assert.equal(chat.source.name, 'datei')
  assert.equal(chat.source.label, join(ROOT, 'chat.txt'))
  assert.equal(chat.statePath, join(ROOT, 'state.json'))
})

test('CHAT_FILE wählt eine andere Datei', () => {
  const chat = chooseChat({ CHAT_FILE: 'demo-chat.txt' }, ROOT, log)
  assert.ok(!('error' in chat))
  assert.equal(chat.source.label, 'demo-chat.txt')
})

test('slack mit allen Variablen: Slack-Quelle und state.slack.json', () => {
  const chat = chooseChat(SLACK, ROOT, log)
  assert.ok(!('error' in chat))
  assert.equal(chat.source.name, 'slack')
  assert.equal(chat.source.label, 'Slack-Channel CBUGS')
  assert.equal(chat.statePath, join(ROOT, 'state.slack.json'))
})

test('slack ohne Variable nennt sie', () => {
  assert.deepEqual(chooseChat({ ...SLACK, SLACK_APP_TOKEN: ' ' }, ROOT, log), {
    error: 'SLACK_APP_TOKEN fehlt. Trage es in .env ein (siehe .env.example).',
  })
})

test('unbekannte Quelle', () => {
  assert.deepEqual(chooseChat({ CHAT_SOURCE: 'teams' }, ROOT, log), {
    error: 'CHAT_SOURCE=teams ist unbekannt. Erlaubt: datei, slack.',
  })
})

test('slackReplyFromEnv braucht Bot-Token und Channel', () => {
  assert.equal(slackReplyFromEnv({ SLACK_BOT_TOKEN: 'xoxb-1' }), undefined)
  assert.equal(typeof slackReplyFromEnv(SLACK), 'function')
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/config.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/sources/config.ts`:

```ts
import { join } from 'node:path'
import type { ChatReply } from '../types.ts'
import { fileReply, fileSource } from './file.ts'
import { socketModeEvents, webApiClient } from './slack-client.ts'
import { slackReply, slackSource } from './slack.ts'
import type { ChatSource } from './types.ts'

type Env = Record<string, string | undefined>

export type ChatSetup = { source: ChatSource; reply: ChatReply; statePath: string }

const SLACK_SETTINGS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID'] as const

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Wählt die Quelle nach `CHAT_SOURCE`. Jede Quelle hat eine eigene
 * Zustandsdatei, damit sich Positionen und Slack-IDs nicht vermischen.
 */
export function chooseChat(env: Env, root: string, log: (message: string) => void): ChatSetup | { error: string } {
  const name = setting(env, 'CHAT_SOURCE') ?? 'datei'
  if (name === 'datei') {
    return {
      source: fileSource(setting(env, 'CHAT_FILE') ?? join(root, 'chat.txt')),
      reply: fileReply(log),
      statePath: join(root, 'state.json'),
    }
  }
  if (name !== 'slack') return { error: `CHAT_SOURCE=${name} ist unbekannt. Erlaubt: datei, slack.` }

  const missing = SLACK_SETTINGS.find((key) => setting(env, key) === undefined)
  if (missing !== undefined) return { error: `${missing} fehlt. Trage es in .env ein (siehe .env.example).` }
  const api = webApiClient(setting(env, 'SLACK_BOT_TOKEN')!, setting(env, 'SLACK_CHANNEL_ID')!)
  return {
    source: slackSource(api, socketModeEvents(setting(env, 'SLACK_APP_TOKEN')!, log)),
    reply: slackReply(api),
    statePath: join(root, 'state.slack.json'),
  }
}

/** Für `npm run steps`: Antworten nach Slack, wenn Bot-Token und Channel gesetzt sind. */
export function slackReplyFromEnv(env: Env): ChatReply | undefined {
  const token = setting(env, 'SLACK_BOT_TOKEN')
  const channel = setting(env, 'SLACK_CHANNEL_ID')
  return token === undefined || channel === undefined ? undefined : slackReply(webApiClient(token, channel))
}
```

`src/main.ts` vollständig:

```ts
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRouterModel } from './llm.ts'
import { createLog } from './log.ts'
import { runOnce, type RunDeps } from './run.ts'
import { chooseChat } from './sources/config.ts'
import { createSerialRunner } from './watch.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.env.OPENROUTER_MODEL ?? '~anthropic/claude-haiku-latest'

const log = createLog(join(ROOT, 'agent.log'))

function describeError(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? ` (HTTP ${String((error as { statusCode: unknown }).statusCode)})`
      : ''
  return `Fehler${status}: ${error instanceof Error ? error.message : String(error)}`
}

/** Exit-Codes: 2 = falsch aufgerufen, 1 = Lauf fehlgeschlagen. */
async function main(): Promise<number | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey === undefined || apiKey.trim() === '') {
    log('OPENROUTER_API_KEY fehlt. Trage ihn in .env ein (siehe .env.example).')
    return 2
  }

  const chat = chooseChat(process.env, ROOT, log)
  if ('error' in chat) {
    log(chat.error)
    return 2
  }

  const deps: RunDeps = {
    source: chat.source,
    reply: chat.reply,
    statePath: chat.statePath,
    ticketDir: join(ROOT, 'tickets'),
    runModel: openRouterModel(apiKey, MODEL),
    log,
  }

  if (!process.argv.includes('--watch')) {
    try {
      if ((await runOnce(deps)) === 'missing') {
        log(`${chat.source.label} nicht gefunden.`)
        return 1
      }
      return 0
    } catch (error) {
      log(describeError(error))
      return 1
    }
  }

  const trigger = createSerialRunner(async () => {
    if ((await runOnce(deps)) === 'missing') log(`Warte auf ${chat.source.label} …`)
  }, (error) => log(describeError(error)))

  // Watcher bzw. Socket-Verbindung halten den Prozess am Leben, bis Strg+C.
  chat.source.watch(() => void trigger())
  log(`Beobachte ${chat.source.label} mit ${MODEL} (Strg+C beendet).`)
  await trigger()
  return undefined
}

process.exitCode = await main()
```

`.env.example`, nach der Zeile `# CHAT_FILE=` einfügen:

```
# Optional, Default: datei. Mit slack liest der Agent den Channel SLACK_CHANNEL_ID.
# CHAT_SOURCE=
# Bot-Token xoxb-… (OAuth & Permissions). Auch npm run steps nutzt ihn für Statusmeldungen.
# SLACK_BOT_TOKEN=
# App-Level-Token xapp-… mit Scope connections:write (Basic Information)
# SLACK_APP_TOKEN=
# Channel-ID von #bugs, beginnt mit C (Channel-Details, ganz unten)
# SLACK_CHANNEL_ID=
```

`.gitignore`, unter `state.json` ergänzen: `state.slack.json`

`package.json`, `"description"`: `"Überwacht chat.txt oder einen Slack-Channel und legt Bug-Tickets an"`

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Datei-Modus von Hand prüfen**

Run: `$env:CHAT_SOURCE='teams'; npm start; Remove-Item Env:CHAT_SOURCE`
Expected: Ausgabe `CHAT_SOURCE=teams ist unbekannt. Erlaubt: datei, slack.`, Exit-Code 2. Es entsteht kein Modell-Aufruf.

- [ ] **Step 6: Commit**

```powershell
git add src test .env.example .gitignore package.json
git commit -m "Bugfix-Agent: Chat-Quelle über CHAT_SOURCE wählen"
```

---

### Task 8: Statuswechsel im Slack-Thread melden

**Files:**
- Modify: `src/steps/runner.ts`, `src/steps-main.ts`
- Test: `test/runner.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/runner.test.ts`, ergänzen:

```ts
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
  assert.ok(env.logs.includes('Warnung: Antwort an Thread 1764000000.000100 gescheitert: not_in_channel'), env.logs.join('\n'))
})

test('Slack-Ticket ohne Slack-Konfiguration: Warnung statt Antwort', async () => {
  const env = await slackSetup(undefined)
  assert.equal(await runSteps(env.deps), 0)
  assert.ok(
    env.logs.includes('Warnung: Ticket 1 stammt aus Slack, aber SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID fehlt. Keine Antwort im Thread.'),
    env.logs.join('\n'),
  )
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/runner.test.ts`
Expected: FAIL, keine Antworten, keine Warnungen.

- [ ] **Step 3: Implementieren**

`src/steps/runner.ts`:
- Import ergänzen: `import type { ChatReply } from '../types.ts'`
- `RunnerDeps` ergänzen:

```ts
  /** Antwortet in Slack-Threads. Fehlt, wenn SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID nicht gesetzt ist. */
  reply?: ChatReply
```

- Neue Funktion vor `advance`:

```ts
/** Meldet einen Statuswechsel im Slack-Thread des Tickets. Wirft nie. */
async function announce(ticket: Ticket, text: string, deps: RunnerDeps): Promise<void> {
  if (ticket.header.get('quelle') !== 'slack') return
  const thread = ticket.header.get('thread')
  if (deps.reply === undefined || thread === undefined) {
    deps.log(
      `Warnung: Ticket ${ticket.id} stammt aus Slack, aber SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID fehlt. Keine Antwort im Thread.`,
    )
    return
  }
  try {
    await deps.reply(thread, text)
  } catch (error) {
    deps.log(`Warnung: Antwort an Thread ${thread} gescheitert: ${message(error)}`)
  }
}
```

- In `advance` den `try`-Block ersetzen:

```ts
    try {
      const result = await step.run(ticket)
      // Neu lesen: Der Chat-Agent kann während des Schritts einen Nachtrag angehängt haben.
      const updated = applyResult(await readTicket(deps.ticketDir, id), result)
      await writeTicket(deps.ticketDir, updated)
      const change = `${result.status} ${result.summary}`.trimEnd()
      deps.log(`Ticket ${id} ${step.name} → ${change}`)
      await announce(updated, `bug-${id}: ${change}`, deps)
    } catch (error) {
```

`src/steps-main.ts`:
- Import ergänzen: `import { slackReplyFromEnv } from './sources/config.ts'`
- Im Objekt für `runSteps` nach `only,` ergänzen: `reply: slackReplyFromEnv(process.env),`

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Statuswechsel im Slack-Thread melden"
```

---

### Task 9: README, Spec-Abgleich, manueller Lauf

**Files:**
- Modify: `README.md`, `docs/specs/2026-11-24-slack-quelle-design.md`

- [ ] **Step 1: Spec an den Text der Statusmeldung angleichen**

In der Tabelle unter „Rückmeldungen“ der Spec die Zeile für den Runner ersetzen:

```
| Runner, Statuswechsel | `bug-<id>: <status> <summary>`, also dieselbe Angabe wie im Log, z. B. `bug-3: analysiert (0.84 $): Vergleich ohne Umlaut-Normalisierung.` |
```

Grund: `summary` beginnt schon mit den Kosten und einem Doppelpunkt. Ein Gedankenstrich davor ergäbe `– (0.84 $): …`.

- [ ] **Step 2: README ergänzen**

Erster Absatz: „Überwacht `chat.txt`“ → „Überwacht `chat.txt` oder einen Slack-Channel“.

Vor `## Erweitern` einen Abschnitt einfügen:

````markdown
## Slack

Mit `CHAT_SOURCE=slack` liest der Agent statt `chat.txt` den Channel `SLACK_CHANNEL_ID` und antwortet im Thread einer Meldung, wenn ein Ticket entsteht, wenn er einen Nachtrag anhängt und wenn `npm run steps` den Status ändert. Zu Nachrichten ohne Bug schreibt er nichts.

Einrichtung, einmalig:

1. Einen eigenen, kostenlosen Workspace anlegen, nicht den Firmen-Workspace, darin den Channel `#bugs`.
2. Auf https://api.slack.com/apps „Create New App“ → „From a manifest“, Manifest aus `docs/specs/2026-11-24-slack-quelle-design.md`, Abschnitt „Einrichtung in Slack“.
3. „Basic Information“ → „App-Level Tokens“ → Token mit Scope `connections:write` erzeugen (`xapp-…`).
4. „OAuth & Permissions“ → „Install to Workspace“, Bot-Token kopieren (`xoxb-…`).
5. In `#bugs`: `/invite @bugfix-agent`.
6. Channel-ID aus den Channel-Details ablesen (`C…`).
7. In `.env`: `CHAT_SOURCE=slack`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`.

Danach `npm run watch`. Der Agent merkt sich den Slack-Stand in `state.slack.json`, getrennt von `state.json`. Die Tickets liegen für beide Quellen in `tickets/` und tragen im Kopf `quelle: slack` bzw. `quelle: datei`.

Ist der Agent offline, holt der nächste Start alle Nachrichten nach. Schlägt eine Antwort fehl, steht eine Warnung im Log und der Agent macht weiter. Er wiederholt die Antwort nicht.
````

Im Abschnitt „Analysieren und Planen“ nach der Statusliste ergänzen:

```markdown
Bei Tickets mit `quelle: slack` erscheint jeder Statuswechsel im Thread der Meldung. Dafür braucht `npm run steps` `SLACK_BOT_TOKEN` und `SLACK_CHANNEL_ID`, aber keinen Socket Mode.
```

Letzte Zeile: `Spec: …` → `Specs: docs/specs/2026-11-23-analyse-plan-design.md, docs/specs/2026-11-24-slack-quelle-design.md. Fix, Push und MR folgen in Stufe 3.`

- [ ] **Step 3: Alles prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/specs/2026-11-24-slack-quelle-design.md
git commit -m "Bugfix-Agent: README für Slack, Spec an Statustext angeglichen"
```

- [ ] **Step 5: Manueller Lauf im eigenen Workspace (mit dem Nutzer)**

Voraussetzung: Der Nutzer hat die App eingerichtet und die vier Werte in `.env` eingetragen. Der Nutzer startet die Prozesse selbst oder gibt sie frei.

1. `npm run watch`. Erwartet: `Beobachte Slack-Channel C… mit …`, danach ein Lauf ohne Fehler.
2. Nutzer postet in `#bugs`: „Die Suche mit Kleinbuchstaben findet Müller nicht.“ Erwartet: neues Ticket mit `quelle: slack` und `thread: <ts>`, im Thread die Antwort `Ticket bug-N angelegt: … (Suche, mittel)`.
3. Nutzer antwortet im Thread: „Passiert nur bei Umlauten.“ Erwartet: Nachtrag im Ticket, Antwort `Nachtrag an bug-N angehängt.`
4. Nutzer postet: „Gibt es heute Kuchen?“ Erwartet: kein Ticket, keine Antwort, Begründung im Log.
5. Die Antworten des Bots erzeugen keine weiteren Ereignisse: Im Log stehen nach jeder Bot-Antwort höchstens ein Lauf und keine Zeile `neue Antwort`.
6. Agent mit Strg+C beenden, Nutzer antwortet im Thread aus Schritt 2: „Seit dem letzten Update.“ Agent neu starten. Erwartet: Der Nachtrag wird nachgeholt, Antwort im Thread.
7. Mit `TARGET_REPO` auf das Demo-Repo: `$env:TICKET=<N>; npm run steps; Remove-Item Env:TICKET`. Erwartet: im Thread `bug-N: analysiert (… $): …` und `bug-N: geplant (… $): …`.

Ergebnisse und Kosten im Gedächtnis-Eintrag zum Projekt festhalten.
