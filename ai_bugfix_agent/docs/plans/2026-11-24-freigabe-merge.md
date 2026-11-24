# Freigabe im Chat und Merge – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** „approved“ im Slack-Thread setzt ein Ticket mit `pr_offen` auf `freigegeben`; ein neuer Schritt `merge` merged den PR per Squash, löscht den Branch, schließt das Issue und setzt `erledigt`.

**Architecture:** Die Erkennung ist eine reine Funktion; `runOnce` leitet erkannte Freigaben an `handleApproval` statt ans LLM. Der Absender kommt als `Post.author` aus Slack. `merge` ist ein `Step` wie `fix` und spricht GitHub über eine Teilmenge von `GitHubApi` an; das Issue schließt `TicketStore.close`.

**Tech Stack:** TypeScript mit Node 22 `--experimental-strip-types`, `node:test`, GitHub-REST-API.

**Spec:** `docs/specs/2026-11-24-freigabe-merge-design.md`

---

## Hinweise für alle Tasks

- Pfade relativ zu `ai_bugfix_agent/`, Befehle in diesem Verzeichnis.
- Eine Testdatei: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/<name>.test.ts`
- Alle Tests: `npm test`. Typen: `npm run typecheck`.
- Commit-Präfix `Bugfix-Agent:`.

## Dateien

| Datei | Änderung | Aufgabe |
|---|---|---|
| `src/types.ts` | ändern | `Post.author` |
| `src/sources/slack-threads.ts` | ändern | `author` aus `user` |
| `src/approval.ts` | neu | `isApproval`, `handleApproval` |
| `src/run.ts` | ändern | Freigabe vor dem LLM abzweigen |
| `src/store/types.ts`, `src/store/file.ts`, `src/store/github.ts` | ändern | `close` |
| `src/store/github-client.ts`, `test/helpers/fake-github.ts` | ändern | `getPull`, `mergePull`, `deleteBranch`, `closeIssue` |
| `src/steps/merge.ts` | neu | Schritt `merge` |
| `src/steps-main.ts` | ändern | Schritt registrieren, Hinweis auf `git pull` |
| `README.md` | ändern | Doku |

---

### Task 1: Absender und Erkennung der Freigabe

**Files:**
- Modify: `src/types.ts`, `src/sources/slack-threads.ts`
- Create: `src/approval.ts`
- Test: `test/approval.test.ts`, `test/slack-threads.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/approval.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isApproval } from '../src/approval.ts'

test('Freigaben', () => {
  for (const text of ['approved', 'Approved!', ' APPROVED. ', 'freigegeben', 'Freigegeben!']) {
    assert.equal(isApproval(text), true, text)
  }
})

test('keine Freigaben', () => {
  for (const text of ['approved? noch nicht', 'ok', 'approved bitte', '👍', 'nicht approved', 'approved!!', '']) {
    assert.equal(isApproval(text), false, text)
  }
})
```

`test/slack-threads.test.ts`: im ersten Test („Top-Posts nach ts sortiert …“) die erwarteten Posts um `author: 'U1'` ergänzen:

```ts
  assert.deepEqual(toThreads(history, replies, ME), [
    {
      id: '1764000001.000000',
      index: 0,
      top: { level: 1, text: 'A', author: 'U1' },
      replies: [
        { level: 2, text: 'a1', author: 'U1' },
        { level: 2, text: 'a2', author: 'U1' },
      ],
    },
    { id: '1764000002.000000', index: 1, top: { level: 1, text: 'B', author: 'U1' }, replies: [] },
  ])
```

Die übrigen Tests, die `replies` mit `deepEqual` prüfen, ebenfalls um `author: 'U1'` ergänzen:
- „eigene Nachrichten fallen weg …“: `[{ level: 2, text: 'Danke', author: 'U1' }]`
- „thread_broadcast zählt nur als Antwort …“: `[{ level: 2, text: 'auch im Channel', author: 'U1' }]`

Und anhängen:

```ts
test('Nachricht ohne user hat keinen author', () => {
  const threads = toThreads([{ ts: '1.000001', text: 'Bug' }], new Map(), ME)
  assert.equal('author' in threads[0]!.top, false)
})
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/approval.test.ts test/slack-threads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

