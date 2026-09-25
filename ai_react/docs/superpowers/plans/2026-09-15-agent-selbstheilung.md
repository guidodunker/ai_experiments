# Agent-Selbstheilung — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der interne Coding-Agent erkennt selbst, wenn er die App kaputt gemacht hat, repariert sie im laufenden Turn und rollt zurück, wenn ihm das nicht gelingt.

**Architecture:** Drei gestaffelte Linien. (1) Ein Syntax-Gate im Dev-Server lehnt unparsbare Writes ab, bevor sie auf die Platte kommen. (2) Am Turn-Ende prüft die Agent-Loop per Server-Probe (`transformRequest`), gesammelten Laufzeitfehlern und `tsc --noEmit`, ob die App noch läuft, und speist Fehler als weitere Iteration zurück — maximal dreimal, dann Rollback auf den Pre-Write-Snapshot. (3) Ein Watchdog im Chat-Store reagiert auf Fehler nach Turn-Ende. Eine ErrorBoundary sorgt dafür, dass der Chat einen Render-Crash der App überlebt — ohne sie wäre Selbstkorrektur unmöglich.

**Tech Stack:** Vite 8 (rolldown/oxc), React 19, TypeScript 6, Node 22. Keine neue Dependency: das Syntax-Gate nutzt das vorhandene `typescript`, Tests laufen mit Nodes eingebautem `node:test` über `--experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-09-14-agent-selbstheilung-design.md`

**Stand 2026-09-15:** Tasks 1–12 implementiert und committet (`d36fc00` … `436122a`).
Automatisch verifiziert: 16/16 Tests, `tsc --noEmit` sauber, `oxlint` sauber, `npm run build`
erfolgreich, Syntax-Gate/Probe/Typecheck/Rollback gegen den laufenden Dev-Server geprüft.
**Offen:** die Abnahme-Szenarien aus Task 12 Step 4–5 — sie brauchen einen Browser und echte
Modellaufrufe. Eine Korrektur gegenüber dem ursprünglichen Plan steht in Task 5 (gitHead-Fallback).

---

## Vorbemerkungen für die ausführende Person

**Das Projekt ist eine sich selbst modifizierende App.** Der Chat in der laufenden App steuert einen Agenten, der die eigenen Quelldateien schreibt. `server/`, `src/agent/`, `src/chat/`, `src/main.tsx`, `index.html`, `package.json`, `tsconfig*.json` und `vite.config.ts` sind für diesen Agenten schreibgeschützt (`server/agentPlugin.ts:25`). **Du** (der Mensch/das Werkzeug, das diesen Plan ausführt) darfst sie ändern — der Agent nicht. Alles, was wir hier bauen, liegt bewusst in diesen geschützten Bereichen.

**Umgebung.** Windows, PowerShell. Das Bash-Tool ist auf diesem Rechner defekt (cygwin-Fork-Fehler) — alle Kommandos unten sind PowerShell. Der Dev-Server läuft mit `npm run dev` auf http://localhost:5173.

**Vite bindet auf `localhost`, nicht auf `127.0.0.1`.** Requests gegen `127.0.0.1` laufen ins Leere. Immer `http://localhost:5173/...` verwenden.

**Kein Testframework, aber echte Tests.** Reine Funktionen werden mit `node:test` getestet (`npm test`). Alles mit Browser-, Git- oder HMR-Bezug wird als manuelles Szenario verifiziert — die Szenarien stehen jeweils im Task und noch einmal gesammelt in Task 12.

---

## Dateiübersicht

**Neu:**

| Datei | Verantwortung |
|---|---|
| `server/syntaxCheck.ts` | Eine reine Funktion: parst ein Snippet, meldet den ersten Syntaxfehler |
| `server/tscCheck.ts` | `tsc --noEmit` starten (Single-Flight) und die Ausgabe parsen |
| `server/healthProbe.ts` | Module über Vites Transform-Pipeline laden lassen |
| `src/agent/healthReport.ts` | Reine Helfer: Problem-Typ, Klassifikation, Signatur, Fehlerbericht |
| `src/agent/health.ts` | Browser-Sammler für Laufzeit-, HMR- und Render-Fehler |
| `src/agent/verify.ts` | Orchestriert den Health-Check am Turn-Ende |
| `src/chat/AppErrorBoundary.tsx` | Fängt Render-Crashes, hält den Chat am Leben |
| `tests/*.test.ts` | Tests der reinen Funktionen |

**Geändert:** `server/agentPlugin.ts` (Gate, Routen, Snapshot-Tracking, `tests/` schützen) · `src/agent/loop.ts` (Turn-Gate + Reparaturschleife) · `src/agent/types.ts` (neue Transkript-Karten) · `src/agent/systemPrompt.ts` · `src/chat/store.ts` (Watchdog, Health-Karten) · `src/chat/MessageList.tsx` + `src/chat/chat.css` · `src/main.tsx` · `package.json` (Test-Skript) · `README.md`

---

## Task 1: Syntax-Gate als reine Funktion

**Files:**
- Create: `server/syntaxCheck.ts`
- Create: `tests/syntaxCheck.test.ts`
- Modify: `package.json` (Skript `test`)

- [ ] **Step 1: Test schreiben**

`tests/syntaxCheck.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSyntax } from '../server/syntaxCheck.ts'

// Position 35 in this exact input is verified ground truth from tsc.
test('rejects unparsable JSX and names line and column', () => {
  const msg = checkSyntax('src/Broken.tsx', 'export function A(){ return <div>{x</div> }')
  assert.equal(msg, "Syntax error in src/Broken.tsx (line 1, column 36): '}' expected.")
})

test('accepts a pure type error — that is tsc\u2019s job, not the gate\u2019s', () => {
  assert.equal(checkSyntax('src/T.ts', 'export const x: string = 1\n'), null)
})

test('accepts valid TSX', () => {
  assert.equal(checkSyntax('src/Ok.tsx', 'export const A = () => <div className="a">ok</div>\n'), null)
})

test('accepts multi-line TSX with hooks', () => {
  const code = [
    "import { useState } from 'react'",
    'export function C() {',
    '  const [n, setN] = useState(0)',
    '  return <button onClick={() => setN(n + 1)}>{n}</button>',
    '}',
  ].join('\n')
  assert.equal(checkSyntax('src/C.tsx', code), null)
})

test('ignores files that are not JS or TS', () => {
  assert.equal(checkSyntax('src/App.css', '.a { color: red\n'), null)
  assert.equal(checkSyntax('README.md', '# nope {{{\n'), null)
})
```

- [ ] **Step 2: Test-Skript eintragen**

In `package.json` unter `"scripts"` ergänzen (nach `"lint"`):

```json
    "test": "node --experimental-strip-types --test tests/syntaxCheck.test.ts",
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

```powershell
npm test
```

Erwartet: Fehlschlag mit `Cannot find module` bzw. `ERR_MODULE_NOT_FOUND` für `../server/syntaxCheck.ts`.

- [ ] **Step 4: Implementierung schreiben**

`server/syntaxCheck.ts`:

```ts
// Syntax gate for agent writes: code that cannot even be parsed never reaches
// disk, so the running app can never die from a half-written file. Type errors
// are deliberately NOT checked here — an intermediate state where App.tsx
// imports a component that is written one tool call later is legitimate. Those
// are caught at the end of the turn by server/tscCheck.ts.

import ts from 'typescript'

const CHECKED = /\.(ts|tsx|js|jsx|mts|cts)$/i

