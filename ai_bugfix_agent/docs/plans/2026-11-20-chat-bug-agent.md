# Chat-Bug-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Agent liest `chat.txt`, erkennt Bug-Meldungen in Top-Threads per LLM, legt `tickets/bug_N.txt` an und hängt relevante Antworten an bestehende Tickets an, einmalig oder im `--watch`-Modus.

**Architecture:** Reine Funktionen zerlegen den Chat (`parser`) und ermitteln neue Ereignisse gegen einen gespeicherten Zustand (`diff`, `state`). Pro Ereignis läuft ein LLM-Agent (`agent`) mit den Tools `create_ticket` und `append_to_ticket`. Der Modell-Aufruf wird injiziert, sodass alles außer `llm.ts` ohne Netz testbar ist. `run.ts` verbindet die Teile, `main.ts` ist die CLI.

**Tech Stack:** TypeScript, Node 22 mit `--experimental-strip-types`, `@openrouter/agent` 0.11.0, `zod` 4, `node:test`.

**Spec:** `ai_bugfix_agent/docs/specs/2026-11-20-chat-bug-agent-design.md`

**Abweichung von der Spec:** Der Typ `Event` heißt im Code `ChatEvent`, damit er nicht mit dem globalen `Event` aus `@types/node` kollidiert.

---

## Dateistruktur

Alle Pfade relativ zu `ai_bugfix_agent/`. Alle Befehle laufen in `ai_bugfix_agent/`.

| Datei | Verantwortung |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | Projektgerüst, wie `openrouter/` |
| `src/types.ts` | `Post`, `Thread`, `ChatEvent`, `ThreadState`, `State` |
| `src/parser.ts` | `parseChat`, `formatPost` |
| `src/state.ts` | `hashText`, `loadState`, `saveState`, `ensureThread`, `applyEvent`, `isNotFound` |
| `src/diff.ts` | `diff` |
| `src/tickets.ts` | `formatTimestamp`, `nextTicketNumber`, `formatTicket`, `createTicket`, `appendToTicket` |
| `src/tools/types.ts` | `ToolContext`, `AgentTool`, `defineTool` |
| `src/tools/create_ticket.ts` | Tool `create_ticket` |
| `src/tools/append_to_ticket.ts` | Tool `append_to_ticket` |
| `src/tools/index.ts` | `TOOLS`-Liste |
| `src/prompt.md` | System-Prompt |
| `src/agent.ts` | `MAX_STEPS`, `RunModel`, `BoundTool`, `describeEvent`, `handleEvent` |
| `src/run.ts` | `RunDeps`, `runOnce` |
| `src/watch.ts` | `createSerialRunner`, `watchChat` |
| `src/llm.ts` | `openRouterModel` (einziger Ort mit Netzaufruf) |
| `src/main.ts` | CLI |
| `test/*.test.ts` | Tests pro Modul |
| `README.md` | Bedienung und Erweiterung |

---

### Task 1: Projektgerüst und Typen

**Files:**
- Create: `ai_bugfix_agent/package.json`
- Create: `ai_bugfix_agent/tsconfig.json`
- Create: `ai_bugfix_agent/.gitignore`
- Create: `ai_bugfix_agent/.env.example`
- Create: `ai_bugfix_agent/src/types.ts`

- [ ] **Step 1: `package.json` anlegen**

```json
{
  "name": "ai-bugfix-agent",
  "version": "0.1.0",
  "private": true,
  "description": "Überwacht chat.txt und legt Bug-Tickets an",
  "type": "module",
  "scripts": {
    "start": "node --experimental-strip-types --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/main.ts",
    "test": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test \"test/**/*.test.ts\"",
    "typecheck": "tsc"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "typescript": "^7.0.2"
  },
  "dependencies": {
    "@openrouter/agent": "0.11.0",
    "zod": "4.5.4"
  }
}
```

- [ ] **Step 2: `tsconfig.json` anlegen**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],

    "strict": true,
    "noUncheckedIndexedAccess": true,

    // Node entfernt Typen nur, statt zu kompilieren: kein enum, kein namespace,
    // `import type` für reine Typ-Importe.
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,

    // Relative Importe enden auf ".ts", weil Node keine Endungen umschreibt.
    "allowImportingTsExtensions": true,
    "noEmit": true,

    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: `.gitignore` anlegen**

```
node_modules/

# Enthält den OpenRouter-API-Key. Nie committen.
.env
.env.*
!.env.example

# Laufzeitdaten des Agenten
state.json
tickets/

.idea/
```

- [ ] **Step 4: `.env.example` anlegen**

```
# Key von https://openrouter.ai/keys
OPENROUTER_API_KEY=
# Optional, Default: ~anthropic/claude-haiku-latest
# OPENROUTER_MODEL=
# Optional, Default: chat.txt neben package.json
# CHAT_FILE=
```

- [ ] **Step 5: `src/types.ts` anlegen**

```ts
/** Ein Beitrag im Chat. Ebene 1 ist ein Top-Post, 2 eine Antwort darauf usw. */
export type Post = { level: number; text: string }

/** Ein Top-Post mit allen Antworten bis zum nächsten Top-Post. `index` zählt ab 0. */
export type Thread = { index: number; top: Post; replies: Post[] }

export type ChatEvent =
  | { kind: 'NewThread'; thread: Thread }
  | { kind: 'NewReply'; thread: Thread; reply: Post; replyIndex: number }

export type ThreadState = { topHash: string; replyCount: number; ticket: number | null }

/** Position im Array = Thread-Index. Lücken erscheinen in JSON als null. */
export type State = { threads: (ThreadState | null)[] }
```

- [ ] **Step 6: Abhängigkeiten installieren**

Run: `npm install`
Expected: legt `node_modules/` und `package-lock.json` an, keine Fehler.

- [ ] **Step 7: Commit**