`src/types.ts`:

```ts
/**
 * Ein Beitrag im Chat. Ebene 1 ist ein Top-Post, 2 eine Antwort darauf usw.
 * `author` ist die Slack-User-ID, bei `chat.txt` fehlt er.
 */
export type Post = { level: number; text: string; author?: string }
```

`src/sources/slack-threads.ts`, eine Hilfsfunktion vor `toThreads` und beide `map`-Aufrufe für Posts anpassen:

```ts
function post(level: number, message: SlackMessage) {
  return { level, text: message.text ?? '', ...(message.user === undefined ? {} : { author: message.user }) }
}
```

In `toThreads`: `top: { level: 1, text: top.text ?? '' },` → `top: post(1, top),` und `.map((m) => ({ level: 2, text: m.text ?? '' })),` → `.map((m) => post(2, m)),`

`src/approval.ts`:

```ts
const APPROVAL = /^(approved|freigegeben)[!.]?$/i

/** Nur genau dieses Wort, damit „approved? noch nicht“ keinen Merge auslöst. */
export function isApproval(text: string): boolean {
  return APPROVAL.test(text.trim())
}
```

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Absender aus Slack, Erkennung der Freigabe"
```

---

### Task 2: Issue schließen, PR lesen und mergen über die API

**Files:**
- Modify: `src/store/types.ts`, `src/store/file.ts`, `src/store/github.ts`, `src/store/github-client.ts`, `test/helpers/fake-github.ts`
- Test: `test/github-client.test.ts`, `test/github-store.test.ts`, `test/file-store.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/github-client.test.ts`, anhängen:

```ts
test('getPull, mergePull, deleteBranch, closeIssue', async () => {
  const { api, calls } = client([
    json(200, { state: 'open', merged: false, merge_commit_sha: null }),
    json(200, { sha: 'abc', merged: true, message: 'Pull Request successfully merged' }),
    json(405, { message: 'Pull Request is not mergeable' }),
    new Response(null, { status: 204 }),
    json(200, {}),
  ])
  assert.deepEqual(await api.getPull(3), { state: 'open', merged: false, mergeCommit: undefined })
  assert.deepEqual(await api.mergePull(3, 'Fix #7: T (#3)'), { merged: true, sha: 'abc' })
  assert.deepEqual(await api.mergePull(3, 'Fix #7: T (#3)'), { merged: false, message: 'Pull Request is not mergeable' })
  await api.deleteBranch('bugfix/issue-7')
  await api.closeIssue(7)
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, JSON.parse(c.body ?? 'null')]),
    [
      ['GET', 'https://api.github.com/repos/o/r/pulls/3', null],
      ['PUT', 'https://api.github.com/repos/o/r/pulls/3/merge', { merge_method: 'squash', commit_title: 'Fix #7: T (#3)' }],
      ['PUT', 'https://api.github.com/repos/o/r/pulls/3/merge', { merge_method: 'squash', commit_title: 'Fix #7: T (#3)' }],
      ['DELETE', 'https://api.github.com/repos/o/r/git/refs/heads/bugfix/issue-7', null],
      ['PATCH', 'https://api.github.com/repos/o/r/issues/7', { state: 'closed', state_reason: 'completed' }],
    ],
  )
})
```

`test/github-store.test.ts`, anhängen:

```ts
test('close schließt das Issue', async () => {
  const { gh, store } = await created()
  await store.close(1)
  assert.equal(gh.issues.get(1)!.open, false)
  assert.deepEqual(await store.list(), [])
})
```

`test/file-store.test.ts`, anhängen:

```ts
test('close ändert bei Dateien nichts', async () => {
  const { dir, store: s } = await store()
  await s.create(thread, fields, 'datei', NOW)
  const before = await readFile(join(dir, 'bug_1.txt'), 'utf8')
  await s.close(1)
  assert.equal(await readFile(join(dir, 'bug_1.txt'), 'utf8'), before)
})
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/github-client.test.ts test/github-store.test.ts test/file-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