function lineCol(content: string, pos: number): { line: number; col: number } {
  const lines = content.slice(0, pos).split('\n')
  return { line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

/**
 * Returns null when `content` parses (or is not a JS/TS file), otherwise a
 * message naming the first syntax error with its 1-based line and column.
 */
export function checkSyntax(relPath: string, content: string): string | null {
  if (!CHECKED.test(relPath)) return null

  const { diagnostics } = ts.transpileModule(content, {
    reportDiagnostics: true,
    fileName: relPath,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  })

  const first = diagnostics?.[0]
  if (!first) return null

  const message = ts.flattenDiagnosticMessageText(first.messageText, ' ')
  if (first.start === undefined) return `Syntax error in ${relPath}: ${message}`
  const { line, col } = lineCol(content, first.start)
  return `Syntax error in ${relPath} (line ${line}, column ${col}): ${message}`
}
```

- [ ] **Step 5: Test laufen lassen, Erfolg bestätigen**

```powershell
npm test
```

Erwartet: `# pass 5`, `# fail 0`.

- [ ] **Step 6: Committen**

```powershell
git add server/syntaxCheck.ts tests/syntaxCheck.test.ts package.json
git commit -m "feat(server): syntax gate as a pure, tested function"
```

---

## Task 2: Syntax-Gate in den Write-Endpunkt einhängen

Reihenfolge ist wichtig: **prüfen → Snapshot → schreiben**. Würde zuerst der Snapshot gezogen, verbrauchte ein abgelehnter Write den einmaligen Snapshot des Turns.

**Files:**
- Modify: `server/agentPlugin.ts` (Import oben; Write-Handler ab Zeile 217)

- [ ] **Step 1: Import ergänzen**

In `server/agentPlugin.ts` nach `import { recoveryHtml } from './recoveryPage.ts'`:

```ts
import { checkSyntax } from './syntaxCheck.ts'
```

- [ ] **Step 2: Prüfung vor dem Snapshot einsetzen**

Im Handler `/api/fs/write`, direkt nach dem `content`-Typcheck und **vor** dem `let snapshot: string | null = null`:

```ts
            const syntaxError = checkSyntax(relPath, content)
            if (syntaxError) {
              logLine(`write ${relPath} → REJECTED (${syntaxError})`)
              return sendJson(res, 422, {
                error:
                  `${syntaxError} — nothing was written. ` +
                  'Send the COMPLETE corrected file content in a new write_file call.',
              })
            }
```

- [ ] **Step 3: Zuerst committen, dann testen**

```powershell
git add server/agentPlugin.ts
git commit -m "feat(server): reject writes that do not parse, before snapshotting"
```

**Reihenfolge ist Absicht.** Jeder erfolgreiche `write_file`-Aufruf löst serverseitig einen Snapshot-Commit aus, der *alles* im Arbeitsverzeichnis mitnimmt — auch deine noch nicht committete Implementierung. Wer erst testet und dann committen will, steht vor einem „nothing to commit". Also erst festschreiben, dann die API anfassen.

- [ ] **Step 4: Dev-Server starten**

```powershell
npm run dev
```

Läuft in einem eigenen Terminal weiter. Erwartet: `VITE v8.2.2 ready`, Local http://localhost:5173/

- [ ] **Step 5: Kaputten Write manuell abfeuern**

Neues Terminal:

```powershell
$body = @{ path = 'src/components/__gate.tsx'; content = 'export const A = () => <div>{x</div>'; turnId = 'probe1' } | ConvertTo-Json
try {
  Invoke-WebRequest -Uri 'http://localhost:5173/api/fs/write' -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing
} catch {
  $r = $_.Exception.Response
  $sr = New-Object IO.StreamReader($r.GetResponseStream())
  'STATUS ' + [int]$r.StatusCode; $sr.ReadToEnd()
}
Test-Path src/components/__gate.tsx
```

Erwartet: `STATUS 422`, Body enthält `Syntax error in src/components/__gate.tsx (line 1, column ...)`, und `Test-Path` gibt **False** — die Datei wurde nicht angelegt.

- [ ] **Step 6: Gesunden Write abfeuern und aufräumen**

```powershell
$body = @{ path = 'src/components/__gate.tsx'; content = 'export const A = () => <div>ok</div>' + [char]10; turnId = 'probe2' } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:5173/api/fs/write' -Method Post -ContentType 'application/json' -Body $body
Test-Path src/components/__gate.tsx
Remove-Item src/components/__gate.tsx
git status --porcelain
```

Erwartet: Antwort `ok = True` mit `snapshot`-Hash, `Test-Path` gibt **True**, nach dem Löschen ist `git status` sauber. Der Snapshot-Commit aus diesem Test darf in der Historie stehen bleiben.

**Kein `git checkout -- .`** an dieser Stelle — das würde die eben implementierte Änderung an `server/agentPlugin.ts` mit verwerfen, falls sie noch nicht committet ist.

---

## Task 3: tsc-Durchgang mit Single-Flight

**Files:**
- Create: `server/tscCheck.ts`
- Create: `tests/tscCheck.test.ts`
- Modify: `package.json` (Testdatei ergänzen)

- [ ] **Step 1: Test schreiben**

`tests/tscCheck.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTscOutput } from '../server/tscCheck.ts'

test('parses diagnostics into structured entries', () => {
  const stdout = [
    "src/App.tsx(12,7): error TS2304: Cannot find name 'x'.",
    "src/components/TodoList.tsx(3,10): error TS6133: 'unused' is declared but its value is never read.",
    '',
    'Found 2 errors in 2 files.',
  ].join('\n')

  const diagnostics = parseTscOutput(stdout)

  assert.equal(diagnostics.length, 2)
  assert.deepEqual(diagnostics[0], {
    file: 'src/App.tsx',
    line: 12,
    col: 7,
    code: 'TS2304',
    message: "Cannot find name 'x'.",
  })
  assert.equal(diagnostics[1].code, 'TS6133')
})

test('normalises Windows path separators', () => {
  const diagnostics = parseTscOutput('src\\components\\A.tsx(1,1): error TS1005: expected.')
  assert.equal(diagnostics[0].file, 'src/components/A.tsx')
})

test('returns nothing for clean output', () => {
  assert.deepEqual(parseTscOutput('\n'), [])
  assert.deepEqual(parseTscOutput(''), [])
})

test('ignores summary and warning lines', () => {
  assert.deepEqual(parseTscOutput('Found 0 errors.\nsrc/A.tsx(1,1): warning TS0000: nope.'), [])
})
```

- [ ] **Step 2: Testdatei ins Skript aufnehmen**

In `package.json` das `test`-Skript ersetzen durch:

```json
    "test": "node --experimental-strip-types --test tests/syntaxCheck.test.ts tests/tscCheck.test.ts",
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

```powershell
npm test
```

Erwartet: Fehlschlag, `server/tscCheck.ts` existiert nicht.

- [ ] **Step 4: Implementierung schreiben**

`server/tscCheck.ts`:

```ts
// Full type check of the app project. This is the thorough second pass behind
// the module probe: it sees type errors the browser never notices (Vite strips
// types without checking them), which break `npm run build` later on.
//
// Runtime measured on this project: ~3.0 s warm, ~8.8 s cold.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TypeDiagnostic {
  file: string
  line: number
  col: number
  code: string
  message: string
}

// tsc's non-pretty format: src/App.tsx(12,7): error TS2304: Cannot find name 'x'.
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/

export function parseTscOutput(stdout: string): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(raw.trim())
    if (!match) continue
    diagnostics.push({
      file: match[1].split('\\').join('/'),
      line: Number(match[2]),
      col: Number(match[3]),
      code: match[4],
      message: match[5],
    })
  }
  return diagnostics
}