```bash
git add ai_bugfix_agent/package.json ai_bugfix_agent/package-lock.json ai_bugfix_agent/tsconfig.json ai_bugfix_agent/.gitignore ai_bugfix_agent/.env.example ai_bugfix_agent/src/types.ts
git commit -m "Bugfix-Agent: Projektgerüst und Typen"
```

---

### Task 2: Parser

**Files:**
- Create: `ai_bugfix_agent/src/parser.ts`
- Test: `ai_bugfix_agent/test/parser.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPost, parseChat } from '../src/parser.ts'

test('leere Datei ergibt keine Threads', () => {
  assert.deepEqual(parseChat(''), [])
})

test('Top-Posts und Antworten mit Ebenen', () => {
  const text = '> Die Suche ist langsam.\n>> oje\n>>> wirklich\n> Neues Thema\n'
  assert.deepEqual(parseChat(text), [
    {
      index: 0,
      top: { level: 1, text: 'Die Suche ist langsam.' },
      replies: [
        { level: 2, text: 'oje' },
        { level: 3, text: 'wirklich' },
      ],
    },
    { index: 1, top: { level: 1, text: 'Neues Thema' }, replies: [] },
  ])
})

test('Zeilen ohne Präfix setzen den vorigen Post fort', () => {
  const text = '> Zeile eins\nZeile zwei\n\n>> Antwort\nmehr\n'
  const [thread] = parseChat(text)
  assert.equal(thread?.top.text, 'Zeile eins\nZeile zwei')
  assert.equal(thread?.replies[0]?.text, 'Antwort\nmehr')
})

test('Text und Antworten vor dem ersten Top-Post werden ignoriert', () => {
  const text = 'Kopfzeile\n>> verirrte Antwort\n> Erster Post'
  assert.deepEqual(parseChat(text), [
    { index: 0, top: { level: 1, text: 'Erster Post' }, replies: [] },
  ])
})

test('Windows-Zeilenenden und fehlendes Leerzeichen', () => {
  assert.deepEqual(parseChat('>Bug\r\n>>ja\r\n'), [
    { index: 0, top: { level: 1, text: 'Bug' }, replies: [{ level: 2, text: 'ja' }] },
  ])
})

test('formatPost setzt das Präfix vor jede Zeile', () => {
  assert.equal(formatPost({ level: 2, text: 'a\nb' }), '>> a\n>> b')
})
```

- [ ] **Step 2: Test ausführen, er muss fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/parser.ts'`

- [ ] **Step 3: Implementierung**

```ts
import type { Post, Thread } from './types.ts'

const POST_LINE = /^(>+) ?(.*)$/

/**
 * Zerlegt den Chat in Threads. Eine Zeile mit genau einem `>` beginnt einen
 * Top-Post, mehr `>` eine Antwort der entsprechenden Ebene. Zeilen ohne Präfix
 * gehören zum vorigen Post; vor dem ersten Top-Post wird alles ignoriert.
 */
export function parseChat(text: string): Thread[] {
  const threads: Thread[] = []
  let current: Post | undefined

  for (const line of text.split(/\r?\n/)) {
    const match = POST_LINE.exec(line)
    if (match === null) {
      if (current !== undefined) current.text += `\n${line}`
      continue
    }

    const post: Post = { level: match[1]!.length, text: match[2]! }
    if (post.level === 1) {
      threads.push({ index: threads.length, top: post, replies: [] })
      current = post
      continue
    }

    const thread = threads.at(-1)
    if (thread === undefined) {
      current = undefined
      continue
    }
    thread.replies.push(post)
    current = post
  }

  for (const thread of threads) {
    for (const post of [thread.top, ...thread.replies]) post.text = post.text.trimEnd()
  }
  return threads
}

/** Gibt einen Post wieder im Chat-Format aus, mit Präfix vor jeder Zeile. */
export function formatPost(post: Post): string {
  const prefix = '>'.repeat(post.level)
  return post.text
    .split('\n')
    .map((line) => `${prefix} ${line}`)
    .join('\n')
}
```

- [ ] **Step 4: Test ausführen, er muss bestehen**

Run: `npm test`
Expected: PASS, 6 Tests

- [ ] **Step 5: Commit**

```bash
git add ai_bugfix_agent/src/parser.ts ai_bugfix_agent/test/parser.test.ts
git commit -m "Bugfix-Agent: Chat-Parser"
```

---

### Task 3: Zustand und Diff

**Files:**
- Create: `ai_bugfix_agent/src/state.ts`
- Create: `ai_bugfix_agent/src/diff.ts`
- Test: `ai_bugfix_agent/test/state.test.ts`
- Test: `ai_bugfix_agent/test/diff.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

`test/state.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvent, ensureThread, hashText, loadState, saveState } from '../src/state.ts'
import type { State, Thread } from '../src/types.ts'

const thread: Thread = {
  index: 0,
  top: { level: 1, text: 'Bug' },
  replies: [{ level: 2, text: 'a' }, { level: 2, text: 'b' }],
}

test('fehlende Zustandsdatei ergibt leeren Zustand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  assert.deepEqual(await loadState(join(dir, 'state.json')), { threads: [] })
})

test('Zustand übersteht Speichern und Laden', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugagent-'))
  const path = join(dir, 'state.json')
  const state: State = { threads: [{ topHash: 'x', replyCount: 2, ticket: 7 }] }
  await saveState(path, state)
  assert.deepEqual(await loadState(path), state)
})

test('ensureThread legt Eintrag an und liefert danach denselben', () => {
  const state: State = { threads: [] }
  const entry = ensureThread(state, thread)
  assert.deepEqual(entry, { topHash: hashText('Bug'), replyCount: 0, ticket: null })
  assert.equal(ensureThread(state, thread), entry)
})