`src/store/types.ts`, in `TicketStore` ergänzen:

```ts
  /** Schließt das Ticket nach dem Merge. Bei Dateien genügt der Status, dort passiert nichts. */
  close(id: number): Promise<void>
```

`src/store/file.ts`, im zurückgegebenen Objekt: `close: async () => {},`

`src/store/github.ts`, in `GitHubApi` ergänzen:

```ts
  getPull(number: number): Promise<{ state: 'open' | 'closed'; merged: boolean; mergeCommit?: string }>
  /** Squash-Merge. merged: false bei HTTP 405 oder 409, mit der Meldung von GitHub. */
  mergePull(number: number, commitTitle: string): Promise<{ merged: true; sha: string } | { merged: false; message: string }>
  deleteBranch(branch: string): Promise<void>
  closeIssue(number: number): Promise<void>
```

und im Store: `close: (id) => api.closeIssue(id),`

`src/store/github-client.ts`, im zurückgegebenen Objekt ergänzen:

```ts
    async getPull(number) {
      const pull = (await (await call('GET', `/repos/${repo}/pulls/${number}`)).json()) as {
        state: string
        merged: boolean
        merge_commit_sha: string | null
      }
      return {
        state: pull.state === 'open' ? 'open' : 'closed',
        merged: pull.merged,
        mergeCommit: pull.merge_commit_sha ?? undefined,
      }
    },
    async mergePull(number, commitTitle) {
      const response = await call(
        'PUT',
        `/repos/${repo}/pulls/${number}/merge`,
        { merge_method: 'squash', commit_title: commitTitle },
        [405, 409],
      )
      const body = (await response.json()) as { sha?: string; message?: string }
      return response.ok
        ? { merged: true as const, sha: body.sha ?? '' }
        : { merged: false as const, message: body.message ?? `HTTP ${response.status}` }
    },
    async deleteBranch(branch) {
      await call('DELETE', `/repos/${repo}/git/refs/heads/${branch}`)
    },
    async closeIssue(number) {
      await call('PATCH', issuePath(number), { state: 'closed', state_reason: 'completed' })
    },
```

`test/helpers/fake-github.ts`: vor `const api` ergänzen

```ts
  const pullStates = new Map<number, { state: 'open' | 'closed'; merged: boolean; mergeCommit?: string }>()
  const deletedBranches: string[] = []
```

im `api`-Objekt:

```ts
    getPull: async (number) => pullStates.get(number) ?? { state: 'open', merged: false },
    mergePull: async (number) => {
      pullStates.set(number, { state: 'closed', merged: true, mergeCommit: `sha${number}` })
      return { merged: true, sha: `sha${number}` }
    },
    deleteBranch: async (branch) => {
      deletedBranches.push(branch)
    },
    closeIssue: async (number) => {
      issues.get(number)!.open = false
    },
```

