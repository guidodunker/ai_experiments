# GitHub-Issues als Ticketsystem – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tickets entstehen wahlweise als Dateien in `tickets/` oder als GitHub-Issues; Chat-Agent und `npm run steps` arbeiten nur noch über eine Schnittstelle `TicketStore`.

**Architecture:** `TicketStore` kapselt Anlegen, Nachtrag, Liste, Lesen und Schritt-Ergebnis. `FileStore` fasst den vorhandenen Datei-Code zusammen. `GitHubStore` baut aus Issue, Labels, einem JSON-Block im Body und markierten Kommentaren dasselbe `Ticket` wie heute, sodass Analyse, Plan, Prompts und Policy unverändert bleiben. Der GitHub-Zugriff liegt hinter `GitHubApi`; die echte Umsetzung nutzt `fetch` mit Wiederholungen, Tests nutzen einen Fake im Speicher.

**Tech Stack:** TypeScript mit Node 22 `--experimental-strip-types`, `node:test`, GitHub-REST-API über `fetch`.

**Spec:** `docs/specs/2026-11-24-github-issues-design.md`

---

## Hinweise für alle Tasks

- Alle Pfade relativ zu `ai_bugfix_agent/`, alle Befehle in diesem Verzeichnis.
- Eine Testdatei: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/<name>.test.ts`
- Alle Tests: `npm test`. Typen: `npm run typecheck`.
- Relative Importe enden auf `.ts`, reine Typ-Importe mit `import type`, kein `enum`.
- Commit-Präfix `Bugfix-Agent:`.

## Dateien

| Datei | Änderung | Aufgabe |
|---|---|---|
| `src/store/types.ts` | neu | `TicketStore` |
| `src/store/file.ts` | neu | `fileStore`, `applyStepResult` (aus `steps/runner.ts` verschoben) |
| `src/store/github-format.ts` | neu | Body, Kommentare, Ticket; reine Funktionen |
| `src/store/github.ts` | neu | `GitHubApi`, `githubStore` |
| `src/store/github-client.ts` | neu | `githubClient` mit `fetch` |
| `src/store/config.ts` | neu | `chooseStore` |
| `src/tools/types.ts`, `src/tools/create_ticket.ts`, `src/tools/append_to_ticket.ts` | ändern | Store statt `ticketDir`, Texte mit `store.label` |
| `src/agent.ts`, `src/run.ts`, `src/main.ts` | ändern | Store statt `ticketDir` |
| `src/steps/runner.ts`, `src/steps-main.ts` | ändern | Store, getrennte Fehlermeldung beim Speichern |
| `src/steps/common.ts`, `src/steps/analyze.ts`, `src/steps/plan.ts` | ändern | Branch-Name aus den Deps, Worktree aus dem Branch |
| `test/helpers/fake-github.ts` | neu | Fake-`GitHubApi` |
| `.env.example`, `README.md` | ändern | Konfiguration, Doku |

---

### Task 1: `TicketStore` und `FileStore`

**Files:**
- Create: `src/store/types.ts`, `src/store/file.ts`
- Modify: `src/steps/runner.ts` (nur `applyResult` entfernen, siehe Step 3)
- Test: `test/file-store.test.ts`

- [ ] **Step 1: Test schreiben**

`test/file-store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStore } from '../src/store/file.ts'
import type { Thread } from '../src/types.ts'

const NOW = new Date(2026, 10, 24, 9, 0, 0)
const thread: Thread = { id: '0', index: 0, top: { level: 1, text: 'Suche langsam' }, replies: [] }
const fields = { title: 'Suche langsam', description: 'D', component: 'Suche', severity: 'mittel' as const }

async function store() {
  const dir = join(await mkdtemp(join(tmpdir(), 'bugagent-store-')), 'tickets')
  return { dir, store: fileStore(dir) }
}

test('Name, Bezeichnung und Branch', async () => {
  const { store: s } = await store()
  assert.equal(s.kind, 'datei')
  assert.equal(s.label(5), 'bug-5')
  assert.equal(s.branch(5), 'bugfix/bug-5')
})

test('create schreibt bug_N.txt und liefert die Nummer ohne URL', async () => {
  const { dir, store: s } = await store()
  assert.deepEqual(await s.create(thread, fields, 'datei', NOW), { id: 1 })
  assert.match(await readFile(join(dir, 'bug_1.txt'), 'utf8'), /^titel: Suche langsam$/m)
})

test('appendReply, list und read', async () => {
  const { store: s } = await store()
  await s.create(thread, fields, 'slack', NOW, 'https://x/p1')
  assert.equal(await s.appendReply(1, { level: 2, text: 'ab 1000 Treffern' }, NOW), true)
  assert.equal(await s.appendReply(9, { level: 2, text: 'x' }, NOW), false)
  assert.deepEqual(await s.list(), [1])
  const ticket = await s.read(1)
  assert.equal(ticket.header.get('link'), 'https://x/p1')
  assert.match(ticket.body, /\(Antwort, Ebene 2\)\nab 1000 Treffern\n$/)
})