test('applyEvent zählt Antworten hoch', () => {
  const state: State = { threads: [] }
  applyEvent(state, { kind: 'NewThread', thread })
  applyEvent(state, { kind: 'NewReply', thread, reply: thread.replies[1]!, replyIndex: 1 })
  assert.equal(state.threads[0]?.replyCount, 2)
})
```

`test/diff.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diff } from '../src/diff.ts'
import { hashText } from '../src/state.ts'
import type { State, Thread } from '../src/types.ts'

const thread: Thread = {
  index: 0,
  top: { level: 1, text: 'Bug' },
  replies: [{ level: 2, text: 'a' }, { level: 2, text: 'b' }],
}

test('unbekannter Thread ergibt NewThread und ein NewReply je Antwort', () => {
  const { events, warnings } = diff([thread], { threads: [] })
  assert.deepEqual(
    events.map((e) => (e.kind === 'NewReply' ? `reply:${e.replyIndex}` : e.kind)),
    ['NewThread', 'reply:0', 'reply:1'],
  )
  assert.deepEqual(warnings, [])
})

test('bekannter Thread liefert nur neue Antworten', () => {
  const state: State = { threads: [{ topHash: hashText('Bug'), replyCount: 1, ticket: 3 }] }
  const { events } = diff([thread], state)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.kind, 'NewReply')
  if (event?.kind === 'NewReply') assert.equal(event.reply.text, 'b')
})

test('nichts Neues ergibt keine Ereignisse', () => {
  const state: State = { threads: [{ topHash: hashText('Bug'), replyCount: 2, ticket: null }] }
  assert.deepEqual(diff([thread], state), { events: [], warnings: [] })
})

test('geänderter Top-Post ergibt Warnung statt Ereignissen', () => {
  const state: State = { threads: [{ topHash: hashText('anders'), replyCount: 0, ticket: null }] }
  const { events, warnings } = diff([thread], state)
  assert.deepEqual(events, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /Thread 0/)
})
```

- [ ] **Step 2: Tests ausführen, sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/state.ts'` bzw. `.../src/diff.ts`

- [ ] **Step 3: `src/state.ts` implementieren**

```ts
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { ChatEvent, State, Thread, ThreadState } from './types.ts'

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}

export async function loadState(path: string): Promise<State> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as State
  } catch (error) {
    if (isNotFound(error)) return { threads: [] }
    throw error
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

/** Liefert den Zustand eines Threads und legt ihn beim ersten Mal an. */
export function ensureThread(state: State, thread: Thread): ThreadState {
  const existing = state.threads[thread.index]
  if (existing !== undefined && existing !== null) return existing
  const created: ThreadState = { topHash: hashText(thread.top.text), replyCount: 0, ticket: null }
  state.threads[thread.index] = created
  return created
}

/** Vermerkt ein verarbeitetes Ereignis im Zustand. */
export function applyEvent(state: State, event: ChatEvent): void {
  const entry = ensureThread(state, event.thread)
  if (event.kind === 'NewReply') {
    entry.replyCount = Math.max(entry.replyCount, event.replyIndex + 1)
  }
}
```

- [ ] **Step 4: `src/diff.ts` implementieren**

```ts
import { hashText } from './state.ts'
import type { ChatEvent, State, Thread } from './types.ts'

/**
 * Ermittelt, was seit dem letzten Lauf neu ist. Threads werden über ihre
 * Position erkannt; ein geänderter Top-Post wird gemeldet, aber nicht neu
 * verarbeitet.
 */
export function diff(threads: Thread[], state: State): { events: ChatEvent[]; warnings: string[] } {
  const events: ChatEvent[] = []
  const warnings: string[] = []

  for (const thread of threads) {
    const known = state.threads[thread.index]
    if (known === undefined || known === null) {
      events.push({ kind: 'NewThread', thread })
      thread.replies.forEach((reply, replyIndex) =>
        events.push({ kind: 'NewReply', thread, reply, replyIndex }),
      )
      continue
    }

    if (known.topHash !== hashText(thread.top.text)) {
      warnings.push(`Thread ${thread.index}: Top-Post wurde geändert, Thread wird übersprungen.`)
      continue
    }

    for (let replyIndex = known.replyCount; replyIndex < thread.replies.length; replyIndex++) {
      events.push({ kind: 'NewReply', thread, reply: thread.replies[replyIndex]!, replyIndex })
    }
  }

  return { events, warnings }
}
```

- [ ] **Step 5: Tests ausführen, sie müssen bestehen**

Run: `npm test`
Expected: PASS, alle Tests aus Task 2 und 3

- [ ] **Step 6: Commit**

```bash
git add ai_bugfix_agent/src/state.ts ai_bugfix_agent/src/diff.ts ai_bugfix_agent/test/state.test.ts ai_bugfix_agent/test/diff.test.ts
git commit -m "Bugfix-Agent: Zustand und Diff"
```

---

### Task 4: Tickets