let inFlight: Promise<TypeDiagnostic[]> | null = null

/**
 * Type-check the app project. Concurrent callers share one tsc run instead of
 * starting a second compiler — the check is the slowest part of the turn gate.
 */
export function runTypecheck(root: string): Promise<TypeDiagnostic[]> {
  if (!inFlight) {
    inFlight = execTypecheck(root).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function execTypecheck(root: string): Promise<TypeDiagnostic[]> {
  const bin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  try {
    await execFileAsync(
      process.execPath,
      [bin, '--noEmit', '--incremental', '--pretty', 'false', '-p', 'tsconfig.app.json'],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    )
    return []
  } catch (err) {
    // tsc exits non-zero when it found errors; the diagnostics are on stdout.
    const stdout = (err as { stdout?: string }).stdout ?? ''
    const diagnostics = parseTscOutput(stdout)
    if (diagnostics.length > 0) return diagnostics
    // Non-zero without parsable diagnostics means tsc itself failed to run.
    return [
      {
        file: 'tsconfig.app.json',
        line: 0,
        col: 0,
        code: 'TSC',
        message: `tsc could not run: ${String((err as Error).message ?? err).slice(0, 200)}`,
      },
    ]
  }
}
```

- [ ] **Step 5: Test laufen lassen, Erfolg bestätigen**

```powershell
npm test
```

Erwartet: `# pass 9`, `# fail 0`.

- [ ] **Step 6: Committen**

```powershell
git add server/tscCheck.ts tests/tscCheck.test.ts package.json
git commit -m "feat(server): tsc runner with single-flight and output parser"
```

---

## Task 4: Modul-Probe und die beiden Health-Routen

Die Probe lässt Vite die Transformation selbst durchführen. Verifiziert: gesundes Modul → Result; Syntaxfehler → wirft `Transform failed … [PARSE_ERROR] …`; unauflösbarer Import → wirft `Failed to resolve import "./X.tsx" from "src/y.tsx". Does the file exist?`; fehlende Datei → wirft `Failed to load url …`.

**Files:**
- Create: `server/healthProbe.ts`
- Modify: `server/agentPlugin.ts` (Import; neue Routen)

- [ ] **Step 1: Probe-Modul schreiben**

`server/healthProbe.ts`:

```ts
// Asks Vite to transform modules exactly the way it would for the browser. A
// throw here means the browser could not have loaded the module either:
// syntax error, unresolvable import, or missing file.
//
// Why not probe from the browser: over HTTP a broken module is a bare 500 with
// an empty body, and a MISSING file returns 200 text/html (the SPA fallback),
// which would look perfectly healthy. Only the server sees the real error.

import type { ViteDevServer } from 'vite'

const ANSI = /\u001b\[[0-9;]*m/g

export interface ProbeFailure {
  path: string
  message: string
}

export async function probeModules(
  server: ViteDevServer,
  paths: string[],
): Promise<ProbeFailure[]> {
  const env = server.environments.client
  const failures: ProbeFailure[] = []

  for (const rel of paths) {
    const url = '/' + rel.replace(/^\/+/, '')
    try {
      // Invalidate first: the write may have landed before Vite's watcher fired,
      // and a cached result would report a broken file as healthy.
      const mod = await env.moduleGraph.getModuleByUrl(url)
      if (mod) env.moduleGraph.invalidateModule(mod)
      await env.transformRequest(url)
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
        .replace(ANSI, '')
        .replace(/\s+/g, ' ')
        .trim()
      failures.push({ path: rel, message: message.slice(0, 400) })
    }
  }

  return failures
}
```

- [ ] **Step 2: Imports in agentPlugin.ts ergänzen**

```ts
import { probeModules } from './healthProbe.ts'
import { runTypecheck } from './tscCheck.ts'
```

- [ ] **Step 3: Routen einsetzen**

In `server/agentPlugin.ts` im `handle()`-Block, direkt vor `if (url === '/api/git/commit' …)`:

```ts
          if (url === '/api/health/probe' && req.method === 'POST') {
            const { paths } = JSON.parse(await readBody(req))
            const requested = Array.isArray(paths)
              ? paths.filter((p: unknown): p is string => typeof p === 'string')
              : []
            // App.tsx is always probed: it is the module every page hangs off.
            const targets = ['src/App.tsx', ...requested].filter(
              (p, i, all) => all.indexOf(p) === i,
            )
            const failures = await probeModules(server, targets)
            logLine(`probe ${targets.length} module(s) → ${failures.length} failure(s)`)
            return sendJson(res, 200, { failures })
          }

          if (url === '/api/health/typecheck' && req.method === 'GET') {
            const diagnostics = await runTypecheck(root)
            logLine(`typecheck → ${diagnostics.length} diagnostic(s)`)
            return sendJson(res, 200, { diagnostics })
          }
```

- [ ] **Step 4: Gesunden Zustand prüfen**

Dev-Server läuft (`npm run dev`).

```powershell
Invoke-RestMethod -Uri 'http://localhost:5173/api/health/probe' -Method Post -ContentType 'application/json' -Body '{"paths":[]}'
Invoke-RestMethod -Uri 'http://localhost:5173/api/health/typecheck'
```

Erwartet: beide Antworten mit leeren Listen (`failures` leer, `diagnostics` leer).

- [ ] **Step 5: Kaputten Zustand prüfen**

```powershell
'import { Nix } from "./FehltKomplett.tsx"' + [char]10 + 'export const B = () => Nix' | Out-File -Encoding utf8 src/components/__probe.tsx
$body = @{ paths = @('src/components/__probe.tsx') } | ConvertTo-Json
(Invoke-RestMethod -Uri 'http://localhost:5173/api/health/probe' -Method Post -ContentType 'application/json' -Body $body).failures
Remove-Item src/components/__probe.tsx
```

Erwartet: ein Eintrag mit `path = src/components/__probe.tsx` und einer Message, die `Failed to resolve import` enthält — ohne ANSI-Escapes.

- [ ] **Step 6: Committen**

```powershell
git add server/healthProbe.ts server/agentPlugin.ts
git commit -m "feat(server): module probe and health routes"
```

---

## Task 5: Rollback-Endpunkt und Snapshot-Tracking

**Files:**
- Modify: `server/agentPlugin.ts` (Zeile 125 Snapshot-State, Write-Handler, neue Route, `WRITE_PROTECTED_DIRS`)

- [ ] **Step 1: `tests/` vor dem Agenten schützen**

In `server/agentPlugin.ts` die Konstante erweitern:

```ts
const WRITE_PROTECTED_DIRS = ['server', 'src/agent', 'src/chat', 'tests']
```

- [ ] **Step 2: Snapshot-Hash mitführen**

`let lastSnapshotTurn = ''` (Zeile 125) ersetzen durch:

```ts
  // Turn id of the last snapshot, so we snapshot only once per user turn, plus
  // its commit hash so a failed turn can be rolled back to exactly that state.
  let lastSnapshotTurn = ''
  let lastSnapshot: { turnId: string; hash: string } | null = null
```

Vor `export function agentPlugin()` einen Helfer ergänzen:

```ts
/** Short hash of the current HEAD commit, or null if git is unavailable. */
async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
    return stdout.trim()
  } catch {
    return null
  }
}
```

Im Write-Handler den Snapshot-Block ersetzen durch:

```ts
            let snapshot: string | null = null
            if (typeof turnId === 'string' && turnId !== lastSnapshotTurn) {
              lastSnapshotTurn = turnId
              snapshot = await gitCommitAll(root, SNAPSHOT_MESSAGE)
              // A clean working tree means there was nothing to snapshot — the
              // state before this write is simply HEAD. Without this fallback
              // the rollback anchor would be missing in the most common case.
              const anchor = snapshot ?? (await gitHead(root))
              lastSnapshot = anchor ? { turnId, hash: anchor } : null
            }
```

**Der `gitHead`-Fallback ist nicht optional.** `gitCommitAll` gibt `null` zurück, wenn es nichts zu committen gab — und genau das ist der Normalfall: Der vorige Turn wurde committet, der Baum ist sauber, der Agent schreibt die erste Datei. Ohne den Fallback hätte der Rollback in fast allen echten Fällen mit `409 No snapshot exists for this turn` geantwortet. (Beim Ausführen genau so passiert.)

- [ ] **Step 3: Rollback-Route einsetzen**

Direkt nach der `/api/git/restore`-Route:

```ts
          if (url === '/api/git/rollback' && req.method === 'POST') {
            const { turnId } = JSON.parse(await readBody(req))
            if (!lastSnapshot || lastSnapshot.turnId !== turnId) {
              logLine(`rollback ${turnId} → no snapshot for this turn`)
              return sendJson(res, 409, {
                error: 'No snapshot exists for this turn — nothing to roll back.',
              })
            }
            try {
              // Keep the broken state in history first, so nothing is ever lost.
              await gitCommitAll(root, SNAPSHOT_MESSAGE)
              await execFileAsync('git', ['read-tree', '--reset', '-u', lastSnapshot.hash], {
                cwd: root,
              })
              const restored = await gitCommitAll(
                root,
                `rollback of broken agent changes (state of ${lastSnapshot.hash})`,
              )
              logLine(`rollback ${turnId} → ${restored ?? 'nothing to do'}`)
              return sendJson(res, 200, { ok: true, snapshot: lastSnapshot.hash, restored })
            } catch (err) {
              logLine(`rollback failed: ${err}`)
              return sendJson(res, 500, { error: `git rollback failed: ${err}` })
            }
          }
```

- [ ] **Step 4: Committen, bevor die API angefasst wird**

```powershell
git add server/agentPlugin.ts
git commit -m "feat(server): rollback endpoint and per-turn snapshot hash"
```

Gleicher Grund wie in Task 2: Der Test unten schreibt eine Datei, das löst einen Snapshot-Commit über das ganze Arbeitsverzeichnis aus.

- [ ] **Step 5: Rollback manuell verifizieren**

Dev-Server läuft (nach der Änderung neu starten, damit das Plugin neu geladen wird). Arbeitsverzeichnis muss sauber sein (`git status --porcelain` leer).

```powershell
$before = git rev-parse --short HEAD
$w = @{ path = 'src/components/__rb.tsx'; content = 'export const R = () => <div>rollback me</div>' + [char]10; turnId = 'rbturn' } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:5173/api/fs/write' -Method Post -ContentType 'application/json' -Body $w
Invoke-RestMethod -Uri 'http://localhost:5173/api/git/rollback' -Method Post -ContentType 'application/json' -Body '{"turnId":"rbturn"}'
Test-Path src/components/__rb.tsx
git log --oneline -3
```

Erwartet: Der Write legt die Datei an und liefert einen `snapshot`-Hash. Der Rollback antwortet mit `ok = True` und einem `restored`-Hash. `Test-Path` gibt **False** — die Datei ist weg. `git log` zeigt oben den `rollback of broken agent changes`-Commit, darunter den Snapshot; nichts wurde aus der Historie entfernt.

- [ ] **Step 6: Falschen Turn ablehnen**

```powershell
try { Invoke-WebRequest -Uri 'http://localhost:5173/api/git/rollback' -Method Post -ContentType 'application/json' -Body '{"turnId":"gibtsnicht"}' -UseBasicParsing } catch { 'STATUS ' + [int]$_.Exception.Response.StatusCode }
```

Erwartet: `STATUS 409`.

---

## Task 6: Reine Helfer für den Fehlerbericht

Hier liegt die inhaltliche Logik: Was ist „kaputt", was ist nur ein Build-Fehler, wann steht die Reparatur still, und wie sieht der Text aus, den das Modell zu lesen bekommt.

**Files:**
- Create: `src/agent/healthReport.ts`
- Create: `tests/healthReport.test.ts`
- Modify: `package.json` (Testdatei ergänzen)

- [ ] **Step 1: Test schreiben**

`tests/healthReport.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReport,
  isAppBroken,
  signatureOf,
  type Problem,
} from '../src/agent/healthReport.ts'

const probe: Problem = { kind: 'probe', file: 'src/App.tsx', message: 'Failed to resolve import' }
const type6133: Problem = {
  kind: 'type',
  file: 'src/App.tsx',
  line: 3,
  col: 10,
  code: 'TS6133',
  message: "'x' is declared but its value is never read.",
}

test('type errors alone do not mean the app is broken', () => {
  assert.equal(isAppBroken([type6133]), false)
})

test('probe, runtime and hmr failures mean the app is broken', () => {
  assert.equal(isAppBroken([probe]), true)
  assert.equal(isAppBroken([{ kind: 'runtime', message: 'x is not a function' }]), true)
  assert.equal(isAppBroken([{ kind: 'hmr', message: 'parse error' }]), true)
  assert.equal(isAppBroken([type6133, probe]), true)
})

test('an empty problem list is not broken', () => {
  assert.equal(isAppBroken([]), false)
})

test('the signature ignores ordering', () => {
  assert.equal(signatureOf([probe, type6133]), signatureOf([type6133, probe]))
})

test('the signature changes when the problems change', () => {
  const moved: Problem = { ...type6133, line: 4 }
  assert.notEqual(signatureOf([type6133]), signatureOf([moved]))
})

test('the report names file, line and code, and tells the model what to do', () => {
  const report = buildReport([type6133], 1, 3)
  assert.match(report, /attempt 1 of 3/)
  assert.match(report, /src\/App\.tsx\(3,10\)/)
  assert.match(report, /TS6133/)
  assert.match(report, /build is broken/)
})

test('a broken app gets the rollback warning, a build error does not', () => {
  assert.match(buildReport([probe], 2, 3), /rolled back/)
  assert.doesNotMatch(buildReport([type6133], 2, 3), /rolled back/)
})
```

- [ ] **Step 2: Testdatei ins Skript aufnehmen**

`package.json`, `test`-Skript ersetzen durch:

```json
    "test": "node --experimental-strip-types --test tests/syntaxCheck.test.ts tests/tscCheck.test.ts tests/healthReport.test.ts",
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

```powershell
npm test
```

Erwartet: Fehlschlag, `src/agent/healthReport.ts` existiert nicht.

- [ ] **Step 4: Implementierung schreiben**

`src/agent/healthReport.ts`:

```ts
// Pure helpers behind the health check: what counts as "broken", whether a
// repair loop is making progress, and the text the model gets to read. No
// browser and no server APIs in here — that is what makes it unit-testable.

export type ProblemKind = 'probe' | 'runtime' | 'hmr' | 'type'

export interface Problem {
  kind: ProblemKind
  message: string
  file?: string
  line?: number
  col?: number
  code?: string
}

/**
 * Probe, runtime and HMR failures mean the running app is broken and may
 * trigger a rollback. Type errors only break `npm run build`, never the app in
 * the browser — they are reported and repaired, but never rolled back.
 */
export function isAppBroken(problems: Problem[]): boolean {
  return problems.some((p) => p.kind !== 'type')
}

/**
 * Stable fingerprint of a set of problems. Two identical signatures in a row
 * mean the repair loop is stuck and further attempts would just cost tokens.
 */
export function signatureOf(problems: Problem[]): string {
  return problems
    .map((p) => `${p.kind}:${p.file ?? '-'}:${p.line ?? '-'}:${p.code ?? p.message}`)
    .sort()
    .join('|')
}

const LABEL: Record<ProblemKind, string> = {
  probe: 'MODULE FAILED TO LOAD',
  runtime: 'RUNTIME ERROR',
  hmr: 'VITE ERROR',
  type: 'TYPE ERROR',
}

function location(p: Problem): string {
  if (!p.file) return ''
  if (p.line === undefined) return ` ${p.file}`
  return ` ${p.file}(${p.line}${p.col === undefined ? '' : `,${p.col}`})`
}

export function buildReport(problems: Problem[], attempt: number, maxAttempts: number): string {
  const lines = problems.map(
    (p) => `- [${LABEL[p.kind]}]${location(p)}${p.code ? ` ${p.code}` : ''}: ${p.message}`,
  )
  return [
    `AUTOMATIC HEALTH CHECK FAILED (repair attempt ${attempt} of ${maxAttempts}).`,
    'This is not a user message — the dev server checked the app after your changes.',
    '',
    ...lines,
    '',
    isAppBroken(problems)
      ? 'The running app is broken. Read the files you just changed, find the cause, and fix it with write_file. If you cannot fix it, say so plainly instead of guessing — your changes are then rolled back automatically.'
      : 'The app still runs, but the build is broken. Fix the reported type errors with write_file.',
  ].join('\n')
}
```

- [ ] **Step 5: Test laufen lassen, Erfolg bestätigen**

```powershell
npm test
```

Erwartet: `# pass 16`, `# fail 0`.

- [ ] **Step 6: Committen**

```powershell
git add src/agent/healthReport.ts tests/healthReport.test.ts package.json
git commit -m "feat(agent): pure health-report helpers"
```

---

## Task 7: Fehlersammler im Browser

**Files:**
- Create: `src/agent/health.ts`

- [ ] **Step 1: Sammler schreiben**

`src/agent/health.ts`:

```ts
// Collects everything in the browser that says "the app is broken": uncaught
// errors, unhandled rejections, Vite's HMR error payloads, and React render
// crashes reported by AppErrorBoundary. Lives in src/agent, which is
// write-protected — the agent cannot disable its own smoke detector.

import type { Problem } from './healthReport.ts'

const MAX_ENTRIES = 20

interface Entry {
  at: number
  problem: Problem
}

const entries: Entry[] = []
const listeners = new Set<(problem: Problem) => void>()

function record(problem: Problem): void {
  entries.push({ at: Date.now(), problem })
  if (entries.length > MAX_ENTRIES) entries.shift()
  for (const listener of listeners) listener(problem)
}

/** Problems recorded at or after `since` (a Date.now() timestamp). */
export function errorsSince(since: number): Problem[] {
  return entries.filter((e) => e.at >= since).map((e) => e.problem)
}

/** Notified for every new problem — used by the watchdog in the chat store. */
export function subscribe(listener: (problem: Problem) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Called by AppErrorBoundary when React caught a render crash. */
export function reportRenderError(error: Error, componentStack: string): void {
  const frames = componentStack.trim().split('\n').slice(0, 3).join('\n')
  record({ kind: 'runtime', message: `${error.message}\n${frames}` })
}

window.addEventListener('error', (event) => {
  record({
    kind: 'runtime',
    message: event.message,
    file: event.filename,
    line: event.lineno,
    col: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as Error | undefined
  record({ kind: 'runtime', message: `Unhandled rejection: ${reason?.message ?? String(event.reason)}` })
})

interface ViteErrorPayload {
  err: { message: string; id?: string; loc?: { line: number; column: number } }
}

if (import.meta.hot) {
  // Cast inside instead of annotating the parameter: Vite declares its own
  // payload type for this event, and a narrower annotation on the handler is
  // rejected as incompatible.
  import.meta.hot.on('vite:error', (rawPayload) => {
    const payload = rawPayload as unknown as ViteErrorPayload
    record({
      kind: 'hmr',
      message: payload.err.message.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim(),
      file: payload.err.id,
      line: payload.err.loc?.line,
      col: payload.err.loc?.column,
    })
  })
}

/**
 * Resolves once HMR has applied its pending update, or after `timeoutMs` — the
 * turn gate must not check the app while Vite is still swapping modules in.
 */
export function waitForHmr(timeoutMs = 600): Promise<void> {
  return new Promise((resolve) => {
    const hot = import.meta.hot
    if (!hot) {
      setTimeout(resolve, timeoutMs)
      return
    }
    const done = () => {
      clearTimeout(timer)
      hot.off('vite:afterUpdate', done)
      resolve()
    }
    const timer = setTimeout(() => {
      hot.off('vite:afterUpdate', done)
      resolve()
    }, timeoutMs)
    hot.on('vite:afterUpdate', done)
  })
}
```

- [ ] **Step 2: Typprüfung**

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false -p tsconfig.app.json
```

Erwartet: keine Ausgabe, Exit 0. (Das Modul ist noch von niemandem importiert — `tsconfig.app.json` schließt aber ganz `src` ein, also wird es trotzdem geprüft.)

- [ ] **Step 3: Committen**

```powershell
git add src/agent/health.ts
git commit -m "feat(agent): browser-side error collector"
```

---

## Task 8: Health-Check am Turn-Ende orchestrieren

**Files:**
- Create: `src/agent/verify.ts`

- [ ] **Step 1: Orchestrierung schreiben**

`src/agent/verify.ts`:

```ts
// The turn gate: after the agent wrote files, find out whether the app still
// works before telling the user "done". Three sources, cheapest first.

import { errorsSince, waitForHmr } from './health.ts'
import type { Problem } from './healthReport.ts'

interface ProbeResponse {
  failures?: { path: string; message: string }[]
}

interface TypecheckResponse {
  diagnostics?: { file: string; line: number; col: number; code: string; message: string }[]
}

export async function verifyApp(params: {
  turnStartedAt: number
  writtenPaths: string[]
}): Promise<Problem[]> {
  await waitForHmr()

  const problems: Problem[] = []

  // 1. Do the changed modules load at all?
  try {
    const res = await fetch('/api/health/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: params.writtenPaths }),
    })
    const body = (await res.json()) as ProbeResponse
    for (const failure of body.failures ?? []) {
      problems.push({ kind: 'probe', file: failure.path, message: failure.message })
    }
  } catch (err) {
    // An unreachable dev server is an infrastructure problem, not broken code.
    // Reporting it as breakage would roll back perfectly good changes.
    console.warn('[health] probe unreachable:', err)
  }

  // 2. Anything that blew up in the browser since this turn started.
  problems.push(...errorsSince(params.turnStartedAt))

  // 3. Type errors — slowest, and the only kind that never causes a rollback.
  try {
    const res = await fetch('/api/health/typecheck')
    const body = (await res.json()) as TypecheckResponse
    for (const d of body.diagnostics ?? []) {
      problems.push({
        kind: 'type',
        file: d.file,
        line: d.line,
        col: d.col,
        code: d.code,
        message: d.message,
      })
    }
  } catch (err) {
    console.warn('[health] typecheck unreachable:', err)
  }

  return problems
}

/** Ask the dev server to restore this turn's pre-write snapshot. */
export async function rollbackTurn(turnId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/git/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { snapshot?: string }
    return body.snapshot ?? null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Typprüfung**

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false -p tsconfig.app.json
```

Erwartet: keine Ausgabe, Exit 0.

- [ ] **Step 3: Committen**

```powershell
git add src/agent/verify.ts
git commit -m "feat(agent): turn-gate orchestration and rollback call"
```

---

## Task 9: Reparaturschleife in der Agent-Loop

**Files:**
- Modify: `src/agent/loop.ts` (komplett ersetzt)

- [ ] **Step 1: Loop neu schreiben**

`src/agent/loop.ts` vollständig ersetzen durch:

```ts
import { buildReport, isAppBroken, signatureOf } from './healthReport.ts'
import { streamChat } from './openrouter.ts'
import { executeTool, toolSchemas } from './tools.ts'
import type { ChatMessage } from './types.ts'
import { rollbackTurn, verifyApp } from './verify.ts'

const MAX_ITERATIONS = 20
const MAX_REPAIRS = 3

export type HealthStatus = 'checking' | 'ok' | 'repairing' | 'rolled-back' | 'gave-up'

export interface AgentCallbacks {
  /** A new assistant message started streaming; returns nothing. */
  onAssistantStart: (id: string) => void
  /** Streaming text delta for the assistant message with the given id. */
  onAssistantDelta: (id: string, delta: string) => void
  /** The assistant message finished (text is final). */
  onAssistantDone: (id: string) => void
  /** The model requested a tool call (before execution). */
  onToolCall: (id: string, name: string, args: string) => void
  /** A tool call finished executing. */
  onToolResult: (id: string, result: string, isError: boolean) => void
  /** The health check changed state; `id` is stable per check. */
  onHealth: (id: string, status: HealthStatus, text: string) => void
  /** The whole turn finished; totals summed across every model call. */
  onTurnUsage: (usd: number, tokens: number) => void
}

let idCounter = 0
const nextId = () => `m${Date.now()}_${idCounter++}`

/** Path of a successful write_file call, for the module probe. */
function writtenPath(argsJson: string): string | null {
  try {
    const { path } = JSON.parse(argsJson) as { path?: unknown }
    return typeof path === 'string' ? path : null
  } catch {
    return null
  }
}

/**
 * Run one full agent turn: repeatedly call the model, execute any requested
 * tools, and feed results back until the model answers with plain text AND the
 * app still works. Mutates `messages` in place (the wire-format history).
 */
export async function runAgentTurn(params: {
  model: string
  messages: ChatMessage[]
  turnId: string
  callbacks: AgentCallbacks
  signal?: AbortSignal
}): Promise<void> {
  const { model, messages, turnId, callbacks, signal } = params
  let totalCost = 0
  let totalTokens = 0

  const turnStartedAt = Date.now()
  const writtenPaths: string[] = []
  let repairs = 0
  let lastSignature = ''

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const assistantId = nextId()
    callbacks.onAssistantStart(assistantId)
    const { content, toolCalls, usage } = await streamChat({
      model,
      messages,
      tools: toolSchemas,
      signal,
      onDelta: (delta) => callbacks.onAssistantDelta(assistantId, delta),
    })
    callbacks.onAssistantDone(assistantId)
    totalCost += usage.cost
    totalTokens += usage.totalTokens

    messages.push({
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        callbacks.onToolCall(tc.id, tc.function.name, tc.function.arguments)
        const { result, isError } = await executeTool(
          tc.function.name,
          tc.function.arguments,
          turnId,
        )
        callbacks.onToolResult(tc.id, result, isError)
        if (tc.function.name === 'write_file' && !isError) {
          const path = writtenPath(tc.function.arguments)
          if (path && !writtenPaths.includes(path)) writtenPaths.push(path)
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: isError ? `ERROR: ${result}` : result,
        })
      }
      continue
    }

    // Plain answer. A turn that changed nothing needs no health check.
    if (writtenPaths.length === 0) {
      callbacks.onTurnUsage(totalCost, totalTokens)
      return
    }

    const healthId = `health_${turnId}_${repairs}`
    callbacks.onHealth(healthId, 'checking', 'Checking whether the app still works…')
    const problems = await verifyApp({ turnStartedAt, writtenPaths })

    if (problems.length === 0) {
      callbacks.onHealth(healthId, 'ok', 'App loads, no type errors.')
      callbacks.onTurnUsage(totalCost, totalTokens)
      return
    }

    const signature = signatureOf(problems)
    const stalled = signature === lastSignature
    lastSignature = signature
    repairs += 1

    const broken = isAppBroken(problems)
    const summary = problems
      .slice(0, 3)
      .map((p) => `${p.file ?? 'app'}: ${p.message}`)
      .join(' · ')

    if (repairs > MAX_REPAIRS || stalled) {
      if (broken) {
        const snapshot = await rollbackTurn(turnId)
        callbacks.onHealth(
          healthId,
          'rolled-back',
          stalled
            ? `The app stayed broken in the same way twice — changes rolled back${snapshot ? ` to ${snapshot}` : ''}. ${summary}`
            : `The app is still broken after ${MAX_REPAIRS} repair attempts — changes rolled back${snapshot ? ` to ${snapshot}` : ''}. ${summary}`,
        )
      } else {
        // Build-only errors never roll back: the app runs, npm run build does not.
        callbacks.onHealth(
          healthId,
          'gave-up',
          `The app runs, but type errors remain and were not fixed: ${summary}`,
        )
      }
      callbacks.onTurnUsage(totalCost, totalTokens)
      return
    }

    callbacks.onHealth(
      healthId,
      'repairing',
      `${broken ? 'App is broken' : 'Build is broken'} — repair attempt ${repairs} of ${MAX_REPAIRS}: ${summary}`,
    )
    messages.push({ role: 'user', content: buildReport(problems, repairs, MAX_REPAIRS) })
  }

  throw new Error(`Agent stopped after ${MAX_ITERATIONS} iterations without a final answer.`)
}
```

**Warum der Rollback-Fall nicht noch einmal das Modell fragt:** Der Spec (§6) sagt, der Agent solle den Rollback ehrlich melden. Die Meldung kommt hier deterministisch aus dem Code statt aus einem weiteren Modellaufruf — das kostet keine Tokens und das Modell kann den Rollback nicht beschönigen.

- [ ] **Step 2: Typprüfung — sie MUSS jetzt fehlschlagen**

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false -p tsconfig.app.json
```