test('applyResult setzt Status und Felder, hängt Abschnitt an, liefert das neue Ticket', async () => {
  const { dir, store: s } = await store()
  await s.create(thread, fields, 'datei', NOW)
  const updated = await s.applyResult(1, {
    status: 'analysiert',
    fields: { branch: 'bugfix/bug-1' },
    section: { heading: 'Analyse', text: 'Ursache X' },
    summary: '',
  })
  assert.equal(updated.header.get('status'), 'analysiert')
  assert.equal(updated.header.get('branch'), 'bugfix/bug-1')
  const text = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  assert.match(text, /^status: analysiert$/m)
  assert.match(text, /## Analyse\nUrsache X\n$/)
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/file-store.test.ts`
Expected: FAIL, `Cannot find module …/src/store/file.ts`.

- [ ] **Step 3: Implementieren**

`src/store/types.ts`:

```ts
import type { StepResult } from '../steps/types.ts'
import type { Ticket } from '../ticketfile.ts'
import type { TicketFields } from '../tickets.ts'
import type { SourceName, Thread } from '../types.ts'

export type StoreName = 'datei' | 'github'

/** Wo Tickets liegen. Chat-Agent und Runner kennen nur diese Schnittstelle. */
export type TicketStore = {
  kind: StoreName
  /** Für Slack-Antworten und Logs: 'bug-5' bzw. '#7' */
  label(id: number): string
  /** Branch im Ziel-Repo: 'bugfix/bug-5' bzw. 'bugfix/issue-7' */
  branch(id: number): string
  create(
    thread: Thread,
    fields: TicketFields,
    source: SourceName,
    now: Date,
    link?: string,
  ): Promise<{ id: number; url?: string }>
  /** false, wenn das Ticket nicht existiert */
  appendReply(id: number, entry: { level: number; text: string }, now: Date): Promise<boolean>
  /** Offene Tickets des Agenten, aufsteigend */
  list(): Promise<number[]>
  read(id: number): Promise<Ticket>
  /** Setzt Status und Felder, hängt den Abschnitt an, liefert das Ticket danach */
  applyResult(id: number, result: StepResult): Promise<Ticket>
}
```

`src/store/file.ts`:

```ts
import { branchName } from '../steps/common.ts'
import type { StepResult } from '../steps/types.ts'
import { readTicket, setSection, writeTicket, type Ticket } from '../ticketfile.ts'
import { appendToTicket, createTicket, listTicketIds } from '../tickets.ts'
import type { TicketStore } from './types.ts'

export function applyStepResult(ticket: Ticket, result: StepResult): Ticket {
  const header = new Map(ticket.header)
  header.set('status', result.status)
  for (const [key, value] of Object.entries(result.fields ?? {})) header.set(key, value)
  const body =
    result.section === undefined ? ticket.body : setSection(ticket.body, result.section.heading, result.section.text)
  return { id: ticket.id, header, body }
}

/** Tickets als `bug_N.txt` in einem Verzeichnis */
export function fileStore(dir: string): TicketStore {
  return {
    kind: 'datei',
    label: (id) => `bug-${id}`,
    branch: branchName,
    async create(thread, fields, source, now, link) {
      return { id: await createTicket(dir, thread, fields, now, source, link) }
    },
    appendReply: (id, entry, now) => appendToTicket(dir, id, entry, now),
    list: () => listTicketIds(dir),
    read: (id) => readTicket(dir, id),
    async applyResult(id, result) {
      // Neu lesen: Der Chat-Agent kann während des Schritts einen Nachtrag angehängt haben.
      const updated = applyStepResult(await readTicket(dir, id), result)
      await writeTicket(dir, updated)
      return updated
    },
  }
}
```

In `src/steps/runner.ts` die Funktion `applyResult` löschen und stattdessen importieren, damit der Runner bis Task 3 weiter funktioniert:

```ts
import { applyStepResult as applyResult } from '../store/file.ts'
```

Den Import `setSection` aus `../ticketfile.ts` dort entfernen.

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: TicketStore mit Dateien als erster Umsetzung"
```

---

### Task 2: Tools und Chat-Agent über den Store

**Files:**
- Modify: `src/tools/types.ts`, `src/tools/create_ticket.ts`, `src/tools/append_to_ticket.ts`, `src/agent.ts`, `src/run.ts`, `src/main.ts`
- Test: `test/tools.test.ts`, `test/agent.test.ts`, `test/run.test.ts`

- [ ] **Step 1: Tests umstellen und ergänzen**

`test/tools.test.ts`:
- Importe: `readFile` aus `node:fs/promises` entfernen; ergänzen:

```ts
import { fileStore } from '../src/store/file.ts'
import type { TicketStore } from '../src/store/types.ts'
import { formatTicketFile } from '../src/ticketfile.ts'
```

- In `context`: `ticketDir: join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets'),` → `store: fileStore(join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets')),`
- Nach `context` einfügen:

```ts
const ticketText = async (ctx: ToolContext): Promise<string> => formatTicketFile(await ctx.store.read(1))

/** Wie GitHub: Nummer 7, Bezeichnung #7, URL */
function githubLikeStore(): TicketStore & { replies: number[] } {
  const replies: number[] = []
  return {
    replies,
    kind: 'github',
    label: (id) => `#${id}`,
    branch: (id) => `bugfix/issue-${id}`,
    create: async () => ({ id: 7, url: 'https://github.com/o/r/issues/7' }),
    appendReply: async (id) => (replies.push(id), true),
    list: async () => [7],
    read: async () => {
      throw new Error('nicht gebraucht')
    },
    applyResult: async () => {
      throw new Error('nicht gebraucht')
    },
  }
}
```

- Jedes `await readFile(join(ctx.ticketDir, 'bug_1.txt'), 'utf8')` → `await ticketText(ctx)` (drei Stellen).
- Am Ende ergänzen:

```ts
test('GitHub: Antwort mit #N und URL, Nachtrag mit #N', async () => {
  const { ctx, replies } = await context({ kind: 'NewReply', thread, reply: thread.replies[0]!, replyIndex: 0 })
  const store = githubLikeStore()
  const github: ToolContext = { ...ctx, store }
  assert.deepEqual(await createTicketTool.execute(input, github), { ticket: 7 })
  assert.equal(github.state.threads['0']?.ticket, 7)
  await appendToTicketTool.execute({ ticket: 7, text: 'Nur in Firefox' }, github)
  assert.deepEqual(store.replies, [7])
  assert.deepEqual(replies, [
    'Ticket #7 angelegt: Login schlägt fehl (Login, hoch) https://github.com/o/r/issues/7',
    'Nachtrag an #7 angehängt.',
  ])
})
```

`test/agent.test.ts`:
- Importe: `readdir, readFile` aus `node:fs/promises` entfernen (nur `mkdtemp` bleibt); ergänzen `import { fileStore } from '../src/store/file.ts'` und `import { formatTicketFile } from '../src/ticketfile.ts'`.
- In `deps`: `ticketDir: join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets'),` → `store: fileStore(join(await mkdtemp(join(tmpdir(), 'bugagent-')), 'tickets')),`
- `await readFile(join(d.ticketDir, 'bug_1.txt'), 'utf8')` → `formatTicketFile(await d.store.read(1))` (zwei Stellen).
- `assert.deepEqual(await readdir(d.ticketDir), ['bug_1.txt'])` → `assert.deepEqual(await d.store.list(), [1])`

`test/run.test.ts`:
- Import ergänzen: `import { fileStore } from '../src/store/file.ts'`
- In `setup`: `ticketDir: join(dir, 'tickets'),` → `store: fileStore(join(dir, 'tickets')),`

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/tools.test.ts test/agent.test.ts test/run.test.ts`
Expected: FAIL, `ctx.store` bzw. `d.store` ist undefined.

- [ ] **Step 3: Implementieren**

`src/tools/types.ts`: Import ergänzen `import type { TicketStore } from '../store/types.ts'`; in `ToolContext` die Zeile `ticketDir: string` ersetzen durch `store: TicketStore`.

`src/tools/create_ticket.ts`, Import `import { createTicket, oneLine } from '../tickets.ts'` → `import { oneLine } from '../tickets.ts'`; in `execute` ab `const link = …`:

```ts
    const link = await ctx.link()
    const { id, url } = await ctx.store.create(ctx.event.thread, input, ctx.source, ctx.now(), link)
    entry.ticket = id
    // Das Ticket gilt für diesen Text; seine Antworten sind noch nicht angehängt.
    entry.topHash = hashText(ctx.event.thread.top.text)
    entry.replyCount = 0
    // Sofort speichern, damit ein Abbruch danach kein zweites Ticket erzeugt.
    await ctx.persist()
    const summary = `${oneLine(input.title)} (${oneLine(input.component)}, ${input.severity})`
    await ctx.reply(`Ticket ${ctx.store.label(id)} angelegt: ${summary}${url === undefined ? '' : ` ${url}`}`)
    return { ticket: id }
```

`src/tools/append_to_ticket.ts`: Import `appendToTicket` entfernen; `execute`:

```ts
  execute: async (input, ctx) => {
    const level = ctx.event.kind === 'NewReply' ? ctx.event.reply.level : 1
    const ok = await ctx.store.appendReply(input.ticket, { level, text: input.text }, ctx.now())
    if (!ok) return { error: `Ticket ${input.ticket} existiert nicht.` }
    await ctx.reply(`Nachtrag an ${ctx.store.label(input.ticket)} angehängt.`)
    return { ok: true }
  },
```

`src/agent.ts`: Import `import type { TicketStore } from './store/types.ts'`; in `AgentDeps` `ticketDir: string` → `store: TicketStore`; im `ctx` `ticketDir: deps.ticketDir,` → `store: deps.store,`.

`src/run.ts`: Import `import type { TicketStore } from './store/types.ts'`; in `RunDeps` `ticketDir: string` → `store: TicketStore`; im Aufruf von `handleEvent` `ticketDir: deps.ticketDir,` → `store: deps.store,`.

`src/main.ts`: Import `import { fileStore } from './store/file.ts'`; im `deps`-Objekt `ticketDir: join(ROOT, 'tickets'),` → `store: fileStore(join(ROOT, 'tickets')),` (wird in Task 7 durch `chooseStore` ersetzt).

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Chat-Agent legt Tickets über den Store an"
```

---

### Task 3: Runner über den Store, Branch-Name aus dem Store

**Files:**
- Modify: `src/steps/runner.ts`, `src/steps/common.ts`, `src/steps/analyze.ts`, `src/steps/plan.ts`, `src/steps-main.ts`
- Test: `test/runner.test.ts`, `test/common.test.ts`, `test/analyze.test.ts`

- [ ] **Step 1: Tests umstellen und ergänzen**

`test/runner.test.ts`:
- Import ergänzen: `import { fileStore } from '../src/store/file.ts'`
- In `setup`: `const deps: RunnerDeps = { ticketDir: dir, lockPath: …` → `const deps: RunnerDeps = { store: fileStore(dir), lockPath: …`
- Ergänzen:

```ts
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
  assert.deepEqual(env.logs, ['Ticket 1 analyze: Ergebnis nicht gespeichert: HTTP 502. Ergebnis war: analysiert (0.10 $): A'])
  assert.equal(await env.read(1), ticketText(1, 'neu'))
})
```

`test/common.test.ts`: Import um `worktreePath` ergänzen und anhängen:

```ts
test('worktreePath folgt dem Branch', () => {
  assert.equal(worktreePath(join('t'), 'bugfix/bug-7'), join('t', 'bugfix-bug-7'))
  assert.equal(worktreePath(join('t'), 'bugfix/issue-7'), join('t', 'bugfix-issue-7'))
})
```

Dazu `import { join } from 'node:path'`.

`test/analyze.test.ts`, am Ende anhängen:

```ts
test('Branch-Name aus den Deps', async () => {
  const env = await setup()
  const session = fakeSession(REPRODUCED, (cwd) => writeTest(cwd, RED_TEST))
  const analyzeStep = createAnalyzeStep({
    repo: env.repo,
    base: 'main',
    testCommand: TEST_CMD,
    worktreeRoot: env.worktreeRoot,
    runSession: session.run,
    branchName: (id) => `bugfix/issue-${id}`,
  })
  const result = await analyzeStep.run(ticket)
  assert.equal(result.fields?.branch, 'bugfix/issue-7')
  assert.equal(session.calls[0]?.cwd, join(env.worktreeRoot, 'bugfix-issue-7'))
  assert.equal(await branchExists(env.repo, 'bugfix/issue-7'), true)
})
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/runner.test.ts test/common.test.ts test/analyze.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

`src/steps/common.ts`, `worktreePath` ersetzen:

```ts
/** Fester Pfad je Branch, damit ein Folgelauf liegengebliebene Worktrees findet. */
export function worktreePath(root: string, branch: string): string {
  return join(root, branch.replaceAll('/', '-'))
}
```

`src/steps/analyze.ts`:
- `AnalyzeDeps` ergänzen:

```ts
  /** Default: bugfix/bug-N */
  branchName?: (id: number) => string
```

- In `run`:

```ts
      const branch = (deps.branchName ?? branchName)(ticket.id)
      const worktree = worktreePath(deps.worktreeRoot, branch)
```

`src/steps/plan.ts`:
- `PlanDeps` → `{ repo: string; worktreeRoot: string; runSession: RunSession; branchName?: (id: number) => string }`
- In `run`:

```ts
      const branch = ticket.header.get('branch') ?? (deps.branchName ?? branchName)(ticket.id)
      const worktree = worktreePath(deps.worktreeRoot, branch)
```

`src/steps/runner.ts` vollständig:

```ts
import { rm, writeFile } from 'node:fs/promises'
import type { TicketStore } from '../store/types.ts'
import type { Ticket } from '../ticketfile.ts'
import type { ChatReply } from '../types.ts'
import type { Step, StepResult } from './types.ts'

export type RunnerDeps = {
  store: TicketStore
  lockPath: string
  steps: Step[]
  log: (message: string) => void
  /** Nur dieses Ticket bearbeiten */
  only?: number
  /** Antwortet in Slack-Threads. Fehlt, wenn SLACK_BOT_TOKEN oder SLACK_CHANNEL_ID nicht gesetzt ist. */
  reply?: ChatReply
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyThere(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'EEXIST'
}

/** Wendet die Schritte an, bis für kein Ticket mehr einer passt. Liefert die Zahl gescheiterter Tickets. */
export async function runSteps(deps: RunnerDeps): Promise<number> {
  try {
    await writeFile(deps.lockPath, `${process.pid}\n`, { flag: 'wx' })
  } catch (error) {
    if (isAlreadyThere(error)) {
      throw new Error(`${deps.lockPath} existiert. Läuft schon ein Durchgang? Sonst die Datei löschen.`)
    }
    throw error
  }
  try {
    const ids = deps.only === undefined ? await deps.store.list() : [deps.only]
    let failed = 0
    for (const id of ids) {
      if (!(await advance(id, deps))) failed++
    }
    return failed
  } finally {
    await rm(deps.lockPath, { force: true })
  }
}

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

/** Bringt ein Ticket so weit wie möglich voran. false, wenn etwas gescheitert ist. */
async function advance(id: number, deps: RunnerDeps): Promise<boolean> {
  // Ein Schritt, der den Status nicht ändert, würde sonst endlos wiederholt.
  const seen = new Set<string>()
  for (;;) {
    let ticket: Ticket
    try {
      ticket = await deps.store.read(id)
    } catch (error) {
      deps.log(`Ticket ${id}: ${message(error)}`)
      return false
    }
    const status = ticket.header.get('status') ?? ''
    const step = deps.steps.find((s) => s.accepts === status)
    if (step === undefined || seen.has(status)) return true
    seen.add(status)

    let result: StepResult
    try {
      result = await step.run(ticket)
    } catch (error) {
      deps.log(`Ticket ${id} ${step.name} gescheitert: ${message(error)}`)
      return false
    }

    const change = `${result.status} ${result.summary}`.trimEnd()
    let updated: Ticket
    try {
      updated = await deps.store.applyResult(id, result)
    } catch (error) {
      // Die Sitzung ist bezahlt; das Ergebnis steht wenigstens im Log.
      deps.log(`Ticket ${id} ${step.name}: Ergebnis nicht gespeichert: ${message(error)}. Ergebnis war: ${change}`)
      return false
    }
    deps.log(`Ticket ${id} ${step.name} → ${change}`)
    await announce(updated, `${deps.store.label(id)}: ${change}`, deps)
  }
}
```

`src/steps-main.ts`:
- Import `import { fileStore } from './store/file.ts'`
- `const common = { repo, worktreeRoot: tmpdir(), runSession }` → 

```ts
  const store = fileStore(join(ROOT, 'tickets'))
  const common = { repo, worktreeRoot: tmpdir(), runSession, branchName: (id: number) => store.branch(id) }
```

- Im Aufruf von `runSteps`: `ticketDir: join(ROOT, 'tickets'),` → `store,`

(`fileStore` wird in Task 7 durch `chooseStore` ersetzt.)

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Runner und Branch-Name über den Store"
```

---

### Task 4: GitHub-Format (reine Funktionen)

**Files:**
- Create: `src/store/github-format.ts`
- Test: `test/github-format.test.ts`

- [ ] **Step 1: Test schreiben**

`test/github-format.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBody,
  renderBody,
  replaceKopf,
  replyComment,
  sectionComment,
  statusOf,
  toTicket,
  type CommentData,
  type IssueData,
} from '../src/store/github-format.ts'
import { formatTicketFile } from '../src/ticketfile.ts'
import { formatTimestamp } from '../src/tickets.ts'

const META = {
  erstellt: '2026-11-24T09:20:59',
  thread: '1795508455.866989',
  quelle: 'slack',
  link: 'https://x.slack.com/archives/C1/p1',
  komponente: 'Suche',
  schweregrad: 'mittel',
}
const BODY = renderBody(META, 'Müller wird nicht gefunden.', '> Die Suche findet Müller nicht.')

function issue(extra: Partial<IssueData> = {}): IssueData {
  return {
    number: 7,
    title: 'Suche findet Müller nicht',
    body: BODY,
    labels: ['bugfix-agent', 'status:neu', 'komponente:Suche'],
    url: 'https://github.com/o/r/issues/7',
    open: true,
    ...extra,
  }
}
const comment = (minute: number, body: string, login = 'bugfix-bot'): CommentData => ({
  body,
  createdAt: new Date(Date.UTC(2026, 10, 24, 9, minute, 0)).toISOString(),
  login,
})

test('renderBody: Tabelle mit Slack-Link, JSON-Block, Beschreibung, Originalmeldung', () => {
  assert.match(BODY, /^<!-- bugfix-agent:kopf -->\n\| Feld \| Wert \|\n\|---\|---\|\n\| Quelle \| \[Slack-Thread\]\(https:\/\/x\.slack\.com\/archives\/C1\/p1\) \|/)
  assert.match(BODY, /\| Komponente \| Suche \|/)
  assert.doesNotMatch(BODY, /\| Branch \|/)
  assert.match(BODY, /<!-- \/bugfix-agent:kopf -->\n\n## Beschreibung\nMüller wird nicht gefunden\.\n\n## Originalmeldung\n> Die Suche findet Müller nicht\.\n$/)
})

test('parseBody liefert JSON und Rest, auch mit Windows-Zeilenenden', () => {
  const { meta, rest } = parseBody(BODY.replaceAll('\n', '\r\n'), 7)
  assert.deepEqual(meta, META)
  assert.equal(rest, '## Beschreibung\nMüller wird nicht gefunden.\n\n## Originalmeldung\n> Die Suche findet Müller nicht.')
})

test('JSON-Block übersteht --> im Wert', () => {
  const body = renderBody({ ...META, test: 'a --> b' }, 'D', '> O')
  assert.equal(parseBody(body, 7).meta.test, 'a --> b')
})

test('parseBody wirft ohne Kopfblock oder mit kaputtem JSON', () => {
  assert.throws(() => parseBody('nur Text', 7), /Issue #7: Kopfblock fehlt/)
  const broken = BODY.replace(/<!-- bugfix-agent \{.*\} -->/, '<!-- bugfix-agent {kaputt} -->')
  assert.throws(() => parseBody(broken, 7), /Issue #7: Kopfdaten ungültig/)
})

test('replaceKopf ersetzt nur den Kopfblock', () => {
  const edited = `${BODY}\nVon Hand ergänzt.\n`
  const result = replaceKopf(edited, { ...META, branch: 'bugfix/issue-7', kosten_analyse: '0.53' }, 7)
  assert.match(result, /\| Branch \| bugfix\/issue-7 \|/)
  assert.match(result, /\| Kosten \| Analyse 0\.53 \$ \|/)
  assert.ok(result.endsWith('\nVon Hand ergänzt.\n'))
  assert.equal(parseBody(result, 7).meta.branch, 'bugfix/issue-7')
})

test('statusOf verlangt genau ein status:-Label', () => {
  assert.equal(statusOf(['bugfix-agent', 'status:analysiert'], 7), 'analysiert')
  assert.throws(() => statusOf(['bugfix-agent'], 7), /Issue #7: erwartet genau ein status:-Label, gefunden: keins/)
  assert.throws(() => statusOf(['status:neu', 'status:geplant'], 7), /gefunden: status:neu, status:geplant/)
})

test('toTicket: Kopf in fester Reihenfolge, Nachträge, Menschen-Kommentar, jüngster Abschnitt', () => {
  const comments = [
    comment(1, replyComment(2, 'Passiert nur bei Umlauten.')),
    comment(2, sectionComment('Analyse', 'alt')),
    comment(3, 'Bei mir auch mit Ö.', 'guidodunker'),
    comment(4, sectionComment('Analyse', '### Ursache\nneu')),
    comment(5, sectionComment('Plan', '### Zusammenfassung\nP')),
  ]
  const ticket = toTicket(
    issue({ labels: ['bugfix-agent', 'status:geplant'], body: replaceKopf(BODY, { ...META, branch: 'bugfix/issue-7' }, 7) }),
    comments,
  )
  assert.deepEqual([...ticket.header.keys()], [
    'id', 'status', 'erstellt', 'thread', 'quelle', 'link', 'titel', 'komponente', 'schweregrad', 'branch',
  ])
  assert.equal(ticket.header.get('status'), 'geplant')
  assert.equal(ticket.header.get('titel'), 'Suche findet Müller nicht')
  const when = (minute: number) => formatTimestamp(new Date(Date.UTC(2026, 10, 24, 9, minute, 0)))
  assert.equal(
    ticket.body,
    [
      '## Beschreibung',
      'Müller wird nicht gefunden.',
      '',
      '## Originalmeldung',
      '> Die Suche findet Müller nicht.',
      '',
      '## Nachträge',
      '',
      `### ${when(1)} (Antwort, Ebene 2)`,
      'Passiert nur bei Umlauten.',
      '',
      `### ${when(3)} (GitHub-Kommentar von @guidodunker)`,
      'Bei mir auch mit Ö.',
      '',
      '## Analyse',
      '### Ursache',
      'neu',
      '',
      '## Plan',
      '### Zusammenfassung',
      'P',
      '',
    ].join('\n'),
  )
  assert.ok(formatTicketFile(ticket).startsWith('id: 7\nstatus: geplant\n'))
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-format.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/store/github-format.ts`:

```ts
import type { Ticket } from '../ticketfile.ts'
import { formatTimestamp } from '../tickets.ts'