**Files:**
- Create: `ai_bugfix_agent/src/tickets.ts`
- Test: `ai_bugfix_agent/test/tickets.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendToTicket,
  createTicket,
  formatTimestamp,
  nextTicketNumber,
} from '../src/tickets.ts'
import type { Thread } from '../src/types.ts'

const NOW = new Date(2026, 10, 20, 15, 42, 5)
const thread: Thread = { index: 4, top: { level: 1, text: 'Die Suche funktioniert sehr langsam.' }, replies: [] }
const fields = {
  title: 'Suche reagiert sehr langsam',
  description: 'Nutzer meldet, dass die Suche sehr langsam ist.',
  component: 'Suche',
  severity: 'mittel' as const,
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bugagent-'))
}

test('formatTimestamp: lokale Zeit ohne Zeitzone', () => {
  assert.equal(formatTimestamp(NOW), '2026-11-20T15:42:05')
})

test('nextTicketNumber: fehlendes Verzeichnis ergibt 1', async () => {
  assert.equal(await nextTicketNumber(join(await tempDir(), 'tickets')), 1)
})

test('nextTicketNumber: höchste Nummer + 1, Lücken und fremde Dateien egal', async () => {
  const dir = await tempDir()
  for (const name of ['bug_2.txt', 'bug_7.txt', 'notiz.txt', 'bug_x.txt']) {
    await writeFile(join(dir, name), '')
  }
  assert.equal(await nextTicketNumber(dir), 8)
})

test('createTicket schreibt das Ticketformat', async () => {
  const dir = join(await tempDir(), 'tickets')
  const id = await createTicket(dir, thread, fields, NOW)
  assert.equal(id, 1)
  assert.equal(
    await readFile(join(dir, 'bug_1.txt'), 'utf8'),
    [
      'id: 1',
      'status: neu',
      'erstellt: 2026-11-20T15:42:05',
      'thread: 4',
      'titel: Suche reagiert sehr langsam',
      'komponente: Suche',
      'schweregrad: mittel',
      '',
      '## Beschreibung',
      'Nutzer meldet, dass die Suche sehr langsam ist.',
      '',
      '## Originalmeldung',
      '> Die Suche funktioniert sehr langsam.',
      '',
      '## Nachträge',
      '',
    ].join('\n'),
  )
})

test('createTicket: Zeilenumbrüche im Titel werden zu Leerzeichen', async () => {
  const dir = await tempDir()
  await createTicket(dir, thread, { ...fields, title: 'Zeile\neins' }, NOW)
  assert.match(await readFile(join(dir, 'bug_1.txt'), 'utf8'), /^titel: Zeile eins$/m)
})

test('appendToTicket hängt einen Nachtrag an', async () => {
  const dir = await tempDir()
  await createTicket(dir, thread, fields, NOW)
  const ok = await appendToTicket(dir, 1, { level: 2, text: 'Tritt ab 1000 Treffern auf.' }, NOW)
  assert.equal(ok, true)
  const content = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.ok(
    content.endsWith('## Nachträge\n\n### 2026-11-20T15:42:05 (Antwort, Ebene 2)\nTritt ab 1000 Treffern auf.\n'),
    content,
  )
})

test('appendToTicket: unbekanntes Ticket ergibt false', async () => {
  assert.equal(await appendToTicket(await tempDir(), 99, { level: 2, text: 'x' }, NOW), false)
})
```

- [ ] **Step 2: Test ausführen, er muss fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/tickets.ts'`

- [ ] **Step 3: Implementierung**

```ts
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatPost } from './parser.ts'
import { isNotFound } from './state.ts'
import type { Thread } from './types.ts'

export type Severity = 'niedrig' | 'mittel' | 'hoch'

/** Was das LLM zu einem Ticket beiträgt. Kopf und Originalmeldung schreibt der Code. */
export type TicketFields = {
  title: string
  description: string
  component: string
  severity: Severity
}

const TICKET_FILE = /^bug_(\d+)\.txt$/

export function ticketPath(dir: string, id: number): string {
  return join(dir, `bug_${id}.txt`)
}

/** ISO-Format in lokaler Zeit, ohne Zeitzone und Millisekunden. */
export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export async function nextTicketNumber(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isNotFound(error)) return 1
    throw error
  }
  const numbers = names.flatMap((name) => {
    const match = TICKET_FILE.exec(name)
    return match === null ? [] : [Number(match[1])]
  })
  return Math.max(0, ...numbers) + 1
}

/** Kopfwerte müssen einzeilig bleiben, sonst endet der Kopf zu früh. */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
}

export function formatTicket(id: number, thread: Thread, fields: TicketFields, created: Date): string {
  return [
    `id: ${id}`,
    'status: neu',
    `erstellt: ${formatTimestamp(created)}`,
    `thread: ${thread.index}`,
    `titel: ${oneLine(fields.title)}`,
    `komponente: ${oneLine(fields.component)}`,
    `schweregrad: ${fields.severity}`,
    '',
    '## Beschreibung',
    fields.description.trim(),
    '',
    '## Originalmeldung',
    formatPost(thread.top),
    '',
    '## Nachträge',
    '',
  ].join('\n')
}

/** Legt das nächste Ticket an und liefert seine Nummer. */
export async function createTicket(
  dir: string,
  thread: Thread,
  fields: TicketFields,
  now: Date,
): Promise<number> {
  await mkdir(dir, { recursive: true })
  const id = await nextTicketNumber(dir)
  // 'wx' schlägt fehl, falls die Datei inzwischen existiert, statt sie zu überschreiben.
  await writeFile(ticketPath(dir, id), formatTicket(id, thread, fields, now), { flag: 'wx' })
  return id
}

/** Hängt einen Nachtrag an. Liefert false, wenn das Ticket nicht existiert. */
export async function appendToTicket(
  dir: string,
  id: number,
  entry: { level: number; text: string },
  now: Date,
): Promise<boolean> {
  const section = `\n### ${formatTimestamp(now)} (Antwort, Ebene ${entry.level})\n${entry.text.trim()}\n`
  try {
    // 'r+' öffnet nur vorhandene Dateien; appendFile allein würde eine neue anlegen.
    await writeFile(ticketPath(dir, id), '', { flag: 'r+' })
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
  await appendFile(ticketPath(dir, id), section)
  return true
}
```

- [ ] **Step 4: Test ausführen, er muss bestehen**

Run: `npm test`
Expected: PASS, alle Tests bis einschließlich Task 4

- [ ] **Step 5: Commit**

```bash
git add ai_bugfix_agent/src/tickets.ts ai_bugfix_agent/test/tickets.test.ts
git commit -m "Bugfix-Agent: Tickets anlegen und ergänzen"
```

---

### Task 5: Tools

**Files:**
- Create: `ai_bugfix_agent/src/tools/types.ts`
- Create: `ai_bugfix_agent/src/tools/create_ticket.ts`
- Create: `ai_bugfix_agent/src/tools/append_to_ticket.ts`
- Create: `ai_bugfix_agent/src/tools/index.ts`
- Test: `ai_bugfix_agent/test/tools.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendToTicketTool } from '../src/tools/append_to_ticket.ts'
import { createTicketTool } from '../src/tools/create_ticket.ts'
import type { ToolContext } from '../src/tools/types.ts'
import type { ChatEvent, State, Thread } from '../src/types.ts'