Erwartet: Fehler in `src/chat/store.ts`, weil im `callbacks`-Objekt `onHealth` fehlt. Das ist der Übergang zu Task 10.

- [ ] **Step 3: Nicht committen**

Dieser Task lässt den Baum bewusst rot. Er wird zusammen mit Task 10 committet.

---

## Task 10: Health-Karten und Watchdog im Chat

**Files:**
- Modify: `src/agent/types.ts` (neue Transkript-Karte)
- Modify: `src/chat/store.ts` (Callback, Watchdog, Repair-Einstieg)
- Modify: `src/chat/MessageList.tsx` (Karte rendern)
- Modify: `src/chat/chat.css` (Stile)

- [ ] **Step 1: Transkript-Typ erweitern**

In `src/agent/types.ts` den `TranscriptItem`-Union ergänzen (vor `| { kind: 'cost'; … }`):

```ts
  | {
      kind: 'health'
      id: string
      status: 'checking' | 'ok' | 'repairing' | 'rolled-back' | 'gave-up'
      text: string
    }
  | { kind: 'broken'; id: string; text: string; prompt: string }
```

- [ ] **Step 2: Store erweitern**

In `src/chat/store.ts` die Imports ergänzen:

```ts
import { subscribe as subscribeHealth } from '../agent/health.ts'
import { signatureOf } from '../agent/healthReport.ts'
```