/** Alle Issues des Agenten tragen dieses Label. */
export const AGENT_LABEL = 'bugfix-agent'

export type IssueData = { number: number; title: string; body: string; labels: string[]; url: string; open: boolean }
export type CommentData = { body: string; createdAt: string; login: string }
/** Kopffelder außer id, status und titel */
export type Meta = Record<string, string>

const KOPF_START = '<!-- bugfix-agent:kopf -->'
const KOPF_END = '<!-- /bugfix-agent:kopf -->'
const META_LINE = /^<!-- bugfix-agent (\{.*\}) -->$/m
const REPLY_MARK = /^<!-- bugfix-agent:nachtrag ebene=(\d+) -->\n?/
const SECTION_MARK = /^<!-- bugfix-agent:abschnitt (\S+) -->\n?/
/** Kopffelder vor bzw. nach `titel`, in der Reihenfolge des Dateiformats */
const BEFORE_TITLE = ['erstellt', 'thread', 'quelle', 'link']
const AFTER_TITLE = ['komponente', 'schweregrad', 'branch', 'test', 'kosten_analyse', 'kosten_plan']

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function cell(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|')
}

/** Tabelle für Menschen und JSON für den Agenten, beide aus denselben Werten */
export function renderKopf(meta: Meta): string {
  const rows: [string, string | undefined][] = [
    ['Quelle', meta.quelle === 'slack' && meta.link !== undefined ? `[Slack-Thread](${meta.link})` : meta.quelle],
    ['Komponente', meta.komponente],
    ['Schweregrad', meta.schweregrad],
    ['Erstellt', meta.erstellt],
    ['Branch', meta.branch],
    ['Test', meta.test],
    [
      'Kosten',
      [meta.kosten_analyse && `Analyse ${meta.kosten_analyse} $`, meta.kosten_plan && `Plan ${meta.kosten_plan} $`]
        .filter(Boolean)
        .join(', ') || undefined,
    ],
  ]
  // `>` als >, damit ein Wert mit `-->` den HTML-Kommentar nicht beendet.
  const json = JSON.stringify(meta).replaceAll('>', '\\u003e')
  return [
    KOPF_START,
    '| Feld | Wert |',
    '|---|---|',
    ...rows.flatMap(([key, value]) => (value === undefined || value === '' ? [] : [`| ${key} | ${cell(value)} |`])),
    `<!-- bugfix-agent ${json} -->`,
    KOPF_END,
  ].join('\n')
}