const thread: Thread = {
  index: 0,
  top: { level: 1, text: 'Login geht nicht' },
  replies: [{ level: 2, text: 'Nur in Firefox' }],
}
const input = { title: 'Login schlägt fehl', description: 'Login geht nicht.', component: 'Login', severity: 'hoch' as const }

async function context(event: ChatEvent): Promise<{ ctx: ToolContext; persisted: () => number }> {
  let saves = 0
  const state: State = { threads: [] }
  const ctx: ToolContext = {
    event,
    state,
    ticketDir: join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets'),
    persist: async () => {
      saves++
    },
    now: () => new Date(2026, 10, 20, 10, 0, 0),
  }
  return { ctx, persisted: () => saves }
}

test('create_ticket legt Ticket an und speichert die Nummer sofort', async () => {
  const { ctx, persisted } = await context({ kind: 'NewThread', thread })
  assert.deepEqual(await createTicketTool.execute(input, ctx), { ticket: 1 })
  assert.equal(ctx.state.threads[0]?.ticket, 1)
  assert.equal(persisted(), 1)
  assert.match(await readFile(join(ctx.ticketDir, 'bug_1.txt'), 'utf8'), /^titel: Login schlägt fehl$/m)
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
```

- [ ] **Step 2: Test ausführen, er muss fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/tools/append_to_ticket.ts'`

- [ ] **Step 3: `src/tools/types.ts` anlegen**

```ts
import type { z } from 'zod'
import type { ChatEvent, State } from '../types.ts'

/** Was ein Tool vom Agenten bekommt. Das LLM sieht davon nichts. */
export type ToolContext = {
  event: ChatEvent
  state: State
  ticketDir: string
  /** Schreibt den Zustand sofort auf die Platte. */
  persist: () => Promise<void>
  now: () => Date
}

/**
 * Ein Tool unabhängig vom LLM-SDK. `llm.ts` übersetzt es in ein
 * OpenRouter-Tool; Tests rufen `execute` direkt auf.
 */
export type AgentTool = {
  name: string
  description: string
  inputSchema: z.ZodObject
  execute: (input: never, ctx: ToolContext) => Promise<unknown>
}

export function defineTool<S extends z.ZodObject>(tool: {
  name: string
  description: string
  inputSchema: S
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>
}): AgentTool & { execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> } {
  return tool
}
```

- [ ] **Step 4: `src/tools/create_ticket.ts` anlegen**

```ts
import { z } from 'zod'
import { ensureThread } from '../state.ts'
import { createTicket } from '../tickets.ts'
import { defineTool } from './types.ts'

export const createTicketTool = defineTool({
  name: 'create_ticket',
  description:
    'Legt ein Bug-Ticket für den Thread des aktuellen Ereignisses an. ' +
    'Nur aufrufen, wenn der Top-Post eine Bug-Meldung ist. Höchstens einmal pro Thread.',
  inputSchema: z.object({
    title: z.string().describe('Kurzer, sachlicher Titel, höchstens 80 Zeichen'),
    description: z.string().describe('Was laut Meldung passiert und welche Angaben fehlen'),
    component: z.string().describe('Betroffener Bereich, z. B. "Suche", sonst "unbekannt"'),
    severity: z.enum(['niedrig', 'mittel', 'hoch']),
  }),
  execute: async (input, ctx) => {
    const entry = ensureThread(ctx.state, ctx.event.thread)
    // Zurückgegeben statt geworfen: das LLM kann darauf reagieren, der Lauf geht weiter.
    if (entry.ticket !== null) {
      return { error: `Thread ${ctx.event.thread.index} hat bereits Ticket ${entry.ticket}.` }
    }
    const id = await createTicket(ctx.ticketDir, ctx.event.thread, input, ctx.now())
    entry.ticket = id
    // Sofort speichern, damit ein Abbruch danach kein zweites Ticket erzeugt.
    await ctx.persist()
    return { ticket: id }
  },
})
```

- [ ] **Step 5: `src/tools/append_to_ticket.ts` anlegen**

```ts
import { z } from 'zod'
import { appendToTicket } from '../tickets.ts'
import { defineTool } from './types.ts'

export const appendToTicketTool = defineTool({
  name: 'append_to_ticket',
  description:
    'Hängt einen Nachtrag an ein bestehendes Bug-Ticket an, z. B. eine Antwort ' +
    'mit Details, Bestätigung, Workaround oder Rückfrage.',
  inputSchema: z.object({
    ticket: z.number().int().describe('Ticketnummer'),
    text: z.string().describe('Antwort im Wortlaut oder als kurze Zusammenfassung'),
  }),
  execute: async (input, ctx) => {
    const level = ctx.event.kind === 'NewReply' ? ctx.event.reply.level : 1
    const ok = await appendToTicket(ctx.ticketDir, input.ticket, { level, text: input.text }, ctx.now())
    return ok ? { ok: true } : { error: `Ticket ${input.ticket} existiert nicht.` }
  },
})
```

- [ ] **Step 6: `src/tools/index.ts` anlegen**

```ts
import { appendToTicketTool } from './append_to_ticket.ts'
import { createTicketTool } from './create_ticket.ts'
import type { AgentTool } from './types.ts'

/** Alle Tools des Agenten. Ein neues Verhalten: Tool hier eintragen und in prompt.md beschreiben. */
export const TOOLS: AgentTool[] = [createTicketTool, appendToTicketTool]
```

- [ ] **Step 7: Test ausführen, er muss bestehen**

Run: `npm test`
Expected: PASS, alle Tests bis einschließlich Task 5

- [ ] **Step 8: Commit**

```bash
git add ai_bugfix_agent/src/tools ai_bugfix_agent/test/tools.test.ts
git commit -m "Bugfix-Agent: Tools create_ticket und append_to_ticket"
```

---

### Task 6: Agent und Prompt

**Files:**
- Create: `ai_bugfix_agent/src/prompt.md`
- Create: `ai_bugfix_agent/src/agent.ts`
- Test: `ai_bugfix_agent/test/agent.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
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
```

- [ ] **Step 2: Test ausführen, er muss fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/agent.ts'`

- [ ] **Step 3: `src/prompt.md` anlegen**

```markdown
Du überwachst einen Team-Chat und pflegst Bug-Tickets.

Pro Aufruf bekommst du genau ein Ereignis:
- `NewThread`: ein neuer Top-Post.
- `NewReply`: eine neue Antwort in einem Thread.

Dazu bekommst du den kompletten Thread und die Ticketnummer des Threads oder „kein Ticket“.

## Regeln

1. **NewThread:** Prüfe, ob der Top-Post einen Fehler in einer Software meldet: etwas funktioniert nicht, verhält sich falsch, ist auffällig langsam oder stürzt ab. Fragen, Wünsche, Lob und Smalltalk sind keine Bug-Meldungen. Nur bei einer Bug-Meldung rufst du `create_ticket` genau einmal auf.
   - `title`: kurz und sachlich, höchstens 80 Zeichen.
   - `description`: was laut Meldung passiert und welche Angaben fehlen (Schritte, Umgebung, Datenmenge). Erfinde nichts.
   - `component`: der betroffene Bereich, z. B. „Suche“. Wenn unklar: „unbekannt“.
   - `severity`: `hoch` bei Absturz, Datenverlust oder Totalausfall, `mittel` bei eingeschränkter Funktion, `niedrig` bei Kosmetik.
2. **NewReply in einem Thread mit Ticket:** Rufe `append_to_ticket` mit der Ticketnummer auf, wenn die Antwort etwas zum Bug beiträgt: Details, Bestätigung, Workaround, Rückfrage oder Status. Übernimm die Antwort im Wortlaut; ist sie länger als drei Sätze, fasse sie sachlich zusammen. Reine Reaktionen ohne Inhalt („oje“, „+1“, Emojis) hängst du nicht an.
3. **NewReply in einem Thread ohne Ticket:** Tu nichts.
4. Antworte zum Schluss mit einem kurzen Satz, was du getan hast.
```

- [ ] **Step 4: `src/agent.ts` implementieren**

```ts
import { readFileSync } from 'node:fs'
import type { z } from 'zod'
import { formatPost } from './parser.ts'
import { TOOLS } from './tools/index.ts'
import type { AgentTool, ToolContext } from './tools/types.ts'
import type { ChatEvent, State } from './types.ts'

/** Begrenzt den Tool-Loop, damit ein verwirrtes Modell keinen endlosen Lauf abrechnet. */
export const MAX_STEPS = 4

const PROMPT = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8')

/** Ein Tool mit bereits gebundenem Kontext, so wie das Modell es aufruft. */
export type BoundTool = {
  name: string
  description: string
  inputSchema: z.ZodObject
  execute: (input: unknown) => Promise<unknown>
}

/** Führt den Tool-Loop mit dem LLM aus. In Tests ein Fake, sonst `openRouterModel`. */
export type RunModel = (request: {
  instructions: string
  input: string
  tools: BoundTool[]
}) => Promise<void>

export type AgentDeps = {
  state: State
  ticketDir: string
  persist: () => Promise<void>
  runModel: RunModel
  log: (message: string) => void
  now: () => Date
  tools?: AgentTool[]
}

export function describeEvent(event: ChatEvent, ticket: number | null): string {
  const { thread } = event
  const affected = event.kind === 'NewReply' ? event.reply : thread.top
  return [
    `Ereignis: ${event.kind}`,
    `Thread-Index: ${thread.index}`,
    `Ticket: ${ticket ?? 'kein Ticket'}`,
    '',
    `Betroffener Post (Ebene ${affected.level}):`,
    formatPost(affected),
    '',
    'Kompletter Thread:',
    [thread.top, ...thread.replies].map(formatPost).join('\n'),
  ].join('\n')
}

export async function handleEvent(event: ChatEvent, deps: AgentDeps): Promise<void> {
  const ctx: ToolContext = {
    event,
    state: deps.state,
    ticketDir: deps.ticketDir,
    persist: deps.persist,
    now: deps.now,
  }

  let calls = 0
  const tools: BoundTool[] = (deps.tools ?? TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input: unknown) => {
      calls++
      return tool.execute(input as never, ctx)
    },
  }))

  const ticket = deps.state.threads[event.thread.index]?.ticket ?? null
  await deps.runModel({ instructions: PROMPT, input: describeEvent(event, ticket), tools })

  if (calls >= MAX_STEPS) {
    deps.log(`Warnung: Schrittlimit (${MAX_STEPS}) bei Thread ${event.thread.index} ausgeschöpft.`)
  }
}
```

- [ ] **Step 5: Test ausführen, er muss bestehen**

Run: `npm test`
Expected: PASS, alle Tests bis einschließlich Task 6

- [ ] **Step 6: Commit**

```bash
git add ai_bugfix_agent/src/prompt.md ai_bugfix_agent/src/agent.ts ai_bugfix_agent/test/agent.test.ts
git commit -m "Bugfix-Agent: Agent mit injiziertem Modell"
```

---

### Task 7: Einmallauf

**Files:**
- Create: `ai_bugfix_agent/src/run.ts`
- Test: `ai_bugfix_agent/test/run.test.ts`

- [ ] **Step 1: Failing Test schreiben**

Der Fake legt für jeden Top-Post mit „Bug“ ein Ticket an und hängt jede Antwort in einem Thread mit Ticket an. So prüft der Test den Ablauf über mehrere Läufe, ohne LLM.

```ts
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

test('geänderter Top-Post wird gemeldet', async () => {
  const { deps, dir, logs } = await setup('> Bug A\n')
  await runOnce(deps)
  await writeFile(join(dir, 'chat.txt'), '> Bug A, editiert\n')
  await runOnce(deps)
  assert.ok(logs.some((l) => l.includes('Top-Post wurde geändert')), logs.join('\n'))
})
```

- [ ] **Step 2: Test ausführen, er muss fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/run.ts'`

- [ ] **Step 3: Implementierung**

```ts
import { readFile } from 'node:fs/promises'
import { handleEvent, type RunModel } from './agent.ts'
import { diff } from './diff.ts'
import { parseChat } from './parser.ts'
import { applyEvent, isNotFound, loadState, saveState } from './state.ts'
import type { ChatEvent } from './types.ts'

export type RunDeps = {
  chatPath: string
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
  let text: string
  try {
    text = await readFile(deps.chatPath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return 'missing'
    throw error
  }

  const state = await loadState(deps.statePath)
  const persist = () => saveState(deps.statePath, state)
  const { events, warnings } = diff(parseChat(text), state)
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
    })
    applyEvent(state, event)
    await persist()
  }
  return 'ok'
}
```

- [ ] **Step 4: Test ausführen, er muss bestehen**

Run: `npm test`
Expected: PASS, alle Tests bis einschließlich Task 7

- [ ] **Step 5: Commit**

```bash
git add ai_bugfix_agent/src/run.ts ai_bugfix_agent/test/run.test.ts
git commit -m "Bugfix-Agent: Einmallauf mit Zustand"
```

---

### Task 8: Watch-Modus

**Files:**
- Create: `ai_bugfix_agent/src/watch.ts`
- Test: `ai_bugfix_agent/test/watch.test.ts`

- [ ] **Step 1: Failing Test schreiben**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSerialRunner } from '../src/watch.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('Auslöser während eines Laufs ergeben genau einen weiteren Lauf', async () => {
  let runs = 0
  const gate = deferred()
  const trigger = createSerialRunner(async () => {
    runs++
    if (runs === 1) await gate.promise
  }, () => {})

  const first = trigger()
  void trigger()
  void trigger()
  gate.resolve()
  await first
  assert.equal(runs, 2)
})