Die bestehende Zeile `import { runAgentTurn } from '../agent/loop.ts'` bleibt unverändert. **Importiere `HealthStatus` nicht** — der Typ wird in `store.ts` nirgends genannt, und `noUnusedLocals` macht aus einem ungenutzten Import einen harten Fehler.

Nach der `listeners`-Deklaration einfügen:

```ts
// --- watchdog state -------------------------------------------------------
// A crash right after a turn is unambiguously the agent's fresh damage and is
// repaired automatically. Later crashes only offer a button: no model call
// while the user is doing something else entirely.
const AUTO_REPAIR_WINDOW_MS = 30_000
const DEBOUNCE_MS = 1000

let lastModel = ''
let turnEndedAt = 0
let agentHasWritten = false
let autoRepairsInARow = 0
const handledSignatures = new Set<string>()
let debounceTimer: ReturnType<typeof setTimeout> | undefined
```

In `sendMessage` ganz am Anfang (nach der `busy`-Prüfung) ergänzen:

```ts
  lastModel = model
```

Im `callbacks`-Objekt von `runAgentTurn` ergänzen (nach `onToolResult`):

```ts
        onHealth: (id, status, text) => {
          if (status === 'repairing' || status === 'rolled-back' || status === 'gave-up') {
            agentHasWritten = true
          }
          const existing = state.transcript.find((it) => it.id === id)
          if (existing) {
            patchItem(id, { status, text } as Partial<TranscriptItem>)
            return
          }
          setState({ transcript: [...state.transcript, { kind: 'health', id, status, text }] })
        },
```