export function renderBody(meta: Meta, description: string, original: string): string {
  return `${renderKopf(meta)}\n\n## Beschreibung\n${description.trim()}\n\n## Originalmeldung\n${original.trim()}\n`
}

function kopfBounds(body: string, number: number): { start: number; end: number } {
  const start = body.indexOf(KOPF_START)
  const end = body.indexOf(KOPF_END)
  if (start === -1 || end < start) throw new Error(`Issue #${number}: Kopfblock fehlt.`)
  return { start, end: end + KOPF_END.length }
}

export function parseBody(raw: string, number: number): { meta: Meta; rest: string } {
  const body = normalize(raw)
  const { start, end } = kopfBounds(body, number)
  const match = META_LINE.exec(body.slice(start, end))
  let meta: unknown
  try {
    meta = JSON.parse(match?.[1] ?? '')
  } catch {
    throw new Error(`Issue #${number}: Kopfdaten ungültig.`)
  }
  if (typeof meta !== 'object' || meta === null || Object.values(meta).some((v) => typeof v !== 'string')) {
    throw new Error(`Issue #${number}: Kopfdaten ungültig.`)
  }
  return { meta: meta as Meta, rest: (body.slice(0, start) + body.slice(end)).trim() }
}

/** Ersetzt nur den Kopfblock; was Menschen im übrigen Body ändern, bleibt. */
export function replaceKopf(raw: string, meta: Meta, number: number): string {
  const body = normalize(raw)
  const { start, end } = kopfBounds(body, number)
  return body.slice(0, start) + renderKopf(meta) + body.slice(end)
}

export function replyComment(level: number, text: string): string {
  return `<!-- bugfix-agent:nachtrag ebene=${level} -->\n${text.trim()}`
}

/** `heading` ist ein festes Wort aus dem Code (Analyse, Plan). */
export function sectionComment(heading: string, text: string): string {
  return `<!-- bugfix-agent:abschnitt ${heading} -->\n## ${heading}\n${text.trim()}`
}

export function statusOf(labels: string[], number: number): string {
  const found = labels.filter((label) => label.startsWith('status:'))
  if (found.length !== 1) {
    throw new Error(`Issue #${number}: erwartet genau ein status:-Label, gefunden: ${found.join(', ') || 'keins'}`)
  }
  return found[0]!.slice('status:'.length)
}