test('ein Fehler stoppt den Runner nicht', async () => {
  const errors: unknown[] = []
  let runs = 0
  const trigger = createSerialRunner(async () => {
    runs++
    if (runs === 1) throw new Error('kaputt')
  }, (error) => errors.push(error))

  await trigger()
  await trigger()
  assert.equal(runs, 2)
  assert.equal(errors.length, 1)
})
```

- [ ] **Step 2: Test ausführen, er muss fehlschlagen**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../src/watch.ts'`

- [ ] **Step 3: Implementierung**

```ts
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * Sorgt dafür, dass nie zwei Läufe parallel laufen. Wird während eines Laufs
 * ausgelöst, folgt genau ein weiterer Lauf, egal wie oft ausgelöst wurde.
 */
export function createSerialRunner(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let running = false
  let pending = false

  return async function trigger(): Promise<void> {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      do {
        pending = false
        try {
          await run()
        } catch (error) {
          onError(error)
        }
      } while (pending)
    } finally {
      running = false
    }
  }
}

/**
 * Beobachtet das Verzeichnis statt der Datei: so funktioniert es auch, wenn
 * die Datei noch fehlt oder ein Editor sie beim Speichern ersetzt.
 */
export function watchChat(chatPath: string, onChange: () => void, debounceMs: number): FSWatcher {
  const name = basename(chatPath)
  let timer: NodeJS.Timeout | undefined
  return watch(dirname(chatPath), (_type, filename) => {
    if (filename !== null && filename !== name) return
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  })
}
```