`HealthStatus` wird in der Signatur nicht explizit gebraucht, ist aber der Typ von `status` — der Import oben hält das dokumentiert. Im `finally`-Block von `sendMessage`, nach `await commitTurn(text)`:

```ts
    turnEndedAt = Date.now()
```

Am Dateiende ergänzen:

```ts
/** Start a repair turn for a problem the watchdog found after the turn ended. */
export function repairNow(prompt: string): void {
  if (state.busy || lastModel.length === 0) return
  void sendMessage(prompt, lastModel)
}

function watchdogPrompt(text: string): string {
  return [
    'AUTOMATIC WATCHDOG REPORT — this is not a user message.',
    'The app crashed in the browser after your last turn:',
    '',
    text,
    '',
    'Read the files you changed, find the cause and fix it with write_file.',
  ].join('\n')
}

subscribeHealth((problem) => {
  if (!agentHasWritten) return // nothing the agent did can be at fault yet
  const signature = signatureOf([problem])
  if (handledSignatures.has(signature)) return
  handledSignatures.add(signature)

  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (state.busy) return
    const where = problem.file ? `${problem.file}: ` : ''
    const text = `${where}${problem.message}`
    const fresh = Date.now() - turnEndedAt <= AUTO_REPAIR_WINDOW_MS

    if (fresh && autoRepairsInARow === 0) {
      autoRepairsInARow += 1
      setState({
        transcript: [
          ...state.transcript,
          {
            kind: 'health',
            id: `wd_${Date.now()}`,
            status: 'repairing',
            text: `App crashed after the turn — repairing automatically: ${text}`,
          },
        ],
      })
      repairNow(watchdogPrompt(text))
      return
    }

    // Too late, or the previous automatic repair already failed: ask first.
    setState({
      transcript: [
        ...state.transcript,
        {
          kind: 'broken',
          id: `wd_${Date.now()}`,
          text:
            autoRepairsInARow > 0
              ? `Still broken after an automatic repair: ${text} — you can retry, or restore an older state at /recovery.`
              : `The app is broken: ${text}`,
          prompt: watchdogPrompt(text),
        },
      ],
    })
  }, DEBOUNCE_MS)
})
```