und `return { api, issues, comments, labels, pulls, pullStates, deletedBranches }`.

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: PR mergen, Branch löschen, Issue schließen über die API"
```

---

### Task 3: Freigabe im Chat-Agenten

**Files:**
- Modify: `src/approval.ts`, `src/run.ts`
- Test: `test/run.test.ts`

- [ ] **Step 1: Tests schreiben**

`test/run.test.ts`, Import ergänzen: `import { formatTicketFile } from '../src/ticketfile.ts'`; anhängen:

```ts
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
  const thread = { id: '1.000001', index: 0, top: { level: 1, text: 'Bug im Login', author: 'U1' }, replies: [] as { level: number; text: string; author?: string }[] }
  const source: ChatSource = { name: 'slack', label: 'Fake', readThreads: async () => [thread], watch: () => {} }
  await runOnce({ ...deps, source })
  await deps.store.applyResult(1, { status: 'pr_offen', fields: { pr: 'https://github.com/o/r/pull/3' }, summary: '' })
  thread.replies.push({ level: 2, text: 'approved', author: 'U0ABC' })
  await runOnce({ ...deps, source })
  assert.match(formatTicketFile(await deps.store.read(1)), /^freigegeben_von: U0ABC$/m)
})
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

`src/approval.ts`, anhängen:

```ts
import type { TicketStore } from './store/types.ts'
import type { ChatReply, Post } from './types.ts'

export type ApprovalDeps = {
  store: TicketStore
  reply: ChatReply
  log: (message: string) => void
  now: () => Date
}

/**
 * Freigabe im Chat: setzt ein Ticket mit `pr_offen` auf `freigegeben`. Der
 * Merge selbst folgt im nächsten Lauf von `npm run steps`. Wer freigibt, wird
 * nicht geprüft (siehe Spec, Sicherheit).
 */
export async function handleApproval(
  ticketId: number,
  thread: { id: string; index: number },
  post: Post,
  deps: ApprovalDeps,
): Promise<void> {
  const say = async (text: string): Promise<void> => {
    try {
      await deps.reply(thread.id, text)
    } catch (error) {
      deps.log(`Warnung: Antwort an Thread ${thread.index} gescheitert: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const ticket = await deps.store.read(ticketId)
  const label = deps.store.label(ticketId)
  const status = ticket.header.get('status') ?? ''
  if (status === 'freigegeben') return say(`${label} ist schon freigegeben.`)
  if (status !== 'pr_offen') return say(`${label} kann noch nicht freigegeben werden, Status ist ${status}.`)

  const author = post.author ?? 'unbekannt'
  await deps.store.appendReply(ticketId, { level: post.level, text: `Freigegeben im Slack-Thread von ${author}.` }, deps.now())
  await deps.store.applyResult(ticketId, { status: 'freigegeben', fields: { freigegeben_von: author }, summary: '' })
  deps.log(`Thread ${thread.index} → Freigabe für ${label} von ${author}.`)
  await say(`${label} freigegeben. Der nächste Lauf von npm run steps merged ${ticket.header.get('pr') ?? 'den Pull Request'}.`)
}
```

Die vorhandene Zeile `const APPROVAL = …` und `isApproval` bleiben oben; die Importe gehören an den Dateianfang.

`src/run.ts`:
- Import `import { handleApproval, isApproval } from './approval.ts'`
- Die Schleife über `events` ersetzen:

```ts
  for (const event of events) {
    deps.log(summarize(event))
    const now = deps.now ?? (() => new Date())
    const ticket = state.threads[event.thread.id]?.ticket ?? null
    if (event.kind === 'NewReply' && ticket !== null && isApproval(event.reply.text)) {
      // Fest im Code statt beim LLM: Eine Meldung kann keine Freigabe herbeiformulieren.
      await handleApproval(ticket, event.thread, event.reply, { store: deps.store, reply: deps.reply, log: deps.log, now })
    } else {
      await handleEvent(event, {
        state,
        store: deps.store,
        persist,
        runModel: deps.runModel,
        log: deps.log,
        now,
        source: deps.source.name,
        reply: deps.reply,
        link: deps.link,
      })
    }
    applyEvent(state, event)
    await persist()
  }
```

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Freigabe im Chat setzt status freigegeben"
```

---

### Task 4: Schritt `merge`

**Files:**
- Create: `src/steps/merge.ts`
- Test: `test/merge.test.ts`

- [ ] **Step 1: Test schreiben**