- [ ] **Step 4: Test ausführen, er muss bestehen**

Run: `npm test`
Expected: PASS, alle Tests bis einschließlich Task 8

- [ ] **Step 5: Commit**

```bash
git add ai_bugfix_agent/src/watch.ts ai_bugfix_agent/test/watch.test.ts
git commit -m "Bugfix-Agent: serieller Runner und Datei-Watcher"
```

---

### Task 9: OpenRouter-Anbindung und CLI

**Files:**
- Create: `ai_bugfix_agent/src/llm.ts`
- Create: `ai_bugfix_agent/src/main.ts`

`llm.ts` und `main.ts` haben keine Unit-Tests: `llm.ts` ist nur der Netzaufruf, `main.ts` nur Verdrahtung. Geprüft werden beide über `npm run typecheck` und den manuellen Durchlauf in Task 10.

- [ ] **Step 1: `src/llm.ts` anlegen**

```ts
import { OpenRouter, stepCountIs, tool } from '@openrouter/agent'
import { MAX_STEPS, type RunModel } from './agent.ts'

/** Der einzige Ort, der das Netz anfasst. */
export function openRouterModel(apiKey: string, model: string): RunModel {
  const client = new OpenRouter({ apiKey })
  return async ({ instructions, input, tools }) => {
    const result = client.callModel({
      model,
      instructions,
      input,
      tools: tools.map((t) =>
        tool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          execute: t.execute,
        }),
      ),
      stopWhen: stepCountIs(MAX_STEPS),
    })
    // Wartet, bis der Tool-Loop durch ist; der Schlusssatz des Modells wird nicht gebraucht.
    await result.getText()
  }
}
```