/** Baut aus Issue und Kommentaren das Ticket, wie es die Schritte aus einer Datei kennen. */
export function toTicket(issue: IssueData, comments: CommentData[]): Ticket {
  const { meta, rest } = parseBody(issue.body, issue.number)
  const header = new Map<string, string>([
    ['id', String(issue.number)],
    ['status', statusOf(issue.labels, issue.number)],
  ])
  const setFrom = (keys: string[]) => {
    for (const key of keys) {
      const value = meta[key]
      if (value !== undefined) header.set(key, value)
    }
  }
  setFrom(BEFORE_TITLE)
  header.set('titel', issue.title)
  setFrom(AFTER_TITLE)
  setFrom(Object.keys(meta).filter((key) => !BEFORE_TITLE.includes(key) && !AFTER_TITLE.includes(key)))

  const replies: string[] = []
  const sections = new Map<string, string>()
  const sorted = [...comments].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  for (const comment of sorted) {
    const body = normalize(comment.body)
    const when = formatTimestamp(new Date(comment.createdAt))
    const reply = REPLY_MARK.exec(body)
    if (reply !== null) {
      replies.push(`### ${when} (Antwort, Ebene ${reply[1]})\n${body.slice(reply[0].length).trim()}`)
      continue
    }
    const section = SECTION_MARK.exec(body)
    if (section !== null) {
      // Löschen und neu setzen: Der jüngste Abschnitt gilt und steht hinten.
      sections.delete(section[1]!)
      sections.set(section[1]!, body.slice(section[0].length).trim())
      continue
    }
    if (body.startsWith('<!-- bugfix-agent')) continue
    replies.push(`### ${when} (GitHub-Kommentar von @${comment.login})\n${body.trim()}`)
  }

  const parts = [rest, '', '## Nachträge']
  for (const reply of replies) parts.push('', reply)
  for (const section of sections.values()) parts.push('', section)
  return { id: issue.number, header, body: `${parts.join('\n')}\n` }
}
```

- [ ] **Step 4: Test laufen lassen, er besteht**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-format.test.ts; npm run typecheck`
Expected: PASS (7 Tests), `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src/store/github-format.ts test/github-format.test.ts
git commit -m "Bugfix-Agent: Ticket als Issue-Body und Kommentare"
```

---

### Task 5: `GitHubStore` gegen einen Fake

**Files:**
- Create: `src/store/github.ts`, `test/helpers/fake-github.ts`
- Test: `test/github-store.test.ts`

- [ ] **Step 1: Fake und Test schreiben**

`test/helpers/fake-github.ts`:

```ts
import type { CommentData, IssueData } from '../../src/store/github-format.ts'
import type { GitHubApi } from '../../src/store/github.ts'

/** GitHub im Speicher. Kommentare bekommen aufsteigende Zeitstempel. */
export function fakeGitHub() {
  const issues = new Map<number, IssueData>()
  const comments = new Map<number, CommentData[]>()
  const labels = new Set<string>()
  let next = 1
  let clock = 0
  const api: GitHubApi = {
    repo: 'o/r',
    getRepo: async () => {},
    ensureLabels: async (names) => {
      for (const name of names) labels.add(name)
    },
    createIssue: async ({ title, body, labels: issueLabels }) => {
      const number = next++
      const issue = { number, title, body, labels: [...issueLabels], url: `https://github.com/o/r/issues/${number}`, open: true }
      issues.set(number, issue)
      return { ...issue, labels: [...issue.labels] }
    },
    getIssue: async (number) => {
      const issue = issues.get(number)
      return issue === undefined ? undefined : { ...issue, labels: [...issue.labels] }
    },
    updateBody: async (number, body) => {
      issues.get(number)!.body = body
    },
    setLabels: async (number, issueLabels) => {
      issues.get(number)!.labels = [...issueLabels]
    },
    listComments: async (number) => [...(comments.get(number) ?? [])],
    addComment: async (number, body) => {
      const list = comments.get(number) ?? []
      list.push({ body, login: 'bugfix-bot', createdAt: new Date(Date.UTC(2026, 10, 24, 9, 0, clock++)).toISOString() })
      comments.set(number, list)
    },
    listOpenIssues: async (label) =>
      [...issues.values()].filter((i) => i.open && i.labels.includes(label)).map((i) => ({ ...i, labels: [...i.labels] })),
  }
  return { api, issues, comments, labels }
}
```

`test/github-store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubStore } from '../src/store/github.ts'
import { parseBody, sectionComment } from '../src/store/github-format.ts'
import type { Thread } from '../src/types.ts'
import { fakeGitHub } from './helpers/fake-github.ts'

const NOW = new Date(2026, 10, 24, 9, 20, 59)
const thread: Thread = { id: '1795508455.866989', index: 0, top: { level: 1, text: 'Die Suche findet Müller nicht.' }, replies: [] }
const fields = { title: 'Suche findet Müller nicht', description: 'Umlaute.', component: 'Suche', severity: 'mittel' as const }

async function created() {
  const gh = fakeGitHub()
  const store = githubStore(gh.api)
  const result = await store.create(thread, fields, 'slack', NOW, 'https://x.slack.com/p1')
  return { gh, store, result }
}

test('Name, Bezeichnung und Branch', () => {
  const store = githubStore(fakeGitHub().api)
  assert.equal(store.kind, 'github')
  assert.equal(store.label(7), '#7')
  assert.equal(store.branch(7), 'bugfix/issue-7')
})