`test/merge.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchExists, git } from '../src/git.ts'
import { createMergeStep, type MergeGitHub } from '../src/steps/merge.ts'
import { parseTicket } from '../src/ticketfile.ts'
import { createRepo } from './helpers/repo.ts'

const ticket = parseTicket(
  'id: 7\nstatus: freigegeben\ntitel: Summe falsch\nbranch: bugfix/issue-7\npr: https://github.com/o/r/pull/3\n\n## Fix\n',
)

async function setup(overrides: Partial<MergeGitHub> = {}) {
  const repo = await createRepo({ 'a.txt': 'a\n' })
  await git(repo, ['branch', 'bugfix/issue-7'])
  const merges: [number, string][] = []
  const deleted: string[] = []
  const closed: number[] = []
  const logs: string[] = []
  const github: MergeGitHub = {
    getPull: async () => ({ state: 'open', merged: false }),
    mergePull: async (number, title) => (merges.push([number, title]), { merged: true, sha: 'abc123' }),
    deleteBranch: async (branch) => void deleted.push(branch),
    ...overrides,
  }
  const step = createMergeStep({
    repo,
    base: 'ai-bugfix-agent',
    github,
    closeTicket: async (id) => void closed.push(id),
    label: (id) => `#${id}`,
    log: (m) => logs.push(m),
  })
  return { repo, step, merges, deleted, closed, logs }
}

test('Erfolg: Squash mit Titel, Branches gelöscht, Ticket geschlossen, erledigt', async () => {
  const env = await setup()
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'erledigt')
  assert.deepEqual(result.fields, { merge_commit: 'abc123' })
  assert.equal(result.summary, 'gemergt in ai-bugfix-agent: https://github.com/o/r/pull/3')
  assert.match(result.section?.text ?? '', /### Merge-Commit\nabc123/)
  assert.deepEqual(env.merges, [[3, 'Fix #7: Summe falsch (#3)']])
  assert.deepEqual(env.deleted, ['bugfix/issue-7'])
  assert.equal(await branchExists(env.repo, 'bugfix/issue-7'), false)
  assert.deepEqual(env.closed, [7])
})

test('PR schon gemergt: kein zweiter Merge, erledigt', async () => {
  const env = await setup({ getPull: async () => ({ state: 'closed', merged: true, mergeCommit: 'def456' }) })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'erledigt')
  assert.deepEqual(result.fields, { merge_commit: 'def456' })
  assert.deepEqual(env.merges, [])
  assert.deepEqual(env.closed, [7])
})

test('PR geschlossen ohne Merge: merge_gescheitert', async () => {
  const env = await setup({ getPull: async () => ({ state: 'closed', merged: false }) })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'merge_gescheitert')
  assert.equal(result.summary, 'PR #3 ist geschlossen.')
  assert.deepEqual(env.closed, [])
})

test('PR nicht mergebar: merge_gescheitert mit Meldung', async () => {
  const env = await setup({ mergePull: async () => ({ merged: false, message: 'Pull Request is not mergeable' }) })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'merge_gescheitert')
  assert.equal(result.summary, 'PR #3 ließ sich nicht mergen: Pull Request is not mergeable')
  assert.equal(await branchExists(env.repo, 'bugfix/issue-7'), true)
})

test('Feld pr fehlt: Fehler', async () => {
  const env = await setup()
  const withoutPr = parseTicket('id: 7\nstatus: freigegeben\ntitel: X\n\n')
  await assert.rejects(env.step.run(withoutPr), /kein Kopffeld pr/)
})

test('Branch löschen scheitert: Warnung, trotzdem erledigt', async () => {
  const env = await setup({
    deleteBranch: async () => {
      throw new Error('Reference does not exist')
    },
  })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'erledigt')
  assert.ok(
    env.logs.includes('Warnung: Branch bugfix/issue-7 auf GitHub nicht gelöscht: Reference does not exist'),
    env.logs.join('\n'),
  )
})
```

- [ ] **Step 2: Test laufen lassen, er scheitert**

Run: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/merge.test.ts`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implementieren**