- [ ] **Step 2: `src/main.ts` anlegen**

```ts
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRouterModel } from './llm.ts'
import { runOnce, type RunDeps } from './run.ts'
import { createSerialRunner, watchChat } from './watch.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.env.OPENROUTER_MODEL ?? '~anthropic/claude-haiku-latest'
const DEBOUNCE_MS = 500

function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

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

  const deps: RunDeps = {
    chatPath: process.env.CHAT_FILE ?? join(ROOT, 'chat.txt'),
    statePath: join(ROOT, 'state.json'),
    ticketDir: join(ROOT, 'tickets'),
    runModel: openRouterModel(apiKey, MODEL),
    log,
  }

  if (!process.argv.includes('--watch')) {
    try {
      if ((await runOnce(deps)) === 'missing') {
        log(`${deps.chatPath} nicht gefunden.`)
        return 1
      }
      return 0
    } catch (error) {
      log(describeError(error))
      return 1
    }
  }

  const trigger = createSerialRunner(async () => {
    if ((await runOnce(deps)) === 'missing') log(`Warte auf ${deps.chatPath} …`)
  }, (error) => log(describeError(error)))

  // Der Watcher hält den Prozess am Leben, bis Strg+C.
  watchChat(deps.chatPath, () => void trigger(), DEBOUNCE_MS)
  log(`Beobachte ${deps.chatPath} mit ${MODEL} (Strg+C beendet).`)
  await trigger()
  return undefined
}

process.exitCode = await main()
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: keine Ausgabe, Exit-Code 0. Meldet `tsc` in `llm.ts` einen Typkonflikt bei `tool({...})` (die SDK-Generics erwarten ein konkretes Zod-Schema), `inputSchema` als `inputSchema: t.inputSchema as z.ZodObject<z.ZodRawShape>` übergeben und `import type { z } from 'zod'` ergänzen. Andere Fehler beheben, nicht unterdrücken.

- [ ] **Step 4: Alle Tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Ohne Key starten**

Run: `npm start`
Expected: `OPENROUTER_API_KEY fehlt. …` auf stderr, Exit-Code 2 (sofern keine `.env` existiert).

- [ ] **Step 6: Commit**

```bash
git add ai_bugfix_agent/src/llm.ts ai_bugfix_agent/src/main.ts
git commit -m "Bugfix-Agent: OpenRouter-Anbindung und CLI"
```

---

### Task 10: README, Beispiel-Chat, manueller Durchlauf

**Files:**
- Create: `ai_bugfix_agent/README.md`
- Modify: `ai_bugfix_agent/chat.txt`
- Modify: `README.md` (Repo-Root, Projektliste)

- [ ] **Step 1: `ai_bugfix_agent/README.md` anlegen**

````markdown
# ai_bugfix_agent

Überwacht `chat.txt`, erkennt Bug-Meldungen in Top-Threads und legt dafür Tickets `tickets/bug_N.txt` an. Antworten auf Threads mit Ticket werden dem Ticket als Nachtrag angehängt.

## Chat-Format

```
> Top-Post (startet einen Thread)
>> Antwort
>>> Antwort auf die Antwort
Zeilen ohne Präfix gehören zum vorigen Post.
```

## Start

```bash
npm install
cp .env.example .env   # OPENROUTER_API_KEY eintragen
npm start              # verarbeitet alles Neue und beendet sich
npm start -- --watch   # beobachtet chat.txt dauerhaft
npm test
```

Der Agent merkt sich in `state.json`, was er schon verarbeitet hat. Löschen von `state.json` und `tickets/` setzt ihn zurück.

## Erweitern

1. Neues Tool in `src/tools/` mit `defineTool` anlegen.
2. In `src/tools/index.ts` eintragen.
3. Das Verhalten in `src/prompt.md` beschreiben.

Spätere Arbeitsschritte (Analyse, Plan, Fix, MR) sind in der Spec unter „Spätere Arbeitsschritte“ beschrieben: `docs/specs/2026-11-20-chat-bug-agent-design.md`.
````

- [ ] **Step 2: Beispiel-Chat für den manuellen Durchlauf**

`ai_bugfix_agent/chat.txt` komplett ersetzen durch:

```
> Die Suche funktioniert sehr langsam.
>> oje
>> Bei mir dauert jede Suche mit mehr als 1000 Treffern über 10 Sekunden.
> Hat jemand Lust auf Mittagessen um 12?
>> klar
> Beim Speichern eines Profils mit Umlaut im Namen stürzt die App ab.
> Könnten wir einen Dark Mode bekommen?
```

- [ ] **Step 3: Root-`README.md` ergänzen**

In der Projektliste nach der Zeile `- ai_embed (vector db, frontend to search)` einfügen:

```
- ai_bugfix_agent (überwacht einen Chat in einer Datei und legt Bug-Tickets an)
```

- [ ] **Step 4: Manueller Durchlauf mit echtem Modell (braucht `OPENROUTER_API_KEY` in `.env`)**

Run: `npm start`
Expected:
- `tickets/bug_1.txt` für die Suche: Nachtrag mit den 1000 Treffern, kein Nachtrag für „oje“
- `tickets/bug_2.txt` für den Absturz beim Speichern
- kein Ticket für Mittagessen und Dark Mode
- erneutes `npm start` erzeugt nichts Neues

Danach `npm start -- --watch` starten, eine Zeile `>> Workaround: Filter auf Jahr setzen` unter den Suche-Thread schreiben und speichern. Expected: Nachtrag in `bug_1.txt` innerhalb weniger Sekunden.

- [ ] **Step 5: Commit**

```bash
git add ai_bugfix_agent/README.md ai_bugfix_agent/chat.txt README.md
git commit -m "Bugfix-Agent: README und Beispiel-Chat"
```