Zusätzlich in `newChat()` den Watchdog zurücksetzen (vor `setState`):

```ts
  agentHasWritten = false
  autoRepairsInARow = 0
  handledSignatures.clear()
```

- [ ] **Step 3: Karten rendern**

In `src/chat/MessageList.tsx` den Import ergänzen:

```ts
import { repairNow } from './store.ts'
```

Und im `switch` vor `case 'cost':` einfügen:

```tsx
          case 'health':
            return (
              <div key={item.id} className={`msg-health msg-health-${item.status}`}>
                {item.status === 'checking' && '🔍 '}
                {item.status === 'ok' && '✓ '}
                {item.status === 'repairing' && '🔧 '}
                {item.status === 'rolled-back' && '⏪ '}
                {item.status === 'gave-up' && '⚠ '}
                {item.text}
              </div>
            )
          case 'broken':
            return (
              <div key={item.id} className="msg msg-broken">
                <span>⚠ {item.text}</span>
                <button className="repair-button" onClick={() => repairNow(item.prompt)}>
                  Repair
                </button>
              </div>
            )
```

- [ ] **Step 4: Stile ergänzen**

An `src/chat/chat.css` anhängen:

```css
.msg-health {
  align-self: stretch;
  font-size: 0.8rem;
  font-family: monospace;
  padding: 0.35rem 0.7rem;
  border-radius: 8px;
  color: #8c8c96;
  background: #1c1c22;
  border: 1px solid #2a2a32;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-health-ok {
  color: #7fae7f;
}

.msg-health-repairing {
  color: #d3b06a;
  border-color: #4a3c1d;
}

.msg-health-rolled-back,
.msg-health-gave-up {
  color: #f0a8a8;
  background: #3a1d1d;
  border-color: #6b2b2b;
}

.msg-broken {
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  background: #3a1d1d;
  color: #f0a8a8;
  border: 1px solid #6b2b2b;
  font-size: 0.9rem;
}

.repair-button {
  margin-left: auto;
  flex-shrink: 0;
  background: #6b2b2b;
  color: #ffe8e8;
  border: 1px solid #8b3b3b;
  border-radius: 6px;
  padding: 0.25rem 0.7rem;
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.repair-button:hover {
  background: #8b3b3b;
}
```

- [ ] **Step 5: Typprüfung und Lint**

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false -p tsconfig.app.json
npm run lint
```

Erwartet: beide ohne Fehler.

- [ ] **Step 6: Committen**

```powershell
git add src/agent/loop.ts src/agent/types.ts src/chat/store.ts src/chat/MessageList.tsx src/chat/chat.css
git commit -m "feat(chat): repair loop, health cards and watchdog"
```

---

## Task 11: ErrorBoundary, die den Chat am Leben hält

Ohne diesen Task ist der Rest wirkungslos: Heute rendert `App.tsx` den Chat **in sich** (`src/App.tsx:57`). Crasht App beim Rendern, stirbt der Chat mit — und ein Agent ohne Chat kann sich nicht korrigieren.

**Files:**
- Create: `src/chat/AppErrorBoundary.tsx`
- Modify: `src/main.tsx`

- [ ] **Step 1: Boundary schreiben**

`src/chat/AppErrorBoundary.tsx`:

```tsx
// Keeps the chat alive when the app crashes. App.tsx renders <Chat /> itself,
// so a render crash there would take the chat down with it — and an agent
// without a chat cannot correct itself. This fallback therefore shows the
// error AND mounts the chat directly, independent of App.tsx.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRenderError } from '../agent/health.ts'
import { Chat } from './Chat.tsx'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRenderError(error, info.componentStack ?? '')
  }

  componentDidMount(): void {
    // A fixed app arrives as an HMR update; drop the fallback so the user does
    // not have to reload to see the repair.
    import.meta.hot?.on('vite:afterUpdate', this.reset)
  }

  componentWillUnmount(): void {
    import.meta.hot?.off('vite:afterUpdate', this.reset)
  }

  reset = (): void => {
    if (this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="app-crash">
        <div className="app-crash-banner">
          <strong>The app crashed while rendering.</strong>
          <pre>{this.state.error.message}</pre>
          <span>
            The chat below still works — ask the agent to fix it, or restore an older state at{' '}
            <a href="/recovery">/recovery</a>.
          </span>
        </div>
        <Chat />
      </div>
    )
  }
}
```

- [ ] **Step 2: Stile anhängen**

An `src/chat/chat.css` anhängen:

```css
.app-crash {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #18181c;
}