`src/steps/merge.ts`:

```ts
import { branchExists, deleteBranch } from '../git.ts'
import type { GitHubApi } from '../store/github.ts'
import type { Ticket } from '../ticketfile.ts'
import { branchName } from './common.ts'
import type { Step, StepResult } from './types.ts'

export type MergeGitHub = Pick<GitHubApi, 'getPull' | 'mergePull' | 'deleteBranch'>

export type MergeDeps = {
  repo: string
  /** Ziel des Merges, nur für Texte; das eigentliche Ziel steht im PR */
  base: string
  github: MergeGitHub
  closeTicket: (id: number) => Promise<void>
  label: (id: number) => string
  log: (message: string) => void
  /** Default: bugfix/bug-N */
  branchName?: (id: number) => string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(reason: string): StepResult {
  return { status: 'merge_gescheitert', section: { heading: 'Merge', text: `### Grund\n${reason}` }, summary: reason }
}

export function createMergeStep(deps: MergeDeps): Step {
  return {
    name: 'merge',
    accepts: 'freigegeben',
    async run(ticket: Ticket): Promise<StepResult> {
      const id = ticket.id
      const pr = ticket.header.get('pr')
      const number = Number(/(\d+)\/?$/.exec(pr ?? '')?.[1])
      if (pr === undefined || !Number.isInteger(number)) {
        throw new Error('Das Ticket hat kein Kopffeld pr mit PR-Nummer.')
      }
      const branch = ticket.header.get('branch') ?? (deps.branchName ?? branchName)(id)
      const title = ticket.header.get('titel') ?? ''

      const pull = await deps.github.getPull(number)
      let sha = pull.mergeCommit
      if (!pull.merged) {
        if (pull.state === 'closed') return failed(`PR #${number} ist geschlossen.`)
        const result = await deps.github.mergePull(number, `Fix ${deps.label(id)}: ${title} (#${number})`)
        if (!result.merged) return failed(`PR #${number} ließ sich nicht mergen: ${result.message}`)
        sha = result.sha
      }

      // Aufräumen darf scheitern, der Merge zählt trotzdem.
      try {
        await deps.github.deleteBranch(branch)
      } catch (error) {
        deps.log(`Warnung: Branch ${branch} auf GitHub nicht gelöscht: ${message(error)}`)
      }
      if (await branchExists(deps.repo, branch)) {
        try {
          await deleteBranch(deps.repo, branch)
        } catch (error) {
          deps.log(`Warnung: Branch ${branch} lokal nicht gelöscht: ${message(error)}`)
        }
      }

      // Scheitert das, bleibt der Status freigegeben; der nächste Lauf findet den PR gemergt und holt es nach.
      await deps.closeTicket(id)
      return {
        status: 'erledigt',
        fields: { merge_commit: sha ?? '' },
        section: {
          heading: 'Merge',
          text: ['### Pull Request', pr, '', '### Merge-Commit', sha ?? '–', '', '### Basis', deps.base].join('\n'),
        },
        summary: `gemergt in ${deps.base}: ${pr}`,
      }
    },
  }
}
```

- [ ] **Step 4: Tests und Typen prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 5: Commit**

```powershell
git add src test
git commit -m "Bugfix-Agent: Schritt merge mit Squash, Aufräumen und Schließen"
```

---

### Task 5: Verdrahtung und Doku

**Files:**
- Modify: `src/steps-main.ts`, `README.md`

- [ ] **Step 1: `steps-main.ts`**

Import ergänzen: `import { createMergeStep } from './steps/merge.ts'`

Den Block `if (token !== undefined && githubRepo !== undefined) { … }` ersetzen:

```ts
  let merged = false
  const github = token !== undefined && githubRepo !== undefined
  if (github) {
    const client = githubClient(token, githubRepo)
    steps.push(
      createFixStep({
        ...common,
        base,
        testCommand,
        label: (id) => store.label(id),
        publish: githubPublisher(token, githubRepo, client),
      }),
    )
    const mergeStep = createMergeStep({
      repo,
      base,
      github: client,
      closeTicket: (id) => store.close(id),
      label: (id) => store.label(id),
      log,
      branchName: common.branchName,
    })
    // Merkt sich einen Merge für den Hinweis auf git pull am Ende.
    steps.push({
      ...mergeStep,
      run: async (ticket) => {
        const result = await mergeStep.run(ticket)
        if (result.status === 'erledigt') merged = true
        return result
      },
    })
  }