test('create: Labels, Body mit Kopfdaten, Nummer und URL', async () => {
  const { gh, result } = await created()
  assert.deepEqual(result, { id: 1, url: 'https://github.com/o/r/issues/1' })
  const issue = gh.issues.get(1)!
  assert.equal(issue.title, 'Suche findet Müller nicht')
  assert.deepEqual(issue.labels, ['bugfix-agent', 'status:neu', 'komponente:Suche', 'schweregrad:mittel'])
  assert.deepEqual([...gh.labels].sort(), ['bugfix-agent', 'komponente:Suche', 'schweregrad:mittel', 'status:neu'])
  assert.deepEqual(parseBody(issue.body, 1).meta, {
    erstellt: '2026-11-24T09:20:59',
    thread: '1795508455.866989',
    quelle: 'slack',
    link: 'https://x.slack.com/p1',
    komponente: 'Suche',
    schweregrad: 'mittel',
  })
  assert.match(issue.body, /## Originalmeldung\n> Die Suche findet Müller nicht\.\n$/)
})

test('appendReply: Kommentar mit Markierung; unbekannt oder fremd ergibt false', async () => {
  const { gh, store } = await created()
  assert.equal(await store.appendReply(1, { level: 2, text: 'Nur bei Umlauten.' }, NOW), true)
  assert.equal(gh.comments.get(1)?.[0]?.body, '<!-- bugfix-agent:nachtrag ebene=2 -->\nNur bei Umlauten.')
  assert.equal(await store.appendReply(99, { level: 2, text: 'x' }, NOW), false)
  gh.issues.set(50, { number: 50, title: 'fremd', body: '', labels: [], url: '', open: true })
  assert.equal(await store.appendReply(50, { level: 2, text: 'x' }, NOW), false)
})

test('read liefert das Ticket mit Status, Kopf und Nachträgen', async () => {
  const { store } = await created()
  await store.appendReply(1, { level: 2, text: 'Nur bei Umlauten.' }, NOW)
  const ticket = await store.read(1)
  assert.equal(ticket.header.get('status'), 'neu')
  assert.equal(ticket.header.get('thread'), '1795508455.866989')
  assert.match(ticket.body, /## Nachträge\n\n### .* \(Antwort, Ebene 2\)\nNur bei Umlauten\.\n$/)
})

test('applyResult: Status-Label getauscht, Felder im Body, Abschnitt als Kommentar, Handänderung bleibt', async () => {
  const { gh, store } = await created()
  gh.issues.get(1)!.body += '\nVon Hand ergänzt.\n'
  const ticket = await store.applyResult(1, {
    status: 'analysiert',
    fields: { branch: 'bugfix/issue-1', kosten_analyse: '0.53' },
    section: { heading: 'Analyse', text: '### Ursache\nX' },
    summary: '(0.53 $): X',
  })
  const issue = gh.issues.get(1)!
  assert.deepEqual(issue.labels, ['bugfix-agent', 'komponente:Suche', 'schweregrad:mittel', 'status:analysiert'])
  assert.ok(gh.labels.has('status:analysiert'))
  assert.equal(parseBody(issue.body, 1).meta.branch, 'bugfix/issue-1')
  assert.ok(issue.body.endsWith('\nVon Hand ergänzt.\n'))
  assert.equal(gh.comments.get(1)?.at(-1)?.body, sectionComment('Analyse', '### Ursache\nX'))
  assert.equal(ticket.header.get('status'), 'analysiert')
  assert.equal(ticket.header.get('kosten_analyse'), '0.53')
  assert.match(ticket.body, /## Analyse\n### Ursache\nX\n$/)
})

test('applyResult ohne Abschnitt und ohne Felder ändert nur das Label', async () => {
  const { gh, store } = await created()
  const before = gh.issues.get(1)!.body
  await store.applyResult(1, { status: 'neu', summary: '' })
  assert.equal(gh.issues.get(1)!.body, before)
  assert.equal(gh.comments.get(1), undefined)
})

test('list: nur offene Issues des Agenten, aufsteigend', async () => {
  const { gh, store } = await created()
  await store.create(thread, fields, 'slack', NOW)
  await store.create(thread, fields, 'slack', NOW)
  gh.issues.get(2)!.open = false
  gh.issues.set(10, { number: 10, title: 'fremd', body: '', labels: ['bug'], url: '', open: true })
  assert.deepEqual(await store.list(), [1, 3])
})

test('read eines fremden Issues wirft', async () => {
  const { gh, store } = await created()
  gh.issues.set(50, { number: 50, title: 'fremd', body: '', labels: [], url: '', open: true })
  await assert.rejects(store.read(50), /Issue #50 gibt es nicht oder es gehört nicht zum Agenten/)
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-store.test.ts`
Expected: FAIL, `Cannot find module …/src/store/github.ts`.

- [ ] **Step 3: Implementieren**

`src/store/github.ts`:

```ts
import { formatPost } from '../parser.ts'
import { formatTimestamp, oneLine } from '../tickets.ts'
import {
  AGENT_LABEL,
  parseBody,
  renderBody,
  replaceKopf,
  replyComment,
  sectionComment,
  toTicket,
  type CommentData,
  type IssueData,
  type Meta,
} from './github-format.ts'
import type { TicketStore } from './types.ts'

/** Die REST-Aufrufe für ein Repo. Echt in `github-client.ts`, in Tests ein Fake. */
export type GitHubApi = {
  repo: string
  /** Wirft, wenn Token oder Repo nicht stimmen */
  getRepo(): Promise<void>
  /** Legt fehlende Labels an */
  ensureLabels(names: string[]): Promise<void>
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueData>
  /** undefined bei 404 */
  getIssue(number: number): Promise<IssueData | undefined>
  updateBody(number: number, body: string): Promise<void>
  /** Ersetzt alle Labels */
  setLabels(number: number, labels: string[]): Promise<void>
  /** Alle Seiten, älteste zuerst */
  listComments(number: number): Promise<CommentData[]>
  addComment(number: number, body: string): Promise<void>
  /** Offene Issues mit dem Label, alle Seiten, ohne Pull Requests */
  listOpenIssues(label: string): Promise<IssueData[]>
}

/** Labels haben höchstens 50 Zeichen. */
function labelFor(prefix: string, value: string): string {
  return `${prefix}:${value}`.slice(0, 50)
}

export function githubStore(api: GitHubApi): TicketStore {
  async function ownIssue(id: number): Promise<IssueData | undefined> {
    const issue = await api.getIssue(id)
    return issue !== undefined && issue.labels.includes(AGENT_LABEL) ? issue : undefined
  }

  async function mustGet(id: number): Promise<IssueData> {
    const issue = await ownIssue(id)
    if (issue === undefined) throw new Error(`Issue #${id} gibt es nicht oder es gehört nicht zum Agenten.`)
    return issue
  }

  async function read(id: number) {
    const issue = await mustGet(id)
    return toTicket(issue, await api.listComments(id))
  }

  return {
    kind: 'github',
    label: (id) => `#${id}`,
    branch: (id) => `bugfix/issue-${id}`,

    async create(thread, fields, source, now, link) {
      const meta: Meta = {
        erstellt: formatTimestamp(now),
        thread: thread.id,
        quelle: source,
        ...(link === undefined ? {} : { link: oneLine(link) }),
        komponente: oneLine(fields.component),
        schweregrad: fields.severity,
      }
      const labels = [
        AGENT_LABEL,
        'status:neu',
        labelFor('komponente', oneLine(fields.component)),
        labelFor('schweregrad', fields.severity),
      ]
      await api.ensureLabels(labels)
      const issue = await api.createIssue({
        title: oneLine(fields.title),
        body: renderBody(meta, fields.description, formatPost(thread.top)),
        labels,
      })
      return { id: issue.number, url: issue.url }
    },

    async appendReply(id, entry) {
      if ((await ownIssue(id)) === undefined) return false
      await api.addComment(id, replyComment(entry.level, entry.text))
      return true
    },

    async list() {
      return (await api.listOpenIssues(AGENT_LABEL)).map((issue) => issue.number).sort((a, b) => a - b)
    },

    read,

    async applyResult(id, result) {
      const issue = await mustGet(id)
      const status = `status:${result.status}`
      await api.ensureLabels([status])
      await api.setLabels(id, [...issue.labels.filter((label) => !label.startsWith('status:')), status])
      if (result.fields !== undefined && Object.keys(result.fields).length > 0) {
        const { meta } = parseBody(issue.body, id)
        await api.updateBody(id, replaceKopf(issue.body, { ...meta, ...result.fields }, id))
      }
      if (result.section !== undefined) {
        await api.addComment(id, sectionComment(result.section.heading, result.section.text))
      }
      return read(id)
    },
  }
}
```

- [ ] **Step 4: Test laufen lassen, er besteht**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-store.test.ts; npm run typecheck`
Expected: PASS (8 Tests), `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src/store/github.ts test/helpers/fake-github.ts test/github-store.test.ts
git commit -m "Bugfix-Agent: GitHubStore gegen die Schnittstelle GitHubApi"
```

---

### Task 6: GitHub-Client mit `fetch`

**Files:**
- Create: `src/store/github-client.ts`
- Test: `test/github-client.test.ts`

- [ ] **Step 1: Test schreiben**

`test/github-client.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubClient } from '../src/store/github-client.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = []
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const next = responses.shift()
    if (next === undefined) throw new Error('keine Antwort mehr vorbereitet')
    if (next instanceof Error) throw next
    return next
  }
  return { fetchFn, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const rawIssue = (number: number, extra: object = {}) => ({
  number,
  title: `T${number}`,
  body: 'B',
  labels: [{ name: 'bugfix-agent' }],
  html_url: `https://github.com/o/r/issues/${number}`,
  state: 'open',
  ...extra,
})

function client(responses: (Response | Error)[]) {
  const fake = fakeFetch(responses)
  const waits: number[] = []
  const api = githubClient('ghp_geheim', 'o/r', {
    fetch: fake.fetchFn,
    sleep: async (ms) => void waits.push(ms),
  })
  return { api, calls: fake.calls, waits }
}

test('Header mit Token und API-Version', async () => {
  const { api, calls } = client([json(200, { full_name: 'o/r' })])
  await api.getRepo()
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/o/r')
  assert.equal(calls[0]?.headers.Authorization, 'Bearer ghp_geheim')
  assert.equal(calls[0]?.headers['X-GitHub-Api-Version'], '2022-11-28')
})

test('503, dann Netzfehler, dann Erfolg: zwei Wiederholungen mit 1 s und 2 s', async () => {
  const { api, waits } = client([json(503, { message: 'down' }), new Error('ECONNRESET'), json(200, rawIssue(7))])
  const issue = await api.getIssue(7)
  assert.equal(issue?.number, 7)
  assert.deepEqual(waits, [1000, 2000])
})

test('Retry-After bestimmt die Wartezeit', async () => {
  const { api, waits } = client([json(429, { message: 'slow' }, { 'retry-after': '3' }), json(200, { full_name: 'o/r' })])
  await api.getRepo()
  assert.deepEqual(waits, [3000])
})

test('nach drei Wiederholungen Fehler mit letzter Ursache', async () => {
  const { api, calls } = client([503, 503, 503, 503].map((s) => json(s, { message: 'down' })))
  await assert.rejects(api.getRepo(), /GitHub GET \/repos\/o\/r: 503 down/)
  assert.equal(calls.length, 4)
})

test('401 sofort, ohne Token in der Meldung', async () => {
  const { api, calls } = client([json(401, { message: 'Bad credentials' })])
  await assert.rejects(api.getRepo(), (error: Error) => {
    assert.equal(error.message, 'GitHub GET /repos/o/r: 401 Bad credentials')
    assert.doesNotMatch(error.message, /ghp_geheim/)
    return true
  })
  assert.equal(calls.length, 1)
})

test('getIssue: 404 ergibt undefined, Labels als Namen', async () => {
  const { api } = client([json(404, { message: 'Not Found' }), json(200, rawIssue(7))])
  assert.equal(await api.getIssue(99), undefined)
  assert.deepEqual(await api.getIssue(7), {
    number: 7, title: 'T7', body: 'B', labels: ['bugfix-agent'], url: 'https://github.com/o/r/issues/7', open: true,
  })
})

test('listOpenIssues folgt dem Link-Header und lässt Pull Requests weg', async () => {
  const next = 'https://api.github.com/repositories/1/issues?labels=bugfix-agent&state=open&per_page=100&page=2'
  const { api, calls } = client([
    json(200, [rawIssue(1), rawIssue(2, { pull_request: {} })], { link: `<${next}>; rel="next", <${next}>; rel="last"` }),
    json(200, [rawIssue(3)]),
  ])
  const issues = await api.listOpenIssues('bugfix-agent')
  assert.deepEqual(issues.map((i) => i.number), [1, 3])
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/o/r/issues?labels=bugfix-agent&state=open&per_page=100')
  assert.equal(calls[1]?.url, next)
})

test('listComments: Text, Zeit, Login', async () => {
  const { api } = client([json(200, [{ body: 'x', created_at: '2026-11-24T09:00:00Z', user: { login: 'g' } }])])
  assert.deepEqual(await api.listComments(7), [{ body: 'x', createdAt: '2026-11-24T09:00:00Z', login: 'g' }])
})

test('ensureLabels legt nur fehlende an und merkt sich vorhandene', async () => {
  const { api, calls } = client([
    json(200, { name: 'bugfix-agent' }),
    json(404, { message: 'Not Found' }),
    json(201, { name: 'status:neu' }),
  ])
  await api.ensureLabels(['bugfix-agent', 'status:neu'])
  await api.ensureLabels(['bugfix-agent', 'status:neu'])
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET https://api.github.com/repos/o/r/labels/bugfix-agent',
    'GET https://api.github.com/repos/o/r/labels/status%3Aneu',
    'POST https://api.github.com/repos/o/r/labels',
  ])
  assert.deepEqual(JSON.parse(calls[2]?.body ?? '{}'), { name: 'status:neu', color: 'ededed' })
})

test('createIssue, updateBody, setLabels, addComment senden die erwarteten Anfragen', async () => {
  const { api, calls } = client([json(201, rawIssue(7)), json(200, {}), json(200, []), json(201, {})])
  assert.equal((await api.createIssue({ title: 'T', body: 'B', labels: ['bugfix-agent'] })).number, 7)
  await api.updateBody(7, 'neu')
  await api.setLabels(7, ['bugfix-agent', 'status:analysiert'])
  await api.addComment(7, 'K')
  assert.deepEqual(calls.map((c) => [c.method, c.url, JSON.parse(c.body ?? 'null')]), [
    ['POST', 'https://api.github.com/repos/o/r/issues', { title: 'T', body: 'B', labels: ['bugfix-agent'] }],
    ['PATCH', 'https://api.github.com/repos/o/r/issues/7', { body: 'neu' }],
    ['PUT', 'https://api.github.com/repos/o/r/issues/7/labels', { labels: ['bugfix-agent', 'status:analysiert'] }],
    ['POST', 'https://api.github.com/repos/o/r/issues/7/comments', { body: 'K' }],
  ])
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-client.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/store/github-client.ts`:

```ts
import type { CommentData, IssueData } from './github-format.ts'
import type { GitHubApi } from './github.ts'

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export type ClientOptions = {
  fetch?: Fetch
  sleep?: (ms: number) => Promise<void>
}

const BASE = 'https://api.github.com'
const BACKOFF_MS = [1000, 2000, 4000]

type RawIssue = {
  number: number
  title: string
  body: string | null
  labels: ({ name?: string } | string)[]
  html_url: string
  state: string
  pull_request?: unknown
}
type RawComment = { body?: string | null; created_at: string; user: { login: string } | null }

function toIssue(raw: RawIssue): IssueData {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    labels: raw.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    url: raw.html_url,
    open: raw.state === 'open',
  }
}

function nextLink(header: string | null): string | undefined {
  return header?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
}

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === 'string' ? body.message : ''
  } catch {
    return ''
  }
}

export function githubClient(token: string, repo: string, options: ClientOptions = {}): GitHubApi {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const knownLabels = new Set<string>()

  /**
   * Wiederholt bei Netzfehlern, 5xx, 429 und 403 mit Rate-Limit dreimal.
   * Statuscodes in `accept` gelten nicht als Fehler (z. B. 404 beim Lesen).
   */
  async function call(method: string, pathOrUrl: string, body?: unknown, accept: number[] = []): Promise<Response> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${BASE}${pathOrUrl}`
    const where = `GitHub ${method} ${url.replace(BASE, '')}`
    for (let attempt = 0; ; attempt++) {
      let failure: string
      let wait = BACKOFF_MS[attempt] ?? 4000
      try {
        const response = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (response.ok || accept.includes(response.status)) return response
        const retryAfter = response.headers.get('retry-after')
        const rateLimited =
          response.status === 429 ||
          (response.status === 403 && (retryAfter !== null || response.headers.get('x-ratelimit-remaining') === '0'))
        failure = `${response.status} ${await messageOf(response)}`.trimEnd()
        if (response.status < 500 && !rateLimited) throw new Error(`${where}: ${failure}`)
        if (retryAfter !== null && Number.isFinite(Number(retryAfter))) wait = Number(retryAfter) * 1000
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(where)) throw error
        failure = `Netzfehler: ${error instanceof Error ? error.message : String(error)}`
      }
      if (attempt >= BACKOFF_MS.length) throw new Error(`${where}: ${failure}`)
      await sleep(wait)
    }
  }

  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = path
    while (next !== undefined) {
      const response = await call('GET', next)
      items.push(...((await response.json()) as T[]))
      next = nextLink(response.headers.get('link'))
    }
    return items
  }

  const issuePath = (number: number) => `/repos/${repo}/issues/${number}`

  return {
    repo,
    async getRepo() {
      await call('GET', `/repos/${repo}`)
    },
    async ensureLabels(names) {
      for (const name of names) {
        if (knownLabels.has(name)) continue
        const found = await call('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`, undefined, [404])
        // 422: Ein paralleler Lauf hat das Label gerade angelegt.
        if (found.status === 404) await call('POST', `/repos/${repo}/labels`, { name, color: 'ededed' }, [422])
        knownLabels.add(name)
      }
    },
    async createIssue(input) {
      return toIssue((await (await call('POST', `/repos/${repo}/issues`, input)).json()) as RawIssue)
    },
    async getIssue(number) {
      const response = await call('GET', issuePath(number), undefined, [404])
      return response.status === 404 ? undefined : toIssue((await response.json()) as RawIssue)
    },
    async updateBody(number, body) {
      await call('PATCH', issuePath(number), { body })
    },
    async setLabels(number, labels) {
      await call('PUT', `${issuePath(number)}/labels`, { labels })
    },
    async listComments(number) {
      const raw = await all<RawComment>(`${issuePath(number)}/comments?per_page=100`)
      return raw.map((c): CommentData => ({ body: c.body ?? '', createdAt: c.created_at, login: c.user?.login ?? 'unbekannt' }))
    },
    async addComment(number, body) {
      await call('POST', `${issuePath(number)}/comments`, { body })
    },
    async listOpenIssues(label) {
      const raw = await all<RawIssue>(
        `/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`,
      )
      return raw.filter((issue) => issue.pull_request === undefined).map(toIssue)
    },
  }
}
```

- [ ] **Step 4: Test laufen lassen, er besteht**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-client.test.ts; npm run typecheck`
Expected: PASS (10 Tests), `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src/store/github-client.ts test/github-client.test.ts
git commit -m "Bugfix-Agent: GitHub-Client mit fetch und Wiederholungen"
```