.app-crash-banner {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem 1.2rem;
  background: #3a1d1d;
  color: #f0a8a8;
  border-bottom: 1px solid #6b2b2b;
  font-size: 0.9rem;
}

.app-crash-banner pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8rem;
  color: #ffd0d0;
}

.app-crash-banner a {
  color: #ffd0d0;
}
```

- [ ] **Step 3: main.tsx umbauen**

`src/main.tsx` vollständig ersetzen durch:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './chat/AppErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
```

- [ ] **Step 4: Crash manuell auslösen**

Dev-Server läuft, Browser auf http://localhost:5173.

```powershell
Copy-Item src/components/HelloWorld.tsx "$env:TEMP/HelloWorld.backup.tsx"
'export function HelloWorld() {' + [char]10 + '  const items = undefined as unknown as string[]' + [char]10 + '  return <div>{items.map((i) => i)}</div>' + [char]10 + '}' | Out-File -Encoding utf8 src/components/HelloWorld.tsx
```

Erwartet im Browser: rotes Banner mit `Cannot read properties of undefined (reading 'map')` und **darunter der funktionsfähige Chat** — Verlauf und Kostenanzeige unverändert.

- [ ] **Step 5: Reparatur ohne Reload prüfen**

```powershell
Copy-Item "$env:TEMP/HelloWorld.backup.tsx" src/components/HelloWorld.tsx -Force
git status --porcelain
```

Erwartet: Das Banner verschwindet von selbst, die App erscheint wieder — ohne manuellen Reload. `git status` ist sauber.

- [ ] **Step 6: Committen**

```powershell
git add src/chat/AppErrorBoundary.tsx src/chat/chat.css src/main.tsx
git commit -m "feat(chat): error boundary that keeps the chat alive on a crash"
```

---

## Task 12: Systemprompt, README und Abnahme

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Modify: `README.md`

- [ ] **Step 1: Systemprompt erweitern**

In `src/agent/systemPrompt.ts` die Regeln 6 und 7 ersetzen durch:

```
6. Before the first write of each of your turns, the server automatically commits a git snapshot, so the user can roll back your changes.
7. write_file rejects files that do not parse — you get the syntax error with line and column, and NOTHING is written. Send the complete corrected file.
8. After your final answer the dev server checks the app automatically: it loads every module you changed, collects runtime errors from the browser and runs a full type check. If something is broken you get an AUTOMATIC HEALTH CHECK message and must fix it — you have 3 attempts, after which your changes are rolled back to the snapshot. Messages marked AUTOMATIC are from the dev server, not from the user.
9. After making changes, briefly summarize what you changed and where the user can see it.
```

- [ ] **Step 2: README erweitern**

In `README.md` im Abschnitt `## Safety` nach dem Punkt „Git snapshots" ergänzen:

```markdown
- **Self-healing:** `write_file` rejects code that does not parse. After the
  agent's final answer the dev server probes every changed module
  (`/api/health/probe`), collects browser runtime errors and runs `tsc --noEmit`
  (`/api/health/typecheck`). Problems are fed back into the same turn — three
  repair attempts, then an automatic rollback to the turn's snapshot
  (`/api/git/rollback`). A crash within 30 s after a turn is repaired
  automatically; later ones offer a "Repair" button in the chat.
- **The chat survives a crash:** `AppErrorBoundary` mounts the chat next to the
  error, so the agent stays reachable even when `App.tsx` crashes while
  rendering.
```

- [ ] **Step 3: Alle Tests und Prüfungen**

```powershell
npm test
node node_modules/typescript/bin/tsc --noEmit --pretty false -p tsconfig.app.json
npm run lint
npm run build
```

Erwartet: `# fail 0`; tsc ohne Ausgabe; Lint ohne Fehler; Build erfolgreich.

- [ ] **Step 4: Szenarien 1–5 im laufenden Chat durchspielen**

Dev-Server läuft, Browser offen. Jeweils im Chat eingeben:

1. **Syntax-Gate:** „Schreibe in src/components/Test1.tsx eine Komponente, aber lass absichtlich eine schließende Klammer weg." → Der `write_file`-Tool-Call schlägt mit `Syntax error … (line …, column …)` fehl, der Agent korrigiert sich in der nächsten Iteration. Datei landet korrekt oder gar nicht.
2. **Render-Crash:** „Ändere src/components/HelloWorld.tsx so, dass es `undefined.map()` aufruft." → Rotes Banner, Chat lebt, Health-Karte `🔧 App is broken — repair attempt 1 of 3`, danach `✓`.
3. **Fehlender Import:** „Importiere in src/App.tsx eine Komponente aus ./components/GibtEsNicht.tsx." → Health-Karte mit `Failed to resolve import`.
4. **Rollback:** Szenario 2 wiederholen, aber im Model-Picker ein schwaches Modell wählen, das die Reparatur nicht schafft → nach 3 Versuchen (oder bei zweimal identischer Signatur) Karte `⏪ … rolled back to <hash>`; die Datei ist wieder im Ausgangszustand (`git log --oneline -3` zeigt den Rollback-Commit).
5. **Nur Typfehler:** „Füge in src/components/TodoList.tsx einen ungenutzten Import ein." → Health-Karte meldet `TS6133`, **kein** Rollback, Änderung bleibt stehen.

- [ ] **Step 5: Szenarien 6–11 durchspielen**

6. **Stillstand:** Während einer laufenden Reparatur zusätzlich eine zweite Datei von Hand kaputtmachen, die der Agent nicht anfasst → gleiche Signatur zweimal → vorzeitiger Abbruch ohne dritten Versuch.
7. **Watchdog automatisch:** Direkt nach einem erfolgreichen Turn von Hand `src/components/Calendar.tsx` kaputtmachen (innerhalb 30 s) → automatischer Reparatur-Turn startet ohne Zutun.
8. **Watchdog später:** Zwei Minuten warten, dann kaputtmachen und im Browser auf die betroffene Seite navigieren → Karte mit `Repair`-Button, **kein** automatischer Modellaufruf.
9. **Watchdog scheitert:** Nach einem fehlgeschlagenen Auto-Reparatur-Turn erneut crashen lassen → kein zweiter Auto-Turn, Hinweis auf `/recovery`.
10. **Normalbetrieb:** „Was macht src/App.tsx?" (keine Writes) → kein Health-Check, keine Verzögerung. Danach eine kleine Änderung → Turn endet rund 3 s später als zuvor.
11. **Nur Build kaputt:** Siehe Szenario 5 — Änderungen bleiben, Agent benennt den offenen Build-Fehler.

- [ ] **Step 6: Committen**

```powershell
git add src/agent/systemPrompt.ts README.md
git commit -m "docs: document the self-healing loop in prompt and README"
```

---

## Abschluss

Nach Task 12 ist der Spec vollständig umgesetzt. Offen bleibt bewusst die im Spec (§8) benannte Grenze: Erzwingt Vite einen Full-Reload und ein Modul kompiliert nicht, stirbt die Seite samt Chat. Das Syntax-Gate macht diesen Fall unwahrscheinlich, `/recovery` bleibt die letzte Instanz.