```

In der Log-Zeile `steps.length === 3 ? …` → `github ? …` und den Text `PR gegen ${base}` → `PR und Merge gegen ${base}`.

Im `try` nach `runSteps(...)`:

```ts
    if (merged) log(`${base} lokal aktualisieren: git -C "${repo}" pull`)
    return failed === 0 ? 0 : 1
```

(`const failed = await runSteps(...)` bleibt; nur die Hinweiszeile kommt davor.)

- [ ] **Step 2: README**

Im Abschnitt „Analysieren und Planen“ die Statusliste ergänzen:

```markdown
- `pr_offen` → `freigegeben`: Jemand schreibt im Slack-Thread genau „approved“ oder „freigegeben“ (ohne Beachtung von Groß- und Kleinschreibung, höchstens mit `!` oder `.`). Das erkennt der Chat-Agent selbst, nicht das LLM. Er antwortet im Thread und vermerkt den Absender im Ticket (`freigegeben_von`).
- `freigegeben` → `erledigt`: Squash-Merge des PRs in `TARGET_BASE`, Branch auf GitHub und lokal gelöscht, Issue geschlossen. Danach `TARGET_BASE` lokal aktualisieren (`git pull`), sonst findet eine neue Analyse behobene Bugs erneut.
- `freigegeben` → `merge_gescheitert`: PR nicht mergebar oder geschlossen. Nach einer Korrektur den Status wieder auf `freigegeben` setzen.

**Achtung:** Die Freigabe prüft nicht, wer sie schreibt. Jeder im Slack-Workspace kann einen Merge auslösen. Nur im eigenen Demo-Workspace verwenden.
```

Spec `docs/specs/2026-11-24-freigabe-merge-design.md` in die Liste der Specs am Ende aufnehmen.

- [ ] **Step 3: Prüfen**

Run: `npm test; npm run typecheck`
Expected: alle PASS, `tsc` ohne Fehler.

- [ ] **Step 4: Commit**

```powershell
git add src README.md
git commit -m "Bugfix-Agent: Merge-Schritt verdrahtet, Hinweis auf git pull, Doku"
```

---

### Task 6: Live-Lauf mit dem Nutzer

- [ ] **Step 1:** Der Nutzer startet seinen Chat-Agenten neu (`npm run watch`), damit Erkennung und Absender greifen.
- [ ] **Step 2:** Der Nutzer schreibt im Slack-Thread von #15 `approved`.
  Expected: Antwort `#15 freigegeben. Der nächste Lauf von npm run steps merged https://github.com/guidodunker/ai_experiments/pull/17.`; Issue #15 auf `status:freigegeben`, Kommentar mit Slack-User-ID.
- [ ] **Step 3:** `$env:TICKET=15; npm run steps; Remove-Item Env:TICKET`
  Expected: `Ticket 15 merge → erledigt gemergt in ai-bugfix-agent: …/pull/17`; PR #17 gemergt (Squash), Branch `bugfix/issue-15` auf GitHub weg, Issue #15 geschlossen; Slack `#15: erledigt …`; Log-Hinweis auf `git pull`.
- [ ] **Step 4:** Ergebnis im Gedächtnis festhalten.