---

### Task 7: Store aus der Konfiguration wählen

**Files:**
- Create: `src/store/config.ts`
- Modify: `src/main.ts`, `src/steps-main.ts`, `.env.example`, `README.md`
- Test: `test/store-config.test.ts`

- [ ] **Step 1: Test schreiben**

`test/store-config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chooseStore } from '../src/store/config.ts'
import { fakeGitHub } from './helpers/fake-github.ts'

const ROOT = join('projekt', 'agent')
const GITHUB = { TICKET_STORE: 'github', GITHUB_TOKEN: 'ghp_1', GITHUB_REPO: 'o/r' }

test('ohne TICKET_STORE: Dateien', async () => {
  const store = await chooseStore({}, ROOT)
  assert.ok(!('error' in store))
  assert.equal(store.kind, 'datei')
})

test('github mit allen Variablen und erreichbarem Repo', async () => {
  const made: string[] = []
  const store = await chooseStore(GITHUB, ROOT, (token, repo) => {
    made.push(`${token} ${repo}`)
    return fakeGitHub().api
  })
  assert.ok(!('error' in store))
  assert.equal(store.kind, 'github')
  assert.deepEqual(made, ['ghp_1 o/r'])
})

test('github ohne Variable nennt sie', async () => {
  assert.deepEqual(await chooseStore({ ...GITHUB, GITHUB_TOKEN: '' }, ROOT), {
    error: 'GITHUB_TOKEN fehlt. Trage es in .env ein (siehe .env.example).',
  })
})

test('GITHUB_REPO in falscher Form', async () => {
  assert.deepEqual(await chooseStore({ ...GITHUB, GITHUB_REPO: 'https://github.com/o/r' }, ROOT), {
    error: 'GITHUB_REPO=https://github.com/o/r hat nicht die Form owner/name.',
  })
})

test('Repo nicht erreichbar', async () => {
  const api = { ...fakeGitHub().api, getRepo: async () => Promise.reject(new Error('GitHub GET /repos/o/r: 401 Bad credentials')) }
  assert.deepEqual(await chooseStore(GITHUB, ROOT, () => api), {
    error: 'GitHub-Repo o/r nicht erreichbar: GitHub GET /repos/o/r: 401 Bad credentials',
  })
})

test('unbekannter Store', async () => {
  assert.deepEqual(await chooseStore({ TICKET_STORE: 'jira' }, ROOT), {
    error: 'TICKET_STORE=jira ist unbekannt. Erlaubt: datei, github.',
  })
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/store-config.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/store/config.ts`:

```ts
import { join } from 'node:path'
import { fileStore } from './file.ts'
import { githubClient } from './github-client.ts'
import { githubStore, type GitHubApi } from './github.ts'
import type { TicketStore } from './types.ts'

type Env = Record<string, string | undefined>

const GITHUB_SETTINGS = ['GITHUB_TOKEN', 'GITHUB_REPO'] as const

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Wählt die Ablage nach `TICKET_STORE`. Bei GitHub prüft ein Aufruf sofort Token und Repo. */
export async function chooseStore(
  env: Env,
  root: string,
  makeApi: (token: string, repo: string) => GitHubApi = githubClient,
): Promise<TicketStore | { error: string }> {
  const name = setting(env, 'TICKET_STORE') ?? 'datei'
  if (name === 'datei') return fileStore(join(root, 'tickets'))
  if (name !== 'github') return { error: `TICKET_STORE=${name} ist unbekannt. Erlaubt: datei, github.` }

  const missing = GITHUB_SETTINGS.find((key) => setting(env, key) === undefined)
  if (missing !== undefined) return { error: `${missing} fehlt. Trage es in .env ein (siehe .env.example).` }
  const repo = setting(env, 'GITHUB_REPO')!
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `GITHUB_REPO=${repo} hat nicht die Form owner/name.` }

  const api = makeApi(setting(env, 'GITHUB_TOKEN')!, repo)
  try {
    await api.getRepo()
  } catch (error) {
    return { error: `GitHub-Repo ${repo} nicht erreichbar: ${error instanceof Error ? error.message : String(error)}` }
  }
  return githubStore(api)
}
```

`src/main.ts`:
- Import `import { fileStore } from './store/file.ts'` → `import { chooseStore } from './store/config.ts'`
- Nach dem Block `if ('error' in chat) { … }` einfügen:

```ts
  const store = await chooseStore(process.env, ROOT)
  if ('error' in store) {
    log(store.error)
    return 2
  }
```

- Im `deps`-Objekt `store: fileStore(join(ROOT, 'tickets')),` → `store,`
- Log-Zeile beim Beobachten: `` log(`Beobachte ${chat.source.label} mit ${MODEL}, Tickets: ${store.kind} (Strg+C beendet).`) ``

`src/steps-main.ts`:
- Import `import { fileStore } from './store/file.ts'` → `import { chooseStore } from './store/config.ts'`
- `const store = fileStore(join(ROOT, 'tickets'))` ersetzen durch:

```ts
  const store = await chooseStore(process.env, ROOT)
  if ('error' in store) {
    log(store.error)
    return 2
  }
```

- Log-Zeile: `` log(`Schritte für ${repo} mit ${model}, Tickets: ${store.kind}${only === undefined ? '' : `, nur Ticket ${only}`}.`) ``

`.env.example`, nach dem Slack-Block anhängen:

```
# --- Tickets ---
# Optional, Default: datei (tickets/bug_N.txt). Mit github werden Tickets Issues in GITHUB_REPO.
# TICKET_STORE=
# Fine-grained Token nur für GITHUB_REPO, Berechtigung "Issues: Read and write"
# GITHUB_TOKEN=
# owner/name, z. B. guidodunker/ai_experiments
# GITHUB_REPO=
```

`README.md`, vor `## Erweitern` einfügen:

````markdown
## Tickets als GitHub-Issues

Mit `TICKET_STORE=github` legt der Agent Tickets als Issues in `GITHUB_REPO` an statt als Dateien in `tickets/`. `npm run steps` liest dann die Issues und schreibt zurück:

- Status als Label `status:<wert>`, dazu `bugfix-agent`, `komponente:<…>`, `schweregrad:<…>`
- Kopffelder als Tabelle im Body; der Agent pflegt nur den Bereich zwischen `<!-- bugfix-agent:kopf -->` und `<!-- /bugfix-agent:kopf -->`
- Nachträge, Analyse und Plan als Kommentare. Kommentare von Menschen im Issue zählen ebenfalls als Nachtrag.
- Branch im Ziel-Repo: `bugfix/issue-N`

Den Status setzt ein Mensch zurück, indem er das Label wechselt, z. B. `status:nicht_reproduziert` → `status:neu`. Geschlossene Issues bearbeitet der Runner nicht.

Token: auf GitHub unter Settings → Developer settings → Fine-grained tokens, „Only select repositories“ mit nur diesem Repo, Berechtigung „Issues: Read and write“.

**Achtung:** In einem öffentlichen Repo sind alle Meldungen, Nachträge, Analysen und Pläne öffentlich, und jeder kann Kommentare schreiben, die in die Analyse einfließen. Nur mit Testdaten verwenden.
````

Letzte Zeile des README: `` Specs: `docs/specs/2026-11-23-analyse-plan-design.md`, `docs/specs/2026-11-24-slack-quelle-design.md`, `docs/specs/2026-11-24-github-issues-design.md`. Fix, Push und MR folgen in Stufe 3. ``

- [ ] **Step 4: Tests, Typen und Startfehler prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

Run: `$env:TICKET_STORE='jira'; npm start; Remove-Item Env:TICKET_STORE`
Expected: `TICKET_STORE=jira ist unbekannt. Erlaubt: datei, github.`, Exit-Code 2.

- [ ] **Step 5: Commit**

```powershell
git add src test .env.example README.md
git commit -m "Bugfix-Agent: Ticketablage über TICKET_STORE wählen"
```

---

### Task 8: Live-Test mit dem Nutzer

Voraussetzung: In `.env` stehen `GITHUB_TOKEN` und `GITHUB_REPO=guidodunker/ai_experiments`. Der Nutzer gibt Start und Posts frei.

- [ ] **Step 1: Lesende Prüfung**

```powershell
$code = "import { githubClient } from './src/store/github-client.ts'; const api = githubClient(process.env.GITHUB_TOKEN, process.env.GITHUB_REPO); await api.getRepo(); console.log('Repo erreichbar'); console.log('offene Agent-Issues:', (await api.listOpenIssues('bugfix-agent')).length)"
node --env-file=.env --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e $code
```

Expected: `Repo erreichbar`, `offene Agent-Issues: 0`.

- [ ] **Step 2: Chat-Agent mit GitHub**

`$env:CHAT_SOURCE='slack'; $env:TICKET_STORE='github'; npm run watch` (im Hintergrund). Der Nutzer postet in `#bugs` eine neue Bug-Meldung und eine Antwort darauf.

Expected: Issue #N mit Labels `bugfix-agent`, `status:neu`, `komponente:…`, `schweregrad:…`; Tabelle mit Slack-Link; Kommentar mit dem Nachtrag; in Slack `Ticket #N angelegt: … https://github.com/guidodunker/ai_experiments/issues/N` und `Nachtrag an #N angehängt.`

- [ ] **Step 3: Kommentar von Hand**

Der Nutzer schreibt im Issue einen Kommentar.

- [ ] **Step 4: Schritte**

`$env:TICKET_STORE='github'; $env:TICKET='<N>'; npm run steps; Remove-Item Env:TICKET, Env:TICKET_STORE`

Expected: Label `status:geplant`; Kommentare `## Analyse` und `## Plan`; Tabelle mit Branch `bugfix/issue-N`, Test und Kosten; Branch im Demo-Repo; in Slack `#N: analysiert …` und `#N: geplant …`.

- [ ] **Step 5: Kommentar in der Ticket-Ansicht**

```powershell
$code = "import { chooseStore } from './src/store/config.ts'; import { formatTicketFile } from './src/ticketfile.ts'; const s = await chooseStore({ ...process.env, TICKET_STORE: 'github' }, '.'); console.log(formatTicketFile(await s.read(<N>)))"
node --env-file=.env --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e $code
```

Expected: Unter `## Nachträge` steht der Kommentar aus Step 3 als `(GitHub-Kommentar von @guidodunker)`.

- [ ] **Step 6: Ergebnis im Gedächtnis festhalten**, Agent stoppen.
