# ai-react: Funktionale Spezifikation v2

Stand: 2026-10-01, extrahiert aus dem Code in `ai_react/` (Commit `15a1988`).

Zweck: Aus diesem Dokument und den Unit-Tests in `tests/` soll eine fähige KI
die Anwendung mit **gleichem Verhalten** neu bauen können.

Änderungen gegenüber v1: v1 wurde in einem Nachbau-Experiment geprüft
(Branch `rebuild/spec-test`). Der Nachbau meldete 31 Lücken. v2 schließt sie
mit dem Verhalten des Originals: Modulstruktur und Exporte (Anhang A),
Systemprompt und Tool-Schemas wörtlich (Anhang B), Konfigurationsdateien
wörtlich (Anhang C), alle Fehler- und UI-Texte, Grenzfälle. Abschnitt 14
listet Fehler im Original, über die noch entschieden werden muss. Anhang D
ordnet die 31 Lücken den Abschnitten zu.

Konventionen:
- Texte in `"…"` oder in Codeblöcken sind **wörtlich** zu übernehmen.
  Platzhalter stehen in `<…>`.
- Wo ein Grenzfall „undefiniert“ heißt, verhält sich auch das Original
  zufällig. Die Neuimplementierung darf dort frei entscheiden.
- Steht bei einem Verhalten **[E<n>]**, ist es ein bekannter Fehler im
  Original. Bis zur Entscheidung (Abschnitt 14) gilt das Originalverhalten.
- Logzeilen auf der Server-Konsole (`HH:MM:SS [agent] <text>`, Zeit
  `en-GB` 24 h) gehören zum Verhalten, ihr Wortlaut ist aber frei.

---

## 1. Überblick

ai-react ist eine Vite-8-/React-19-/TypeScript-App. Ihre Hauptseite ist ein
Chat mit einem Coding-Agenten (LLM über OpenRouter). Der Agent liest und
schreibt die Quelldateien **derselben App**; Vite-HMR zeigt Änderungen sofort
im Browser. Zusätzlich kann der Agent Backend-Services als eigene
Node-Prozesse anlegen und starten.

| Baustein | Ort | Läuft in |
|---|---|---|
| Dev-Server-Plugin (API, Proxy, Sandbox, Git) | `server/agentPlugin.ts` | Node (Vite-Dev-Server) |
| Service-Supervisor | `server/services/*` | Node |
| Agent-Loop, Tools, Health-Check | `src/agent/*` | Browser |
| Chat-UI, Store, Watchdog, ErrorBoundary | `src/chat/*` | Browser |
| Recovery-Seite | `server/recoveryPage.ts` | statisches HTML vom Dev-Server |
| Demo-Seiten | `src/components/*`, `services/notes-api` | Browser / Service |

Der Agent existiert nur im Dev-Modus (`npm run dev`). Ein Production-Build
enthält kein Backend. Die vollständige Dateiliste mit Exporten steht in
Anhang A.

### 1.1 Technische Rahmenbedingungen

- Node 22.x (getestet mit 22.14). Nötig sind das Permission-Model und
  `--experimental-strip-types`.
- Exakte Paketversionen (aus `package-lock.json`): react 19.2.8,
  react-dom 19.2.8, vite 8.2.2, @vitejs/plugin-react 6.1.1,
  typescript 6.0.3, oxlint 1.81.0, @openrouter/sdk 1.2.136,
  @types/node 24.13.3, @types/react 19.2.18, @types/react-dom 19.2.7.
  `package.json` (Anhang C) nennt die Bereiche.
- Git muss im Projektverzeichnis verfügbar sein. Das Projekt darf in einem
  Unterverzeichnis eines größeren Repos liegen; alle git-Befehle laufen mit
  `cwd = Projektwurzel`.
- Konfiguration über `.env` im Projektverzeichnis: `OPENROUTER_API_KEY`
  (Pflicht für den Chat), optional `VITE_MS_OUTLOOK_CLIENT_ID`,
  `VITE_MS_OUTLOOK_TENANT_ID`, `VITE_MS_OUTLOOK_REDIRECT_URI`.
  Der Server liest den Key mit Vites `loadEnv(mode, root, '')`.
- `tsc -b` prüft zwei Projekte: `tsconfig.app.json` (nur `src`) und
  `tsconfig.node.json` (`vite.config.ts`, `server`, `scripts`). `tests/` und
  `services/` werden **nicht** typgeprüft. Wegen `erasableSyntaxOnly` und
  `verbatimModuleSyntax` sind keine Enums, keine Namespaces und keine
  Parameter-Properties erlaubt. Typ-Importe stehen mit `import type`.
- `npm run lint` mit der `.oxlintrc.json` aus Anhang C liefert im Original
  nur Warnungen (`set-state-in-effect`, `preserve-manual-memoization`),
  keine Fehler. Das gilt als sauber.
- Imports zwischen Quelldateien verwenden die Endung `.ts`/`.tsx`
  (`allowImportingTsExtensions`).

---

## 2. Sandbox: Dateizugriff des Agenten

Projektwurzel = Vite-`config.root`, mit `path.resolve` auf native Trenner
normalisiert (Vite liefert unter Windows `/`-Pfade).

### 2.1 Pfadauflösung `safeResolve(root, relPath)`

1. Kein String oder leer → abgelehnt.
2. `abs = path.resolve(root, relPath)`. Absolute Pfade sind damit erlaubt,
   **sofern sie in der Wurzel liegen**.
3. `abs` muss `root` selbst sein oder mit `root + path.sep` beginnen,
   sonst abgelehnt.
4. Ein Segment von `path.relative(root, abs)` ist exakt (case-sensitiv)
   einer von `node_modules`, `.git`, `dist`, `.idea`, `.junie` → abgelehnt.
5. Der **letzte** Segmentname passt auf `/^\.env/i` oder
   `/^package-lock\.json$/i` → abgelehnt. Damit ist auch `.env.example`
   für den Agenten unsichtbar.

`path: "."` ergibt die Wurzel selbst. Lesen schlägt dann fehl (404).

### 2.2 Listing

`list_files` geht rekursiv ab der Wurzel. Einträge, deren Name exakt einer der
Verzeichnisnamen aus 2.1 Punkt 4 ist, werden übersprungen. Ebenso Einträge,
deren Name auf eines der Muster aus Punkt 5 passt, und zwar auf jeder Ebene,
für Dateien und Verzeichnisse. Ausgabe: Pfade relativ zur Wurzel mit `/`;
ein Verzeichnis steht vor seinem Inhalt; Reihenfolge wie `fs.readdir`.
Symlinks und andere Nicht-Datei-Einträge erscheinen nicht.

### 2.3 Schreibschutz (lesbar, nicht schreib- oder löschbar)

Geprüft auf `path.relative(root, abs)` mit `/`-Trennern, case-sensitiv:

- Verzeichnisse (sie selbst und alles darunter): `server`, `src/agent`,
  `src/chat`, `tests`.
- Dateien: `vite.config.ts`, `src/main.tsx`, `index.html`, `package.json`,
  `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`.
- Muster: `/^services\/[^/]+\/service\.json$/`,
  `/^services\/[^/]+\/package\.json$/`.

Begründung (muss erhalten bleiben): Der Agent darf seine eigene Laufzeit, die
Sandbox und die Service-Manifeste nicht verändern. Weil `src/chat` und
`src/agent` nie von HMR invalidiert werden, überlebt ein laufender Agent-Turn
jede Änderung des Agenten an `App.tsx`.

### 2.4 Syntax-Gate `checkSyntax(relPath, content): string | null`

Nur für Pfade, die auf `/\.(ts|tsx|js|jsx|mts|cts)$/i` passen; sonst `null`.
Prüfung mit `ts.transpileModule(content, { reportDiagnostics: true,
fileName: relPath, compilerOptions: { jsx: ReactJSX, target: ESNext,
module: ESNext } })`. Ohne Diagnose `null`. Sonst wird nur die erste Diagnose
ausgewertet, die Nachricht mit `ts.flattenDiagnosticMessageText(msg, ' ')`
geglättet:

- mit Position: `"Syntax error in <relPath> (line <L>, column <C>): <msg>"`
  (beides 1-basiert, Spalte = Länge der Zeile bis zur Position + 1)
- ohne Position: `"Syntax error in <relPath>: <msg>"`

Typfehler werden hier nicht geprüft (`const x: number = 'a'` ist erlaubt).
Den Zusatz für die HTTP-Antwort hängt erst der Server an (3.2).

---

## 3. Dev-Server-HTTP-API

### 3.1 Routing (in dieser Reihenfolge, Query-String abgeschnitten)

1. `GET /recovery` → HTML-Seite (3.7).
2. Pfad beginnt mit `/svc/` oder `/api/services` → Service-Routen (4.5, 4.6).
   Achtung: Das ist ein reiner Präfix-Test, auch `/api/servicesX` landet hier
   und bekommt dort 404.
3. Pfad beginnt nicht mit `/api/` → weiter an Vite.
4. Sonst die Routen dieses Abschnitts. Unbekannt → 404
   `{"error":"Unknown API route: <METHOD> <url>"}`.

Antworten sind JSON (`Content-Type: application/json`), außer `/recovery` und
dem Chat-Stream. Jede nicht abgefangene Exception, **auch ungültiges JSON im
Request-Body**, ergibt 500 `{"error": String(err)}`, z. B.
`"SyntaxError: Unexpected token …"`. Bodies haben keine Größenbegrenzung.

### 3.2 `POST /api/chat`: OpenRouter-Proxy

- Ohne API-Key: 500
  `{"error":"OPENROUTER_API_KEY is not set. Create a .env.example file (see .env.example) and restart the dev server."}`
  **[E4]**. Kein Upstream-Aufruf.
- Sonst wird der Body unverändert an
  `https://openrouter.ai/api/v1/chat/completions` gesendet, mit den Headern
  `Authorization: Bearer <key>`, `Content-Type: application/json`,
  `HTTP-Referer: http://localhost:5173`,
  `X-Title: ai-react internal coding agent`.
- Statuscode und `Content-Type` des Upstreams (Fallback `application/json`)
  werden übernommen, der Body chunkweise durchgereicht. Der Key verlässt den
  Server nie.

### 3.3 Dateisystem

| Route | Request | Erfolg | Fehler |
|---|---|---|---|
| `GET /api/fs/list` | – | 200 `{entries:[{path,type:"file"\|"dir"}]}` | – |
| `POST /api/fs/read` | `{path}` | 200 `{content}` (UTF-8) | 403 `Path not allowed: <path>`; 404 `File not found: <path>` (auch bei Verzeichnis oder Lesefehler) |
| `POST /api/fs/write` | `{path, content, turnId?}` | 200 `{ok:true, snapshot}` | siehe unten |
| `POST /api/fs/delete` | `{path, turnId?}` | 200 `{ok:true, snapshot}` | 403 `Path not allowed: <path>`; 403 `Path is read-only: <path>`; 404 `File not found: <path>` |

`write` prüft in dieser Reihenfolge:
1. Sandbox → 403 `Path not allowed: <path>`
2. Schreibschutz → 403 `Path is read-only (agent runtime is protected): <path>`
3. `content` kein String → 400 `content must be a string`
4. Syntax → 422 `<checkSyntax-Text> — nothing was written. Send the COMPLETE corrected file content in a new write_file call.`
   (gilt für beide Varianten aus 2.4)
5. Snapshot (3.4)
6. `mkdir -p` des Elternverzeichnisses, Datei schreiben (UTF-8).

`delete` prüft Sandbox → Schreibschutz → Snapshot → `fs.rm(abs,
{recursive:false, force:false})`. Schlägt `rm` fehl (fehlt, ist
Verzeichnis), kommt 404. Der Snapshot ist dann trotzdem schon passiert.

### 3.4 Snapshot-Regel (pro Turn genau einmal)

Der Server hält im Speicher `lastSnapshotTurn` (String) und
`lastSnapshot: {turnId, hash} | null`. Nach einem Neustart sind beide leer.

Trägt ein write oder delete eine String-`turnId`, die ungleich
`lastSnapshotTurn` ist:

1. `lastSnapshotTurn = turnId`.
2. `gitCommitAll("agent snapshot (pre-modification)")`, siehe unten.
3. Anker = zurückgegebener Hash, **sonst aktueller HEAD** (`git rev-parse
   --short HEAD`). Ein sauberer Arbeitsbaum ist der Normalfall; ohne diese
   Regel gäbe es keinen Anker.
4. `lastSnapshot = {turnId, hash: Anker}`, oder `null`, wenn auch HEAD fehlt.

`snapshot` in der Antwort ist nur gesetzt, wenn wirklich ein Commit entstand.

`gitCommitAll(message)`:
- `git add -A`
- `git status --porcelain`; leer → `null`
- sonst `git commit -m <message> --no-verify --author "ai agent <agent@ai-react.local>"`
- Rückgabe: `git rev-parse --short HEAD`

Jeder git-Fehler wird geloggt und ergibt `null`.

Alle Hashes, die die API liefert, sind **Kurz-Hashes** (`--short` bzw. `%h`).

### 3.5 Health

`POST /api/health/probe` `{paths}`:
- Antwort 200 `{failures:[{path,message}]}`.
- Nicht-String-Einträge in `paths` werden verworfen. Ist `paths` kein Array,
  gilt es als leer.
- Ziele = `["src/App.tsx", ...paths]` ohne Duplikate, in dieser Reihenfolge.
  Es gibt keinen Filter nach Dateityp.
- Pro Ziel: `url = "/" + pfad` (führende `/` entfernt). Modul im Client-Graph
  suchen (`server.environments.client.moduleGraph.getModuleByUrl`) und, falls
  vorhanden, invalidieren. Danach `environments.client.transformRequest(url)`.
- Jede Exception ist ein Fehler. Die Nachricht wird von ANSI-Farbcodes
  befreit, Whitespace auf ein Leerzeichen zusammengezogen, getrimmt und auf
  400 Zeichen gekürzt.

Warum im Server: Im Browser wäre ein kaputtes Modul nur ein leerer 500, und
eine fehlende Datei liefert dort die SPA-Seite mit 200. Was `transformRequest`
mit Nicht-Modulen wie `.md` macht, ist undefiniert.

`GET /api/health/typecheck` → 200 `{diagnostics:[{file,line,col,code,message}]}`:
- Befehl: `<node> <root>/node_modules/typescript/bin/tsc --noEmit --incremental --pretty false -p tsconfig.app.json`
  mit `cwd = root` und `maxBuffer` 8 MiB.
- Exit 0 → `[]`.
- Sonst wird stdout zeilenweise gegen
  `/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/` geprüft (Zeile
  getrimmt, `\r?\n` als Trenner). Im Dateipfad werden `\` zu `/`. Andere
  Zeilen werden ignoriert.
- Exit ≠ 0 ohne Treffer → genau
  `{file:"tsconfig.app.json", line:0, col:0, code:"TSC", message:"tsc could not run: <err.message, gekürzt auf 200 Zeichen>"}`.
- Gleichzeitige Aufrufe teilen sich einen laufenden tsc-Prozess.

### 3.6 Git

**`POST /api/git/commit`** `{message}` → 200 `{committed: hash|null}`.
Die Nachricht wird getrimmt; ist sie leer oder kein String, wird
`"agent turn"` verwendet. Commit über `gitCommitAll`.

**`GET /api/git/log`** → 200 `{commits:[{hash, date, message, kind}]}`:
- Befehl: `git log -n 200 --pretty=format:%h%x1f%ae%x1f%ct%x1f%B%x1e`.
  Datensätze an `\x1e` trennen, führenden Whitespace entfernen, leere
  verwerfen, Felder an `\x1f` trennen.
- `date` = Unix-Sekunden als Zahl, `message` = voller Text, getrimmt.
- `kind`: `"snapshot"`, wenn die Nachricht exakt
  `agent snapshot (pre-modification)` ist; sonst `"agent"`, wenn die
  Autor-Mail `agent@ai-react.local` ist; sonst `"user"`.
- Fehler → 500 `git log failed: <err>`.

**`POST /api/git/restore`** `{hash}`:
1. `hash` kein String oder passt nicht auf `/^[0-9a-f]{4,40}$/i` → 400
   `hash must be a (abbreviated) commit hash`.
2. `git rev-parse --verify <hash>^{commit}` schlägt fehl → 404
   `Unknown commit: <hash>`.
3. `gitCommitAll(SNAPSHOT_MESSAGE)` sichert offene Änderungen.
4. Tree von HEAD gleich Tree von `<hash>` → 200 `{ok:true, restored:null}`.
5. `git read-tree --reset -u <hash>`, danach
   `gitCommitAll("restore project state of <hash>")` → 200
   `{ok:true, restored:<hash|null>}`.

Fehler in 3–5 → 500 `git restore failed: <err>`. Die Historie wird nie
umgeschrieben. Services werden danach **nicht** abgeglichen (kein Reconcile).

**`POST /api/git/rollback`** `{turnId}`:
1. `lastSnapshot` fehlt oder `lastSnapshot.turnId !== turnId` → 409
   `No snapshot exists for this turn — nothing to roll back.`
2. `gitCommitAll(SNAPSHOT_MESSAGE)`: Der kaputte Stand bleibt in der Historie.
3. `git read-tree --reset -u <anker>`.
4. `restored = gitCommitAll("rollback of broken agent changes (state of <anker>)")`.
5. Supervisor-Reconcile (4.4). Es stoppt Services, deren Manifest durch den
   Rollback verschwunden ist.
6. 200 `{ok:true, snapshot:<anker>, restored}`.

Fehler → 500 `git rollback failed: <err>`.

**`POST /api/git/forget`** `{hash}`:
1. `head = git rev-parse --short HEAD`.
2. `hash !== head` (exakter Stringvergleich; ein voller Hash wird also
   abgelehnt) → 409 `Only the newest commit (<head>) can be removed from history.`
3. `git status --porcelain` nicht leer (auch ungetrackte Dateien) → 409
   `The working tree has uncommitted changes that would be lost. Commit or discard them first.`
4. `HEAD^` existiert nicht → 409 `Cannot remove the initial commit.`
5. `git reset --hard HEAD~1` → 200 `{ok:true}`.

Andere Fehler → 500 `git reset failed: <err>`.

### 3.7 `GET /recovery`

`200 text/html; charset=utf-8`. Eine eigenständige Seite: Markup, CSS und JS
sind inline, sie hängt weder von der React-App noch von Dateien ab, die der
Agent schreiben kann.

- Titel `Recovery — ai-react`, `<h1>Recovery</h1>`.
- Intro:
  `This page is served directly by the dev server and works even when the app itself is broken. Restoring creates a new commit with the selected commit's project state — nothing is deleted from history.`
- Toolbar mit Button `Refresh` und Statuszeile.
- Liste aus `/api/git/log`. Pro Commit: Nachricht (pre-wrap), Hash als
  `<code>`, Datum
  `new Date(s*1000).toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})`
  (Browser-Locale), ein Badge mit `kind`, falls nicht `user`, und rechts ein
  Button `RESTORE`. Snapshot-Zeilen haben einen dunkleren Hintergrund.
- Klick auf RESTORE fragt per `confirm`:
  `Restore the project state of commit <hash> ("<erste Zeile>")?\n\nCurrent uncommitted changes are saved as a snapshot first, then the restored state is committed on top. Nothing is deleted from history.`
  Danach Status `Restoring <hash> …` und POST `/api/git/restore`.
- Ergebnis (grün): `Restored state of <hash> as commit <restored>.` bzw.
  `Project already matches commit <hash> — nothing to do.`
- Fehler (rot): `body.error` oder `HTTP <status>`.
- Danach wird die Liste immer neu geladen. Solange eine Wiederherstellung
  läuft, sind weitere RESTORE-Klicks wirkungslos.
- Ein Ladefehler der Liste erscheint als Status (rot). Ein erfolgreiches
  Laden leert den Status, solange nichts läuft.
- Dunkles Farbschema (`color-scheme: dark`, Hintergrund `#1a1a1a`, max.
  Breite 760 px).

---

## 4. Backend-Services

### 4.1 Manifest `services/<name>/service.json` (server-eigen)

```json
{
  "name": "notes-api",
  "kind": "process",
  "entry": "index.ts",
  "port": 4001,
  "env": {},
  "enabled": true,
  "health": {
    "path": "/health",
    "timeoutMs": 10000
  }
}
```

`buildManifest(input, port)` prüft in dieser Reihenfolge und wirft beim
ersten Fehler einen `ManifestError` mit genau diesem Text:

| Prüfung | Text |
|---|---|
| `port` keine Ganzzahl 1–65535 | `Invalid port <String(port)>.` |
| `name` kein String, Länge nicht 3–32 oder passt nicht auf `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` | `Invalid service name <JSON.stringify(name)> — use 3 to 32 characters: lowercase letters, digits and single dashes, starting with a letter.` |
| `kind !== "process"` | `Invalid kind <JSON> — only "process" is supported.` |
| `entry` passt nicht auf `/^[A-Za-z0-9_-]+\.(ts\|js\|mjs)$/` | `Invalid entry <JSON> — a single file name inside the service directory, such as "index.ts". Sub-paths are not allowed.` |
| `env` ist undefined oder null | → `{}` |
| `env` kein Objekt oder ein Array | `env must be an object mapping UPPER_SNAKE_CASE keys to strings.` |
| Schlüssel passt nicht auf `/^[A-Z][A-Z0-9_]*$/` | `Invalid env key <JSON> — use UPPER_SNAKE_CASE.` |
| Schlüssel passt auf `/^(NODE_\|PORT$\|ELECTRON_)/` | `env key <KEY> is reserved and cannot be set by a service.` |
| Wert kein String | `env.<KEY> must be a string.` |
| `health` ist undefined oder null | → `{path:"/health", timeoutMs:10000}` |
| `health` kein Objekt oder ein Array | `health must be an object with "path" and optional "timeoutMs".` |
| `health.path` kein String oder beginnt nicht mit `/` | `Invalid health.path <JSON> — must start with "/".` |
| `timeoutMs` gesetzt, aber keine Zahl in 500–120000 | `health.timeoutMs must be a number between 500 and 120000.` |

`enabled` ist im Ergebnis immer `true`. `timeoutMs` fehlt → 10000.
Das Ergebnis enthält genau die Felder in der Reihenfolge des Beispiels oben.

Weitere Funktionen:
- `serialiseManifest(m)` = `JSON.stringify(m, null, 2) + "\n"`.
- `parseManifest(json)`:
  - Kein gültiges JSON → `Manifest is not valid JSON.`
  - Kein Objekt oder `null` → `Manifest must be an object.`
  - `port` keine Ganzzahl → `Manifest has no valid port.`
  - Sonst `buildManifest(o, o.port)`, anschließend
    `enabled = (o.enabled !== false)`.
- `listManifests(root)`:
  - Fehlt `services/`, ist das Ergebnis leer.
  - Pro Unterverzeichnis wird `service.json` gelesen. Ein Verzeichnis ohne
    die Datei wird still übersprungen.
  - Ein ungültiges Manifest wird mit `console.warn` übersprungen, ohne
    Exception.
- `serviceDir(root, name)` validiert den Namen und liefert
  `<root>/services/<name>`.

### 4.2 Port-Vergabe

`PROCESS_PORTS = {from: 4001, to: 4099}`.

`allocatePort(taken, range = PROCESS_PORTS)` liefert den niedrigsten Port, der
nicht in `taken` steht und für den `isPortFree(port)` true ergibt. `isPortFree`
versucht, einen TCP-Server auf `127.0.0.1:<port>` zu öffnen, und schließt ihn
sofort wieder. Ist kein Port frei, kommt
`No free port in range <from>-<to>. Remove an unused service and try again.`

### 4.3 Prozessstart (Sandbox)

`spawnArgsFor(root, m)` → `{cwd, args, env}`:

```
cwd  = <root>/services/<name>
args = [ "--permission",
         "--allow-fs-read=<cwd>", "--allow-fs-write=<cwd>",
         "--allow-fs-read=<root>/node_modules",
         "--disable-warning=ExperimentalWarning",
         "--experimental-strip-types",
         <entry> ]
env  = { PATH: process.env.PATH ?? "",
         SystemRoot: process.env.SystemRoot   (nur wenn gesetzt),
         ...m.env,
         PORT: String(m.port) }
```

Gestartet wird `spawn(process.execPath, args, {cwd, env, windowsHide:true})`.
Es gibt **kein** `--allow-net`, denn Node 22 bricht damit ab. Netzwerk ist
erlaubt. Lesen außerhalb, Schreiben außerhalb und Kindprozesse scheitern mit
`ERR_ACCESS_DENIED`.

Log-Puffer `createLogBuffer(max = 200)`:
- `push(chunk)` hängt den Chunk an die gehaltene Teilzeile an und trennt an
  `\n`. Der letzte Teil bleibt als neue Teilzeile stehen. Bei jeder
  vollständigen Zeile wird ein `\r` am Ende entfernt; wird `max`
  überschritten, fällt die älteste Zeile weg.
- `tail(n)` liefert die letzten n Zeilen inklusive einer nicht leeren
  Teilzeile, verbunden mit `\n`.
- `clear()` leert Zeilen und Teilzeile.

Jeder Start legt einen neuen Puffer an. stdout und stderr fließen beide
hinein.

Zustände (`RunInfo`): `{state: "stopped"|"starting"|"ready"|"crashed", pid?, startedAt?, exitCode?, lastLogs?}`.

`start(m)`:
1. Gibt es einen Eintrag mit Zustand `starting` oder `ready`, passiert nichts.
2. Sonst wird der Prozess gestartet. Zustand
   `{state:"starting", pid, startedAt: Date.now()}`.
3. Prozess-`exit`, wenn der Zustand nicht `stopped` ist → `crashed` mit
   `exitCode` und `lastLogs = tail(10)`.
4. Readiness: Solange die Frist (`health.timeoutMs`) läuft, wird geprüft, ob
   der Prozess lebt. Lebt er nicht → Grund `the process exited during startup`.
   Sonst `fetch("http://127.0.0.1:<port><health.path>")` ohne eigenes Timeout;
   ein `res.ok` bedeutet bereit. Danach 250 ms warten. Frist abgelaufen →
   Grund `<url> did not answer within <timeoutMs> ms`.
5. Bei einem Grund: Zustand `crashed`, `exitCode` = aktueller Exit-Code
   (meist `null`), `lastLogs = "<Grund>\n<tail(10)>"`. Danach wird geworfen:
   `Service "<name>" did not become ready: <Grund>\n<tail(10)>`.
   Der Prozess wird dabei **nicht** beendet **[E5]**.
6. Sonst Zustand `ready`.

`stop(m)`: Ohne Eintrag passiert nichts. Sonst wird zuerst der Zustand auf
`stopped` gesetzt, dann der Prozessbaum beendet und der Eintrag gelöscht
(danach liefern `status` → `{state:"stopped"}` und `logs` → `""`).
Prozessbaum beenden:
- Windows: `taskkill /PID <pid> /T /F`, warten auf dessen Ende.
- Sonst: `SIGTERM`, alle 100 ms bis 5 s auf Exit prüfen, danach `SIGKILL`.
- Bereits beendete Prozesse werden übersprungen.

`running()` liefert die Namen aller Einträge in `starting` oder `ready`.
`stopAll()` beendet alle Einträge.

### 4.4 Supervisor

`createSupervisor(root)` liefert ein Objekt mit:

- **create(input)**:
  1. Name validieren (4.1).
  2. Existiert der Name schon →
     `A service named "<n>" already exists. Existing services: <a, b>.`
  3. Port aus den Ports aller Manifeste vergeben, `buildManifest`, speichern.
  4. Zusätzlich `services/<n>/package.json` =
     `{\n  "type": "module"\n}\n` schreiben.
  5. Rückgabe ist das Manifest.
- **control(name, action)**:
  - Unbekannter Name → `Unknown service "<name>".`; ein ungültiger Name
    liefert vorher den Namensfehler.
  - `stop`: stoppen, Manifest mit `enabled:false` speichern.
  - `start`: Manifest mit `enabled:true` speichern, dann `start`. Ein Fehler
    wird weitergeworfen; das Manifest bleibt dabei `enabled:true`.
  - `restart`: stoppen, danach wie `start`.
  - Rückgabe ist der Status.
- **remove(name)**: stoppen, dann
  `fs.rm(serviceDir, {recursive:true, force:true})`.
- **status()**: pro Manifest
  `{...RunInfo, name, kind, port, enabled, url:"/svc/<name>"}`.
- **logs(name, lines)**: `tail(lines)` des aktuellen Eintrags.
- **reconcile()**:
  - Plan = `reconcilePlan(manifeste, running())`, mit
    `toStart = enabled-Namen ∖ laufende` (Reihenfolge wie die Manifeste) und
    `toStop = laufende ∖ enabled-Namen` (Reihenfolge wie running).
  - Zuerst alle aus `toStop` nacheinander stoppen. Ohne Manifest wird
    `{name, port:0}` als Platzhalter verwendet.
  - Dann alle aus `toStart` **nacheinander** starten. Fehler werden geloggt,
    nicht geworfen. Abgestürzte Services zählen nicht als laufend und
    werden deshalb neu gestartet.
  - Rückgabe ist der Plan.
  - Wird aufgerufen beim Start des Dev-Servers (nicht blockierend, Fehler
    nur geloggt) und nach jedem Rollback, **nicht** nach jedem Turn.
- **shutdown()**: `stopAll()`, ausgelöst durch das `close`-Event des
  HTTP-Servers.
- **find(name)**: Manifest oder `undefined`, ohne Validierung.

### 4.5 HTTP-Routen

| Route | Body | Antwort |
|---|---|---|
| `GET /api/services` | – | 200 `{services: status[]}` |
| `POST /api/services/create` | Manifest-Input | 200 `{manifest, url:"/svc/<name>"}` |
| `POST /api/services/control` | `{name, action}` | 200 `{status}`; `action` nicht start, stop oder restart → 400 `action must be start, stop or restart` |
| `POST /api/services/remove` | `{name}` | 200 `{ok:true}` |
| `POST /api/services/logs` | `{name, lines}` | 200 `{logs}`; `lines` muss eine Zahl in 1–200 sein, sonst 50 |

- Jede Exception in diesen Routen, auch ungültiges JSON, ergibt **400**
  `{error: err.message}`. `name` wird mit `String(name)` umgewandelt.
- Unbekannte Unterroute → 404 `Unknown service route: <METHOD> <url>`.
- Exceptions außerhalb (z. B. im Proxy) → 500 `{error}`, falls noch keine
  Header gesendet wurden.

### 4.6 Proxy `/svc/<name>/<rest>`

1. Den Pfad (ohne Query) an `/` teilen: `name` = drittes Segment,
   `rest` = alles danach.
2. Kein Manifest mit diesem Namen → 404 `Unknown service: <name>`.
   Das gilt auch für einen leeren Namen.
3. Zustand ≠ `ready` → 503
   `Service "<name>" is <state> — start it before calling it.`
4. Weiterleitung per `http.request` an `127.0.0.1:<port>`:
   - Pfad `/<rest>` plus `?<query>` aus der Original-URL;
     `/svc/name` ohne Rest wird zu `/`.
   - Methode gleich, alle Header gleich, `host` wird auf
     `127.0.0.1:<port>` gesetzt.
   - Der Request-Body wird gestreamt.
5. Statuscode (Fallback 502) und alle Antwort-Header werden übernommen, der
   Body gestreamt.
6. Ein Verbindungsfehler ergibt 502
   `Service "<name>" is not reachable: <err.message>`.

---

## 5. Agent-Tools

Die Schemas sind wörtlich zu übernehmen (Anhang B.2), denn das Modell liest
die Beschreibungen. Ausführung im Browser (`executeTool(name, argsJson, turnId)`):

1. `argsJson` getrimmt leer → `{}`. Ungültiges JSON → Fehler
   `Invalid JSON in tool arguments: <argsJson>`. Das wird vor der Prüfung des
   Toolnamens ausgewertet.
2. Bei HTTP-Fehlern ist das Ergebnis `String(body.error)` (Fallback
   `HTTP <status>`) und gilt als Fehler.
3. Unbekanntes Tool → Fehler `Unknown tool: <name>`.

| Tool | Aufruf | Ergebnistext bei Erfolg |
|---|---|---|
| `list_files` | `GET /api/fs/list` | ein Pfad pro Zeile, Verzeichnisse mit `/` am Ende |
| `read_file` | `POST /api/fs/read {path}` | Dateiinhalt |
| `write_file` | `POST /api/fs/write {path, content, turnId}` | `File written.` oder `File written. (Git snapshot <h> was taken before this turn's first write.)` |
| `delete_file` | `POST /api/fs/delete {path, turnId}` | `File deleted.` |
| `create_service` | `POST /api/services/create` (alle Argumente) | `Service "<n>" declared on port <p>. Write its code to services/<n>/<entry> (it must listen on Number(process.env.PORT)), then call control_service to start it. The browser reaches it at <url>.` |
| `control_service` | `POST /api/services/control {name, action}` | `Service "<name>" is now <state> (port <port>).` |
| `remove_service` | `POST /api/services/remove {name}` | `Service "<name>" removed.` |
| `service_status` | `GET /api/services` | pro Service `<name>: <state>[ (disabled)] · port <port> · <url>`, verbunden mit `\n`; ohne Services `No services declared.` |
| `service_logs` | `POST /api/services/logs {name, lines}` | Logs oder `(no output)` |

---

## 6. Agent-Loop (`runAgentTurn`)

Signatur:
`runAgentTurn({model, messages, turnId, callbacks, signal?}): Promise<void>`.
`messages` wird **in place** verändert. Callbacks:

- `onAssistantStart(id)`
- `onAssistantDelta(id, delta)`
- `onAssistantDone(id)`
- `onToolCall(id, name, args)`
- `onToolResult(id, result, isError)`
- `onHealth(id, status, text)`
- `onTurnUsage(usd, tokens)`

Konstanten: `MAX_ITERATIONS = 20`, `MAX_REPAIRS = 3`. Assistant-IDs:
`m<Date.now()>_<laufender Zähler>`.

Pro Iteration:

1. `onAssistantStart(id)`, dann ein Modellaufruf (6.1),
   dann `onAssistantDone(id)`. Kosten und Tokens aufsummieren.
2. An die Historie anhängen:
   `{role:"assistant", content: text || null, tool_calls?}`.
   `tool_calls` nur, wenn das Modell welche geliefert hat.
3. Gab es Tool-Calls, werden sie nacheinander abgearbeitet:
   - `onToolCall`, ausführen, `onToolResult`.
   - Erfolgreiches `write_file`: Pfad aus den Argumenten merken (ohne
     Duplikate, nur Strings).
   - Erfolgreiches Tool, dessen Name auf `_service` endet: „Services
     berührt“ merken.
   - `{role:"tool", tool_call_id, content}` anhängen; bei Fehler mit
     Präfix `ERROR: `.
   - Danach nächste Iteration.
4. Sonst (Endantwort):
   - Nichts geschrieben und keine Services berührt → `onTurnUsage`, fertig.
   - `healthId = "health_<turnId>_<repairs>"` (Wert **vor** dem Hochzählen,
     also zuerst `_0`).
     `onHealth(healthId, "checking", "Checking whether the app still works…")`.
   - `problems = verifyApp({turnStartedAt, writtenPaths})` (7.1).
   - Keine Probleme → `onHealth(healthId, "ok", "App loads, no type errors.")`,
     `onTurnUsage`, fertig.
   - `signature = signatureOf(problems)`; `stalled` = gleiche Signatur wie
     beim vorigen Durchlauf; `repairs += 1`.
   - `summary` = die ersten 3 Probleme als `<file ?? "app">: <message>`,
     verbunden mit ` · `.
   - `repairs > 3` oder `stalled`:
     - App kaputt (7.2): `rollbackTurn(turnId)`, dann `onHealth(…,"rolled-back", text)`
       mit `text` =
       - festgefahren: `The app stayed broken in the same way twice — changes rolled back[ to <h>]. <summary>`
       - sonst: `The app is still broken after 3 repair attempts — changes rolled back[ to <h>]. <summary>`
       - ` to <h>` fehlt, wenn der Rollback nichts lieferte (auch bei 409).
         Der Status bleibt dann trotzdem `rolled-back`.
     - App nicht kaputt: `onHealth(…,"gave-up","The app runs, but type errors remain and were not fixed: <summary>")`,
       **ohne** Rollback.
     - In beiden Fällen `onTurnUsage`, fertig.
   - Sonst: `onHealth(…,"repairing","<App is broken|Build is broken> — repair attempt <n> of 3: <summary>")`
     und `{role:"user", content: buildReport(problems, repairs, 3)}`
     anhängen.
5. Nach 20 Iterationen wird geworfen:
   `Agent stopped after 20 iterations without a final answer.`
   `onTurnUsage` wird dann nicht aufgerufen.

`signal` wird an `fetch` durchgereicht. Die UI bietet keinen Abbruch an.

### 6.1 Modellaufruf `streamChat`

`POST /api/chat` mit dem Body
`{model, messages, tools: toolSchemas, stream: true, usage: {include: true}}`.

- Status nicht OK oder `Content-Type` ohne `text/event-stream`: Der Body wird
  gelesen. Ist er JSON, gilt `error.message ?? error ?? body`, sonst der
  rohe Body. Geworfen wird
  `Chat request failed (HTTP <status>): <message>`.
- Kein Body → `Chat response had no body`.
- Den Stream mit `TextDecoder` (stream-Modus) dekodieren, an `\n` trennen,
  die letzte Teilzeile puffern, jede Zeile rechts trimmen. Nach dem Ende
  wird ein Rest im Puffer ebenfalls verarbeitet.
- Pro Zeile: Nur Zeilen mit `data:` am Anfang zählen. Danach getrimmt; leer
  oder `[DONE]` wird ignoriert, ebenso unparsebares JSON.
- `error` im Chunk → geworfen wird `error.message ?? "Upstream error"`.
- `usage.cost` und `usage.total_tokens` werden addiert, wenn es Zahlen sind.
- `choices[0].delta.content` als nicht leerer String → an den Text anhängen
  und `onDelta` aufrufen.
- `delta.tool_calls[]` nach `index` sammeln:
  - Neu: `{id: tc.id ?? "call_<index>", type: "function", function: {name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? ""}}`.
  - Vorhanden: `id` überschreiben, falls gesetzt; `name` und `arguments`
    anhängen.
- Ergebnis `{content, toolCalls (Lücken entfernt), usage: {cost, totalTokens}}`.

---

## 7. Health-Check nach dem Turn

### 7.1 `verifyApp({turnStartedAt, writtenPaths})`

1. `waitForHmr(600)`: auf `vite:afterUpdate` warten, höchstens 600 ms.
   Ohne HMR einfach 600 ms.
2. `GET /api/services` → `problemsFromServices(services)`:
   - `!enabled` oder `state === "ready"` → kein Problem.
   - Art: `kind === "container"` → `infra`, sonst `service`.
     `file = "services/<name>"`.
   - `detail = "\n" + lastLogs`, aber nur, wenn `lastLogs` nicht leer ist.
   - `crashed` → `Service "<n>" crashed with exit code <exitCode ?? "unknown">.<detail>`
   - `starting` → `Service "<n>" did not become ready within its health timeout.<detail>`
   - sonst → `Service "<n>" is declared and enabled but not running.`
     (ohne detail)
3. `POST /api/health/probe {paths: writtenPaths}` → pro Fehler
   `{kind:"probe", file:path, message}`.
4. `errorsSince(turnStartedAt)` → alle Browserfehler seit **Turn-Beginn**
   **[E1]**.
5. `GET /api/health/typecheck` →
   `{kind:"type", file, line, col, code, message}`.

Schlägt ein Aufruf in 2, 3 oder 5 fehl, gibt es nur `console.warn` und kein
Problem. Ein Server-Ausfall darf gute Änderungen nicht zurückrollen.

### 7.2 Klassifikation (`src/agent/healthReport.ts`)

- `ProblemKind = "probe"|"runtime"|"hmr"|"type"|"service"|"infra"`,
  `Problem = {kind, message, file?, line?, col?, code?}`.
- `isAppBroken(ps)` ⇔ mindestens ein Problem mit Art ≠ `type` und ≠ `infra`.
- `signatureOf(ps)` = die Einträge `<kind>:<file ?? "-">:<line ?? "-">:<code ?? message>`,
  sortiert und mit `|` verbunden.

### 7.3 `buildReport(problems, attempt, maxAttempts)`

Zeilen, verbunden mit `\n`:

```
AUTOMATIC HEALTH CHECK FAILED (repair attempt <attempt> of <maxAttempts>).
This is not a user message — the dev server checked the app after your changes.

- [<LABEL>]<ort><code>: <message>
…

<Schlusssatz>
```

- `<ort>`: leer ohne `file`; ` <file>` ohne `line`; sonst
  ` <file>(<line>)` bzw. ` <file>(<line>,<col>)`.
- `<code>`: ` <code>` oder leer.
- Labels: probe `MODULE FAILED TO LOAD`, runtime `RUNTIME ERROR`,
  hmr `VITE ERROR`, type `TYPE ERROR`, service `SERVICE FAILED`,
  infra `INFRASTRUCTURE PROBLEM`.
- Schlusssatz, wenn die App kaputt ist:
  `The running app is broken. Read the files you just changed, find the cause, and fix it with write_file. If you cannot fix it, say so plainly instead of guessing — your changes are then rolled back automatically.`
- Sonst:
  `The app still runs, but the build is broken. Fix the reported type errors with write_file.`

### 7.4 Browser-Fehlersammler (`src/agent/health.ts`)

Wird beim Import aktiv.

- Ringpuffer mit 20 Einträgen `{at: Date.now(), problem}`.
- Listener-Set, das bei jedem neuen Eintrag synchron benachrichtigt wird.

Quellen:
- `window` `error` (Bubbling, also ohne Ressourcen-Ladefehler) →
  `{kind:"runtime", message: event.message, file: event.filename, line: event.lineno, col: event.colno}`.
  `filename` ist die rohe URL, sie wird nicht umgerechnet.
- `unhandledrejection` →
  `{kind:"runtime", message: "Unhandled rejection: <reason?.message ?? String(reason)>"}`.
- `import.meta.hot.on("vite:error")` →
  `{kind:"hmr", message: err.message (ohne ANSI, Whitespace zusammengezogen, getrimmt), file: err.id, line: err.loc?.line, col: err.loc?.column}`
  (`err.id` roh).
- `reportRenderError(error, componentStack)` (aus der ErrorBoundary) →
  `{kind:"runtime", message: "<error.message>\n<erste 3 Zeilen des getrimmten Stacks>"}`.

Exporte: `errorsSince(since)`, `subscribe(listener) → unsubscribe`,
`reportRenderError`, `waitForHmr(timeoutMs = 600)`.

---

## 8. Chat-Store und Watchdog (`src/chat/store.ts`)

### 8.1 Zustand und Persistenz

Der Zustand liegt auf Modulebene, nicht in React-State. So kann ein Remount
von `<Chat/>` durch HMR einen laufenden Turn nicht unterbrechen.
`ChatState = {transcript, busy, sessionCost, sessionTokens}`.
Exporte: `subscribe`, `getSnapshot` (für `useSyncExternalStore`),
`sendMessage`, `newChat`, `repairNow`.

| Daten | localStorage-Key |
|---|---|
| Wire-Historie | `agent.wire` (Default `[{role:"system", content: SYSTEM_PROMPT}]`) |
| Transcript | `agent.transcript` |
| Sitzungssumme | `agent.session` = `{cost, tokens}` |
| Modell | `agent.model` (in `Chat.tsx`) |

- **Jede** Zustandsänderung, auch jedes Stream-Delta, schreibt alle drei
  Store-Keys und benachrichtigt die Listener.
- Laden: ungültiges JSON → Default. `streaming:true` in Assistant-Einträgen
  wird zu `false`.
- Die Wire-Historie wird beim Laden **nicht** mit dem aktuellen
  Systemprompt abgeglichen.

`TranscriptItem` (in `src/agent/types.ts`):

```ts
| { kind: 'user'; id; text }
| { kind: 'assistant'; id; text; streaming? }
| { kind: 'tool'; id; name; args; result?; isError? }
| { kind: 'error'; id; text }
| { kind: 'health'; id; status: 'checking'|'ok'|'repairing'|'rolled-back'|'gave-up'; text }
| { kind: 'broken'; id; text; prompt }
| { kind: 'cost'; id; usd; tokens }
```

### 8.2 `sendMessage(text, model)`

1. `busy` → nichts tun.
2. `lastModel = model`, `turnId = "turn_<Date.now()>"`.
3. `{role:"user", content:text}` an die Wire hängen; Transcript
   `{kind:"user", id: turnId, text}`; `busy = true`.
4. `runAgentTurn` mit Callbacks, die das Transcript pflegen:
   - start → neuer leerer Assistant-Eintrag mit `streaming`
   - delta → Text anhängen
   - done → `streaming:false`
   - toolCall → Tool-Eintrag
   - toolResult → Ergebnis eintragen
   - health → `agentHasWritten = true`; vorhandenen Eintrag gleicher id
     aktualisieren, sonst neu anlegen
   - usage → bei `usd = 0` und `tokens = 0` nichts; sonst
     `{kind:"cost", id:"cost_<Date.now()>"}` und Sitzungssummen erhöhen
5. Exception → `{kind:"error", id:"err_<Date.now()>", text: err.message}`.
6. **Immer** danach: `POST /api/git/commit {message: text}`, Fehler
   ignorieren; `turnEndedAt = Date.now()`; `busy = false`.

### 8.3 `newChat()`

Nur wenn nicht busy:
- Wire = nur Systemprompt, Transcript leer, Sitzungssummen 0.
- `agentHasWritten = false`, `autoRepairsInARow = 0`, erledigte Signaturen
  leeren.
- `lastModel` und `turnEndedAt` bleiben.

### 8.4 Watchdog

Konstanten: `AUTO_REPAIR_WINDOW_MS = 30000`, `DEBOUNCE_MS = 1000`.
Der Zustand liegt nur im Speicher und wird bei einem Reload zurückgesetzt.

Bei jedem neuen Browserfehler (über `subscribe` aus 7.4):

1. `!agentHasWritten` → ignorieren.
2. `sig = signatureOf([problem])`. Schon erledigt → ignorieren, sonst
   **sofort** als erledigt markieren.
3. Den Entprell-Timer neu starten. Bei mehreren Fehlern im Fenster gewinnt
   der **letzte**.
4. Wenn der Timer abläuft und `busy` ist, wird nichts getan. Der Fehler
   bleibt trotzdem als erledigt markiert.
5. `text = "<file>: <message>"`, ohne `file` nur `<message>`.
6. Ist `now - turnEndedAt ≤ 30000` und `autoRepairsInARow === 0`:
   - `autoRepairsInARow += 1`
   - Eintrag `{kind:"health", id:"wd_<now>", status:"repairing", text:"App crashed after the turn — repairing automatically: <text>"}`
   - `repairNow(watchdogPrompt(text))`
7. Sonst Eintrag `{kind:"broken", id:"wd_<now>", text, prompt: watchdogPrompt(text)}`
   mit `text` =
   - nach einer Auto-Reparatur:
     `Still broken after an automatic repair: <text> — you can retry, or restore an older state at /recovery.`
   - sonst: `The app is broken: <text>`

`repairNow(prompt)`: Bei `busy` oder leerem `lastModel` passiert nichts.
Sonst `sendMessage(prompt, lastModel)`. Der Prompt erscheint damit als
User-Blase und dient als Commit-Nachricht.

`autoRepairsInARow` wird nur von `newChat` zurückgesetzt. Pro Chat-Sitzung
gibt es also höchstens eine automatische Reparatur **[E6]**.

`watchdogPrompt(text)`:
```
AUTOMATIC WATCHDOG REPORT — this is not a user message.
The app crashed in the browser after your last turn:

<text>

Read the files you changed, find the cause and fix it with write_file.
```

---

## 9. Chat-UI (`src/chat/*`)

### 9.1 `Chat.tsx`

- Modell: `localStorage["agent.model"] ?? "openai/gpt-5.6-luna"`, wird bei
  jeder Änderung gespeichert.
- Layout: `.chat-layout`. Links `.chat` mit Header, MessageList,
  ServicesPanel, MessageInput; rechts die CommitList.
- Header:
  - Titel `⚡ Coding Agent`
  - ModelPicker, während busy deaktiviert
  - Sitzungskosten `Σ <formatUsd(cost)>`, bei Kosten 0 genau `Σ $0`;
    Tooltip `<tokens.toLocaleString()> tokens this session`
  - Button `New chat`, während busy deaktiviert
- `formatUsd(usd)`: `usd ≥ 0.01` → `$` + `toFixed(4)`, sonst `toFixed(6)`.

### 9.2 ModelPicker

`<input list="model-suggestions" spellCheck={false} title="OpenRouter model id">`
mit Datalist:
- `~anthropic/claude-haiku-latest`
- `~anthropic/claude-sonnet-latest`
- `anthropic/claude-haiku-4.5`
- `anthropic/claude-sonnet-4.6`

Jeder Text ist erlaubt.

### 9.3 MessageList

Leerzustand:
- `This chat drives a coding agent that can modify <strong>this very app</strong>. Try:`
- darunter als Beispiel
  `“Create a src/components/HelloWorld.tsx component and render it above the chat.”`

Einträge:
- `user` → Blase mit Text.
- `assistant` → Blase. Ein leerer, nicht streamender Eintrag wird nicht
  angezeigt. Beim Streaming folgt ein Cursor `▋`.
- `tool` → ToolCallCard (9.4).
- `error` → `⚠ <text>`.
- `health` → Präfix je Status: checking `🔍 `, ok `✓ `, repairing `🔧 `,
  rolled-back `⏪ `, gave-up `⚠ `. CSS-Klasse `msg-health-<status>`.
- `broken` → `⚠ <text>` und Button `Repair`, der `repairNow(prompt)` aufruft.
- `cost` → `<formatUsd(usd) | "free"> · <tokens.toLocaleString()> tokens`.

Während busy steht unten `working…`. Bei jeder Änderung an Einträgen oder
`busy` wird weich ans Ende gescrollt.

### 9.4 ToolCallCard

Der Kopf ist ein Button, der die Karte auf- und zuklappt (Start
zugeklappt):
- Status: `…` (ausstehend), `✗` (Fehler) oder `✓`
- Toolname als `<code>`
- `args.path`, falls die Argumente als JSON parsebar sind und `path` ein
  String ist
- Pfeil `▸`/`▾`

Aufgeklappt: Abschnitt `arguments` (roh) und, falls vorhanden, `result`.

### 9.5 MessageInput

- Textarea mit `rows=3` und dem Platzhalter
  `Ask the agent to modify this app… (Enter to send, Shift+Enter for newline)`.
- Enter ohne Shift sendet; Shift+Enter fügt einen Zeilenumbruch ein.
- Gesendet wird der getrimmte Text, leere Eingaben nicht. Das Feld wird
  danach geleert.
- Button `Send`, deaktiviert bei busy oder leerem Text.
- Während busy ist alles deaktiviert.

### 9.6 ServicesPanel

- `GET /api/services` beim Mount und jedes Mal, wenn `busy` auf false
  wechselt. Aufgeklappt zusätzlich alle 3000 ms.
- Keine Services und kein Fehler → nichts rendern.
- Kopf-Button: `▸ Services` bzw. `▾ Services` und
  `<n> running[ · <m> unhealthy]`. Dabei ist running = `ready`, unhealthy =
  `enabled` und nicht `ready`.
- Aufgeklappt:
  - Fehlertext, falls vorhanden.
  - Pro Service ein Punkt mit Klasse = state (Tooltip = state), der Name,
    `:<port>`, ein Badge `disabled` bei `!enabled` und vier Buttons:
    `▶` (Start), `■` (Stop), `⟳` (Restart), `≡` (Logs).
  - Die Steuer-Buttons rufen `/api/services/control` auf. Ein Fehler wird
    angezeigt, danach wird neu geladen.
  - Logs: `/api/services/logs {name, lines:100}`. Angezeigt wird ein Kasten
    mit dem Namen, `✕` zum Schließen und `<pre>` mit `logs || "(no output)"`
    oder dem Fehlertext. Einen Netzwerkfehler fängt der Logs-Aufruf nicht ab.

### 9.7 CommitList

- Lädt `/api/git/log` beim Mount und jedes Mal, wenn `busy` auf false
  wechselt.
- Kopf:
  - `Commits`
  - Link `Recovery` (`/recovery`, neuer Tab; Tooltip
    `Standalone recovery page — works even when the app is broken`)
  - Button `⟳` (Tooltip `Refresh`)
- Liste: Nachricht (voll), Hash, Datum (Format wie 3.7), ein Badge bei
  `kind ≠ user`, Klasse `snapshot` für Snapshots.
- Nur der erste (neueste) Eintrag hat `FORGET`:
  - Tooltip `Remove this commit from git history (git reset --hard HEAD~1)`,
    während busy deaktiviert.
  - Klick fragt per `confirm`:
    `Remove commit <hash> ("<erste Zeile>") from git history?\n\nThis resets the project to the previous commit and permanently discards its changes.`
  - Danach `/api/git/forget`. Ein Fehler wird angezeigt, anschließend wird
    neu geladen.
- Fehler stehen oben in der Liste. Leer und ohne Fehler: `No commits to show.`

### 9.8 AppErrorBoundary (`src/chat/AppErrorBoundary.tsx`)

`main.tsx` rendert
`<StrictMode><AppErrorBoundary><App/></AppErrorBoundary></StrictMode>` in
`#root` und importiert `./index.css`.

Wirft `App` beim Rendern, ruft die Boundary
`reportRenderError(error, info.componentStack ?? "")` auf und rendert:

```
<div class="app-crash">
  <div class="app-crash-banner">
    <strong>The app crashed while rendering.</strong>
    <pre>{error.message}</pre>
    <span>The chat below still works — ask the agent to fix it, or restore an older state at <a href="/recovery">/recovery</a>.</span>
  </div>
  <Chat />
</div>
```

Bei jedem `vite:afterUpdate` setzt sie den Fehler zurück und rendert `App`
erneut.

---

## 10. App-Shell und Demo-Seiten

Diese Teile darf der Agent ändern. Was hier steht, ist der Stand zum
Zeitpunkt der Extraktion.

### 10.1 Shell (`src/App.tsx`)

- Flex-Layout über die volle Höhe, Hintergrund `#1a1a1a`.
- Sidebar: 280 px, `#0f0f0f`, rechter Rand `2px solid #3a3a3a`, Padding 24.
  Inhalt: `HelloWorld` und darunter die Navigation:
  - `Coding Agent` → home
  - `Komponenten` → components
  - `Kalender` → calendar
  - `TODO Liste` → todo
  - `Notes` → notes
- Aktiver Nav-Button: Hintergrund und Rand `#b0b0b0`, Schrift weiß, 600.
  Inaktiv: transparent, `#9a9a9a`, Rand `#3a3a3a`, Hover `#2a2a2a`.
- Die aktive Seite liegt in `sessionStorage["app.currentPage"]`. Ein
  unbekannter Wert ergibt `home`.
- Rechts: immer `<SearchBar onNavigate todos>`, darunter die Seite.
  home = `<Chat/>`.
- `useTodos()` (exportiert): liest `localStorage["todos"]` beim Start und
  danach alle 500 ms, jeweils mit `JSON.parse`. Ein Fehler wird ignoriert,
  ein fehlender Wert lässt den alten Stand stehen.
- `HelloWorld`: Kachel mit dem Text `Hello Guido`, fett 18 px, Hintergrund
  `#1a0a0a`, Rand `#2a0a0a`.

### 10.2 SearchBar

- Platzhalter `Suche...`, `aria-label="Suche"`, Icon `🔍`.
- Leeres Feld → Hinweis
  `Tastatur: <kbd>↑</kbd> <kbd>↓</kbd> navigieren · <kbd>Enter</kbd> auswählen · <kbd>Esc</kbd> schließen`.
- Datenquellen, in dieser Reihenfolge, Suche case-insensitiv als Teilstring:
  1. Statische Einträge, Treffer in Titel, Beschreibung oder Kategorie:

| id | Titel | Beschreibung | Kategorie | Ziel |
|---|---|---|---|---|
| 1 | Komponenten Showcase | Alle verfügbaren Komponenten und deren Beispiele anzeigen | Seite | components |
| 2 | TODO Liste | Interaktive Aufgabenverwaltung mit localStorage-Persistenz | Seite | todo |
| 3 | Kalender | Monatsansicht mit Outlook-Terminübersicht und Farbmarkierungen | Seite | calendar |
| 4 | Coding Agent | Hauptseite des KI-Coding-Assistenten mit Chat-Funktion | Seite | home |
| 5 | Error Boundary | Fängt alle Runtime-Fehler ab und zeigt ein rotes Crash-Banner an | Feature | – |
| 6 | Recovery Page | Standalone-Seite zum Wiederherstellen älterer Zustände | Feature | – |
| 7 | Commit-Panel | Zeigt alle Git-Commits mit FORGET-Funktion zum Zurücksetzen | Feature | – |
| 8 | Microsoft Graph API | Outlook-Anbindung mit OAuth 2.0 PKCE-Fluss | Integration | – |
| 9 | Store Modul | Modullevel Chat-Store mit useSyncExternalStore und Agent Loop | Architektur | – |
| 10 | Agent Loop | Hauptschleife für die KI-Agenten-Aktionen mit Watchdog | Architektur | – |
| 11 | Message Input | Eingabefeld für Nachrichten mit Enter-Senden und Shift+Enter-Format | Komponente | – |
| 12 | Model Picker | Dropdown-Auswahl für OpenRouter-Modelle mit Auto-Vervollständigung | Komponente | – |

  2. TODOs aus `useTodos`. Ist die Liste leer, gelten die drei Beispiel-TODOs
     aus 10.3. Treffer im Text oder im Wort `completed` bzw. `pending`
     (je nach Status). Ergebnis
     `{id:"todo-<id>", title:text, description:"✅ Erledigt" | "⏳ Ausstehend", category:"Aufgabe", target:"todo"}`.
  3. Notizen von `GET /svc/notes-api/notes`, einmal beim Mount geladen; bei
     Fehler oder Nicht-OK leer. Treffer in Titel oder Inhalt. Ergebnis
     `{id:"note-<id>", title, description:content, category:"Notiz", target:"notes"}`.
- Liste (`role="listbox"`, `id="search-results-list"`):
  - Pro Treffer: Titel, bei `Aufgabe` mit Präfix `📝`, bei vorhandenem Ziel
    mit Pfeil ` →`; dazu Beschreibung und Kategorie.
  - `aria-activedescendant` zeigt auf `search-result-<id>`; Maus-Hover
    wählt den Eintrag aus.
- Bedienung:
  - Tippen öffnet die Liste und setzt die Auswahl auf 0.
  - ↑/↓ verschieben die Auswahl, begrenzt auf die Listengrenzen.
  - Enter oder Mausklick (`mousedown`) schreibt den Titel ins Feld, schließt
    die Liste und navigiert, falls ein Ziel existiert.
  - Esc schließt die Liste.
  - Fokus öffnet die Liste nur, wenn Text und Treffer da sind.
  - Blur schließt die Liste nach 200 ms.
  - Der Button `✕` (`aria-label="Suche zurücksetzen"`) leert das Feld.
  - Tasten wirken nur bei offener Liste mit Treffern.
- Kein Treffer: `Keine Ergebnisse für "<query>"` (`role="status"`).

### 10.3 TodoList

- Prop `demo` (Default false).
- Beispiel-TODOs:
  - `{1, "Implementiere Authentifizierung", false}`
  - `{2, "Bereite API-Dokumentation vor", true}`
  - `{3, "Optimiere Datenbankabfragen", false}`
- Normal: laden aus `localStorage["todos"]`; ein Parse-Fehler wird geloggt,
  dann leer. Jede Änderung wird gespeichert.
- Demo: Es werden die Beispiel-TODOs angezeigt. Nichts ist änderbar, nichts
  wird gespeichert.
- Texte:
  - Überschrift `📝 TODO Liste`
  - Eingabefeld mit Platzhalter `Neues TODO hinzufügen...`
  - Button `Hinzufügen` (Enter im Feld wirkt genauso)
  - Pro Eintrag Checkbox, Text (erledigt: durchgestrichen und blasser) und
    Button `Löschen`
  - Leerzustand `📭 Noch keine TODOs` / `Füge ein neues TODO hinzu, um zu starten!`
  - Zähler `<offen> von <gesamt> TODOs verbleibend`
- Hinzufügen nur, wenn der getrimmte Text nicht leer ist. Gespeichert wird
  der **ungetrimmte** Text mit `id = Date.now()`.
- Helles Blau-Schema (`#e0f2fe` Hintergrund, `#3b82f6` primär).

### 10.4 Calendar

Props: `events?: CalendarEvent[]`, `onDateSelect?(date)`.
`CalendarEvent = {id, date: "YYYY-MM-DD", time, title, color, description?, webLink?}`.

- Wochentage `Mo Di Mi Do Fr Sa So`. Monate deutsch (`Januar` … `Dezember`,
  `März`).
- Kopf:
  - Eyebrow `Terminübersicht`, Titel `<Monat> <Jahr>`.
  - Buttons `Heute`, `‹` (`aria-label="Vorheriger Monat"`) und `›`
    (`aria-label="Nächster Monat"`). Alle drei sind während des Ladens
    deaktiviert.
- Raster:
  - Leere Felder bis zum Wochentag des Monatsersten (Montag = 0).
  - Ein Button pro Tag mit Klassen `--today` und `--selected`,
    `aria-pressed` und dem Label
    `<Tag>. <Monat> <Jahr>, <n> Termine` bzw. `…, kein Termin`.
  - Zähler: `n` bei n ≤ 3, sonst `+<n-3>`.
- Klick auf einen Tag wählt ihn aus, springt in seinen Monat und ruft
  `onDateSelect`.
- Details:
  - Eyebrow `Ausgewählter Tag` und das Datum als `de-DE`
    `{weekday:'long', day:'numeric', month:'long', year:'numeric'}`.
  - Leer: `◇` / `Keine Termine an diesem Tag`. Mit Outlook-Verbindung
    zusätzlich `Termine werden direkt aus deinem Outlook geladen.`
  - Pro Termin: Farbmarker, Uhrzeit in Terminfarbe, Titel, Beschreibung und
    Link `Im Outlook öffnen ↗` (neuer Tab).
- Termine:
  - Mit Token: Outlook-Termine.
  - Sonst: Prop `events` oder die Demo-Termine. Diese werden beim Laden des
    Moduls relativ zu heute berechnet:

| id | Tag | Zeit | Titel | Farbe |
|---|---|---|---|---|
| standup | heute | 09:00 | Team Stand-up | meeting |
| review | +2 | 14:30 | Projekt-Review | work |
| design | +5 | 11:00 | Design-Workshop | personal |
| invoice | +9 | 16:00 | Rechnungen prüfen | important |

- Farben: default `#f87171`, meeting `#dc2626`, personal `#fca5a5`,
  important `#ef4444`, work `#fb923c`.
- Outlook-Steuerung im Kopf:
  - Ohne `VITE_MS_OUTLOOK_CLIENT_ID` (getrimmt): nur der Text
    `Outlook-Anbindung konfigurieren`.
  - Verbunden: Statuspunkt, `Outlook verbunden`, UPN (falls bekannt) und
    Button `Abmelden`.
  - Nicht verbunden: Button `Mit Outlook verbinden`, während des Ladens
    `Verbindung wird hergestellt...`.
- Anmeldung (OAuth 2.0 Authorization Code mit PKCE):
  - Ohne Client-ID → Fehler
    `Outlook ist nicht konfiguriert. Setze VITE_MS_OUTLOOK_CLIENT_ID.`
  - Verifier und state: je 32 Zufallsbytes als base64url ohne `=`.
    Challenge = base64url(SHA-256(verifier)).
  - Beides in `sessionStorage` unter `ai-react-outlook-state` und
    `ai-react-outlook-codeVerifier`.
  - Weiterleitung auf
    `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` mit
    `client_id`, `response_type=code`, `redirect_uri`, `response_mode=query`,
    `scope="openid profile offline_access Calendars.Read"`, `state`,
    `code_challenge` und `code_challenge_method=S256`.
  - Tenant = Env oder `common`. Redirect = Env oder `<origin>/`.
- Callback (beim Mount, wenn `code` oder `error` in der Query steht; nur
  einmal):
  - `error` → `error_description` oder
    `Die Outlook-Anmeldung wurde abgebrochen.`
  - `code`, `state` oder Verifier fehlen →
    `Die Outlook-Anmeldung konnte nicht abgeschlossen werden.`
  - `state` stimmt nicht →
    `Die Outlook-Anmeldung ist ungültig. Bitte versuche es erneut.`
  - Token-POST (form-urlencoded: `client_id`, `code`,
    `grant_type=authorization_code`, `redirect_uri`, `code_verifier`,
    `scope`) an `…/oauth2/v2.0/token`. Fehlschlag oder kein
    `access_token` → `error_description || error || "Token konnte nicht erstellt werden."`
    (eine andere Exception → `Outlook-Anmeldung fehlgeschlagen.`).
  - Erfolg: Token in den React-State (nach einem Reload ist es weg),
    Storage-Keys löschen, Query per `history.replaceState` entfernen und
    Termine laden.
- Laden (bei jedem Token- oder Monatswechsel):
  - `GET https://graph.microsoft.com/v1.0/me/calendarview` mit
    `startDateTime` und `endDateTime` (lokaler Monatsanfang bzw. Anfang des
    Folgemonats als ISO), `$select=id,subject,start,end,bodyPreview,isAllDay,category,webLink,showAs`
    und `$orderby=start/dateTime`.
  - Fehler → `Termine konnten nicht geladen werden: <error.description || error || statusText>`;
    andere Exception → `Unbekannter Fehler beim Laden der Termine.`
  - Danach `GET /me?$select=displayName,userPrincipalName` für den UPN;
    Fehler werden ignoriert.
- Mapping eines Graph-Termins:
  - `date` = lokales Datum von `new Date(start.dateTime)`; ungültig → heute.
  - `time` = `"Ganztägig"` bei `isAllDay`, sonst
    `start.dateTime.slice(0, 5)` **[E2]** oder `"Zeit fehlt"`.
  - `title` = getrimmter Betreff oder `"Ohne Betreff"`.
  - `color` nach `category`, sonst default.
  - `description` = `bodyPreview` ohne HTML-Tags, getrimmt.
- Abmelden: Token, Termine, Konto und Fehler leeren, Storage-Keys löschen.
- Fehler erscheinen als `role="alert"`.

### 10.5 NotesPage und Service `notes-api`

**Service** (`services/notes-api/`): `index.ts`, nur Node-Built-ins. Das
Manifest steht in 4.1, `package.json` = `{"type":"module"}`.

- Daten in `<cwd>/data.json`, eingerückt mit 2 Leerzeichen. Fehlt die Datei
  beim Start, wird sie angelegt mit:
  - `{1, "First Note", "This is the first note."}`
  - `{2, "Second Note", "This is the second note."}`
  - `{3, "Third Note", "This is the third note."}`
- Lesefehler oder kaputtes JSON → `[]`.
- Lauscht auf `127.0.0.1:<PORT>` und loggt `notes-api listening on <PORT>`.

| Route | Verhalten |
|---|---|
| `GET /health` | 200 `{"status":"ok"}` |
| `GET /notes` | 200 Array in Speicherreihenfolge |
| `POST /notes` | 201 neue Notiz, `id = max(ids)+1` (leer → 1) |
| `PUT /notes/<id>` | 200 aktualisierte Notiz (Felder zusammengeführt) |
| `DELETE /notes/<id>` | 200 gelöschte Notiz |
| sonst | 404 `{"error":"Not found"}` |

Fehler:
- `title` und `content` müssen Strings sein (leere Strings sind erlaubt),
  sonst 400 `Invalid note: title and content are required strings`.
- Body kein JSON → 400 `Invalid JSON body`.
- `<id>` nicht per `parseInt` lesbar → 400 `Invalid note id`.
- Notiz nicht gefunden → 404 `Note not found`.

`data.json` ist **nicht** in `.gitignore` **[E3]**.

**UI** (`NotesPage.tsx`, URL `/svc/notes-api/notes`):
- `<section tabIndex=0 aria-label="Notes">`.
- Kopf: Eyebrow `notes-api`, Titel `Your notes`, darunter
  `Loading notes…` bzw. `<n> note[s] from the service`.
- Fehler als `role="alert"`:
  - `Title and content are required` (Prüfung auf getrimmte Felder)
  - `body.error` oder `Request failed with status <s>`
  - Fallbacks `Unable to load notes`, `Failed to create note`,
    `Failed to update note`, `Failed to delete note`
- Button `+ New note`, nur sichtbar, wenn kein Formular offen ist.
- Formular:
  - Titel `New note` bzw. `Edit note`.
  - Felder `Title` (Platzhalter `Enter note title`) und `Content`
    (Textarea mit 4 Zeilen, Platzhalter `Enter note content`).
  - Buttons `Create`/`Update` (beim Speichern `Saving...`; deaktiviert,
    solange gespeichert wird oder ein Feld leer ist) und `Cancel`.
- Liste: `Loading notes…` / `No notes available.`, sonst Karten mit
  `Note <id>`, Titel, Buttons `✏️` (Tooltip `Edit note`) und `🗑️` (Tooltip
  `Delete note`) und dem Inhalt.
- Löschen fragt per `confirm`: `Are you sure you want to delete this note?`
- Nach einer erfolgreichen Änderung wird neu geladen, das Formular
  geschlossen und die Sektion fokussiert.

### 10.6 ComponentsShowcase und ErrorTestButton

- Überschrift `🎨 Komponenten Showcase`, Untertitel
  `Alle verfügbare Komponenten und deren Beispiele`.
- Aufklappbare Abschnitte (Pfeil `▶`/`▼`, alle zu Beginn zu):
  - `👋 HelloWorld Component` → HelloWorld
  - `📝 TODO Liste Beispiele` → `<TodoList demo />`
  - `📅 Kalender Komponente` → Calendar
  - `🛡️ Error Boundary / Fehler Test` → `<ErrorTestButton onInject={() => {}} />`
- Hinweis am Ende:
  `💡 Tipp: Weitere Komponenten findest du im Ordner src/components/`.
- ErrorTestButton:
  - Ruhetext `🧪 Fehler injizieren`.
  - Klick ruft `onInject("⚠️ TEST-FEHLER: Simulierter Fehler im Chat zur Überprüfung des Fehlerhandlings.")`
    auf und zeigt 1500 ms lang deaktiviert `⏳ Wird injiziert…`.
  - Im Showcase ist der Callback leer, der Button bewirkt dort also nichts.

### 10.7 `scripts/embed.ts`

- Aufruf über `npm run embed -- <text>`, also
  `node --experimental-strip-types --env-file=.env scripts/embed.ts`.
- Ohne Key: Ausgabe auf stderr
  `OPENROUTER_API_KEY is not set. Run with: node --experimental-strip-types --env-file=.env.example scripts/embed.ts`,
  danach Exit 1.
- Text = Argumente, verbunden mit Leerzeichen, sonst
  `Your text string goes here`.
- Aufruf: `new OpenRouter({apiKey}).embeddings.generate({requestBody: {model:"qwen/qwen3-embedding-8b", input, encodingFormat:"float"}})`.
- Fehlerfälle:
  - Antwort ist ein String → `Unexpected raw response: <r>`
  - keine Daten → `Response contained no embeddings`
  - Embedding ist ein String → `Expected a float vector, got a base64 string`
- Ausgabe:
  ```
  model:      <model>
  dimensions: <n>
  first 8:    <JSON der ersten 8 Werte>
  usage:      <JSON von usage ?? {}>
  ```

---

## 11. Akzeptanzbeispiele

Die Unit-Tests in `tests/` (53 Fälle in 9 Dateien) gehören zur Spec. Sie
laufen mit `npm test` und müssen unverändert grün sein. Dabei dürfen die
Ports 4001–4003 und 4098 nicht belegt sein, es darf also kein Dev-Server
laufen.

End-to-End:

1. **Sandbox**:
   - `read_file("../secret")`, `read_file(".env")` und
     `read_file("node_modules/x")` → 403.
   - Ein absoluter Pfad innerhalb der Wurzel → 200.
   - `write_file("src/chat/Chat.tsx", …)` → 403 read-only.
   - `list_files` enthält weder `.env` noch `.git/`.
2. **Syntax-Gate**: `write_file("src/A.tsx", "export const A = () => <div>")`
   → 422 mit Zusatz; die Datei existiert danach nicht.
3. **Snapshot einmal pro Turn**: Zwei writes in einem Turn bei
   ungespeicherten Änderungen ergeben genau einen Commit
   `agent snapshot (pre-modification)`. Nur der erste write meldet
   `snapshot`.
4. **Turn-Commit**: Ein Turn mit Änderungen erzeugt oben einen Commit mit
   dem Prompttext (`kind: agent`). Ein Turn ohne Änderungen erzeugt keinen.
5. **Selbstheilung**: Der Agent schreibt eine Komponente mit Typfehler →
   `repairing` (Build is broken). Behebt er den Fehler, folgt `ok`. Behebt
   er ihn nicht, folgt spätestens nach dem 4. Health-Durchlauf `gave-up`,
   ohne Rollback.
6. **Rollback**: Der Agent schreibt in `App.tsx` einen Import auf eine
   fehlende Datei und repariert nicht → `rolled-back`. Der Arbeitsbaum
   entspricht dann dem Anker, und Services dieses Turns sind gestoppt.
7. **Festgefahren**: Zwei Durchläufe mit gleicher Signatur führen sofort
   zum Abbruch.
8. **Service-Lebenszyklus**:
   - `create_service {name:"x-api", kind:"process", entry:"index.ts"}` →
     der niedrigste freie Port ab 4001.
   - `start` ohne Code → 400 `Service "x-api" did not become ready: the process exited during startup` mit Log-Tail.
   - Mit gültigem Code → `/svc/x-api/health` gibt 200.
   - `stop` → `enabled:false`, der Proxy gibt 503.
9. **Env-Schutz**: `env:{NODE_OPTIONS:"…"}` oder `env:{PORT:"1"}` → 400
   „reserved“.
10. **Crash überlebt den Chat**: Wirft `App.tsx` beim Rendern, erscheinen
    das Banner und ein funktionierender Chat. Nach der Reparatur ist die App
    per HMR ohne Reload zurück.
11. **Watchdog**:
    - Ein Laufzeitfehler 10 s nach dem Turn löst einen automatischen
      Reparatur-Turn aus.
    - Derselbe Fehler löst nichts mehr aus.
    - Ein neuer Fehler nach mehr als 30 s → `broken` mit Repair-Button.
12. **Persistenz**: Nach einem Reload während eines Streams sind Transcript,
    Modell und Sitzungskosten erhalten, und es blinkt kein Cursor mehr.

---

## 12. Abweichungen zwischen Code und README

Es gilt der Code.

| Thema | README | Code |
|---|---|---|
| Default-Modell | `~anthropic/claude-haiku-latest` | `openai/gpt-5.6-luna` |
| Reconcile „nach jedem Turn“ | behauptet | nur beim Start und nach einem Rollback |
| Schreibschutz | ohne `tests/` | `tests/` ist geschützt |
| Tools | nennt list, read, write | dazu `delete_file` und fünf Service-Tools |

---

## 13. Bewusst nicht spezifiziert

- Pixelgenaues Styling. Die CSS-Klassennamen in Abschnitt 9 sind verbindlich,
  die Gestaltung ist frei (dunkles Schema).
- `docs/superpowers/`: Pläne für M2 (Docker-Container als Service-Art).
  Im Code gibt es davon nur `kind: 'container'` → Problemart `infra` in
  `serviceHealth.ts`.
- Laufzeitdaten (`services/notes-api/data.json`).
- Wortlaut der Server-Logzeilen.
- README-Inhalt (empfohlen: Setup, Architektur, Sicherheitsmodell).

---

## 14. Offene Entscheidungen (Fehler im Original)

Das Nachbau-Experiment hat diese Stellen aufgedeckt. Bis eine Entscheidung
eingetragen ist, gilt das Originalverhalten.

| Nr. | Ort | Verhalten im Original | Folge | Vorschlag | Entscheidung |
|---|---|---|---|---|---|
| E1 | 7.1 Schritt 4 | Browserfehler werden seit **Turn-Beginn** gesammelt, nicht seit dem letzten Reparaturversuch | Ein schon behobener Fehler zählt weiter; eine gelungene Reparatur kann als „festgefahren“ gelten und zurückgerollt werden | Nur Fehler seit Beginn des aktuellen Health-Durchlaufs bzw. seit dem letzten write zählen | offen |
| E2 | 10.4 Mapping | `time = dateTime.slice(0, 5)` | Ergibt `"2026-"` statt einer Uhrzeit | `slice(11, 16)`, dazu Zeitzone über `Prefer: outlook.timezone` oder UTC→lokal umrechnen | offen |
| E3 | 10.5 | `services/*/data.json` ist nicht in `.gitignore` | Snapshots committen Laufzeitdaten; Rollback oder Restore ersetzt die Datei unter dem laufenden Service | Laufzeitdaten ignorieren (z. B. `services/*/data/`) und das im Systemprompt festlegen | offen |
| E4 | 3.2 | Text ohne Key nennt `.env.example` | Falsche Anleitung | `Create a .env file (see .env.example) …` | offen |
| E5 | 4.3 Schritt 5 | Bei Readiness-Timeout wird der Prozess nicht beendet | Verwaister Prozess hält den Port, der nächste Start scheitert mit EADDRINUSE. `stop`/`stopAll` erreichen ihn nicht mehr | Prozessbaum bei jedem Startfehler beenden | offen |
| E6 | 8.4 | Höchstens eine Watchdog-Auto-Reparatur pro Chat-Sitzung | Spätere frische Crashs werden nie automatisch repariert | Zähler bei jedem erfolgreichen Turn (Health `ok`) zurücksetzen | offen |

---

## Anhang A: Modulstruktur und Exporte

Pfade und Namen sind verbindlich (die Tests importieren sie, und der
Schreibschutz hängt an den Verzeichnissen).

| Datei | Exporte |
|---|---|
| `server/agentPlugin.ts` | `agentPlugin(): Plugin` (name `agent-middleware`; `configResolved`, `configureServer`) |
| `server/healthProbe.ts` | `ProbeFailure`, `probeModules(server, paths)` |
| `server/recoveryPage.ts` | `recoveryHtml: string` |
| `server/syntaxCheck.ts` | `checkSyntax(relPath, content)` |
| `server/tscCheck.ts` | `TypeDiagnostic`, `parseTscOutput(stdout)`, `runTypecheck(root)` |
| `server/services/logBuffer.ts` | `LogBuffer`, `createLogBuffer(max = 200)` |
| `server/services/manifest.ts` | `ServiceKind`, `HealthSpec`, `Manifest`, `ManifestInput`, `ManifestError`, `validateName`, `DEFAULT_HEALTH_PATH`, `DEFAULT_HEALTH_TIMEOUT_MS`, `buildManifest(input, port)`, `serialiseManifest`, `parseManifest`, `serviceDir`, `manifestPath`, `saveManifest`, `listManifests` |
| `server/services/ports.ts` | `PortRange`, `PROCESS_PORTS`, `isPortFree(port)`, `allocatePort(taken, range?)` |
| `server/services/processRunnable.ts` | `SpawnArgs`, `spawnArgsFor(root, m)`, `RunState`, `RunInfo`, `Runnable`, `createProcessRunnable(root)` |
| `server/services/routes.ts` | `handleServiceRoutes(req, res, url, supervisor, log): Promise<boolean>` |
| `server/services/supervisor.ts` | `ReconcilePlan`, `reconcilePlan(declared, running)`, `ServiceStatus`, `Supervisor`, `createSupervisor(root)` |
| `src/agent/health.ts` | `errorsSince`, `subscribe`, `reportRenderError`, `waitForHmr` |
| `src/agent/healthReport.ts` | `ProblemKind`, `Problem`, `isAppBroken`, `signatureOf`, `buildReport` |
| `src/agent/loop.ts` | `HealthStatus`, `AgentCallbacks`, `runAgentTurn` |
| `src/agent/openrouter.ts` | `Usage`, `StreamResult`, `streamChat` |
| `src/agent/serviceHealth.ts` | `ServiceStatus` (eigene Kopie der Server-Form, `kind: 'process'\|'container'`), `problemsFromServices` |
| `src/agent/systemPrompt.ts` | `SYSTEM_PROMPT` |
| `src/agent/tools.ts` | `toolSchemas`, `ToolExecution`, `executeTool(name, argsJson, turnId)` |
| `src/agent/types.ts` | `ToolCall`, `ChatMessage`, `TranscriptItem` |
| `src/agent/verify.ts` | `verifyApp`, `rollbackTurn(turnId): Promise<string\|null>` |
| `src/chat/AppErrorBoundary.tsx` | `AppErrorBoundary` |
| `src/chat/Chat.tsx` | `Chat` |
| `src/chat/CommitList.tsx`, `MessageInput.tsx`, `MessageList.tsx`, `ModelPicker.tsx`, `ServicesPanel.tsx`, `ToolCallCard.tsx` | gleichnamige Komponente |
| `src/chat/format.ts` | `formatUsd` |
| `src/chat/store.ts` | `ChatState`, `subscribe`, `getSnapshot`, `sendMessage`, `newChat`, `repairNow` |
| `src/chat/chat.css` | Styles der Chat-UI |
| `src/App.tsx` | `default App`, `useTodos` |
| `src/main.tsx` | – |
| `src/components/*.tsx` | `Calendar`, `ComponentsShowcase`, `ErrorTestButton`, `HelloWorld`, `NotesPage`, `SearchBar`, `TodoList`; dazu `Calendar.css`, `NotesPage.css`, `SearchBar.css` |
| `src/index.css`, `src/App.css` | globale Styles |
| `services/notes-api/{index.ts, service.json, package.json}` | – |
| `scripts/embed.ts` | – |

`ChatMessage`:
```ts
| { role: 'system'; content: string }
| { role: 'user'; content: string }
| { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
| { role: 'tool'; tool_call_id: string; content: string }
```
`ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }`.

---

## Anhang B: Texte für das Modell (wörtlich)

### B.1 Systemprompt (`SYSTEM_PROMPT`)

````text
You are an internal coding agent embedded in the very web app you are chatting through: a Vite 8 + React 19 + TypeScript app called "ai-react". You modify this app's own source code using your tools, and the Vite dev server hot-reloads every change instantly — the user sees your edits live in the browser without a page reload.

Project layout (project-relative paths):
- index.html — app entry (read-only)
- src/main.tsx — React bootstrap, renders <App /> (read-only)
- src/App.tsx — the app shell; it renders the chat UI and is the place to mount new components/pages you create
- src/index.css, src/App.css — global styles (writable)
- src/components/ — put new components here (create it if missing)
- services/<name>/ — backend services you create. Each runs as its own Node process next to the dev server. You write the source files here; service.json and package.json are written by the server and are read-only for you.
- src/agent/, src/chat/, server/ — YOUR OWN runtime (agent loop, chat UI, dev-server API). Readable for context, but READ-ONLY: writes are rejected so you cannot break the chat you run in.
- vite.config.ts, package.json, tsconfig*.json — read-only configuration.

Rules:
1. Use list_files first when you are unsure about the current structure, and read_file before modifying an existing file.
2. write_file overwrites the whole file — always provide the COMPLETE new content, never a fragment or diff.
3. You cannot install npm packages or run shell commands. Use only React 19, TypeScript, and plain CSS.
4. Keep edits minimal and focused on what the user asked. Match the existing code style.
5. To make a new component visible, import and render it from src/App.tsx (writable).
6. Before the first write of each of your turns, the server automatically commits a git snapshot, so the user can roll back your changes.
7. write_file rejects files that do not parse — you get the syntax error with line and column, and NOTHING is written. Send the complete corrected file.
8. After your final answer the dev server checks the app automatically: it loads every module you changed, collects runtime errors from the browser and runs a full type check. If something is broken you get an AUTOMATIC HEALTH CHECK message and must fix it — you have 3 attempts, after which your changes are rolled back to the snapshot. Messages marked AUTOMATIC come from the dev server, not from the user.
9. After making changes, briefly summarize what you changed and where the user can see it.
10. Backend services: call create_service first (the server assigns the port and tells you the browser URL), then write_file the entry file, then control_service to start it. The service MUST listen on Number(process.env.PORT) and 127.0.0.1, and must answer its health path (default GET /health) with status 200 — starting waits for that.
11. A service runs under Node's permission model: it may read and write only its own services/<name>/ directory, may use the network, and may import installed packages. It CANNOT read project files, .env, or spawn processes — do not try.
12. The browser must call a service through its proxy URL (e.g. fetch('/svc/notes-api/items')), never through http://localhost:PORT — the port can change and direct calls break with CORS.
13. If a service crashes, read service_logs before changing code. Do not restart it in a loop hoping it fixes itself.
14. You cannot install npm packages in this version, so services use Node built-ins only (node:http, fetch). Data that must survive a restart belongs in a file inside the service directory.
````

### B.2 Tool-Schemas (`toolSchemas`)

````json
[
  {
    "type": "function",
    "function": {
      "name": "list_files",
      "description": "List all files and directories in the project (paths relative to the project root). Use this first to orient yourself.",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read a text file from the project. Returns the full file content.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Project-relative path, e.g. \"src/App.tsx\""
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Create or overwrite a text file in the project with the given content. Parent directories are created automatically. Always write the COMPLETE file content. The agent runtime (src/agent, src/chat, server, config files) is read-only.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Project-relative path, e.g. \"src/components/NewThing.tsx\""
          },
          "content": {
            "type": "string",
            "description": "Complete new file content"
          }
        },
        "required": [
          "path",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "delete_file",
      "description": "Delete a file from the project. The agent runtime is protected and cannot be deleted. Use remove_service to delete a whole service.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Project-relative path"
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "create_service",
      "description": "Declare a new backend service that runs as its own Node process next to the dev server. The server assigns the port and returns the URL the browser must use. Write the service source with write_file afterwards, then start it with control_service.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "3-32 chars, lowercase letters, digits and dashes, e.g. \"notes-api\""
          },
          "kind": {
            "type": "string",
            "enum": [
              "process"
            ],
            "description": "Only \"process\" in this version"
          },
          "entry": {
            "type": "string",
            "description": "Entry file name inside the service directory, e.g. \"index.ts\""
          },
          "env": {
            "type": "object",
            "description": "Optional UPPER_SNAKE_CASE environment variables. PORT is set for you.",
            "additionalProperties": {
              "type": "string"
            }
          },
          "health": {
            "type": "object",
            "description": "Optional readiness probe; defaults to GET /health with a 10s timeout.",
            "properties": {
              "path": {
                "type": "string"
              },
              "timeoutMs": {
                "type": "number"
              }
            }
          }
        },
        "required": [
          "name",
          "kind",
          "entry"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "control_service",
      "description": "Start, stop or restart a declared service. Starting waits until the health path answers, so a successful result means the service is really up.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "action": {
            "type": "string",
            "enum": [
              "start",
              "stop",
              "restart"
            ]
          }
        },
        "required": [
          "name",
          "action"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "remove_service",
      "description": "Stop a service and delete its manifest and directory.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "service_status",
      "description": "List every declared service with its state, port and browser URL.",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "service_logs",
      "description": "Read the tail of a service's stdout/stderr — the first thing to check when it crashed.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "lines": {
            "type": "number",
            "description": "How many lines (default 50, max 200)"
          }
        },
        "required": [
          "name"
        ]
      }
    }
  }
]
````

---

## Anhang C: Konfigurationsdateien (wörtlich)

`package.json`:
```json
{
  "name": "ai-react",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "oxlint",
    "test": "node --experimental-strip-types --test tests/syntaxCheck.test.ts tests/tscCheck.test.ts tests/healthReport.test.ts tests/serviceManifest.test.ts tests/logBuffer.test.ts tests/servicePorts.test.ts tests/spawnArgs.test.ts tests/serviceSupervisor.test.ts tests/serviceHealth.test.ts",
    "preview": "vite preview",
    "embed": "node --experimental-strip-types --env-file=.env scripts/embed.ts"
  },
  "dependencies": {
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@openrouter/sdk": "^1.2.136",
    "@types/node": "^24.13.3",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^6.1.0",
    "oxlint": "^1.79.0",
    "typescript": "~6.0.2",
    "vite": "^8.2.2"
  }
}
```

`tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`tsconfig.app.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM"],
    "module": "esnext",
    "types": ["vite/client"],
    "allowArbitraryExtensions": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023"],
    "types": ["node"],
    "skipLibCheck": true,
    "module": "nodenext",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts", "server", "scripts"]
}
```

`vite.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { agentPlugin } from './server/agentPlugin.ts'

export default defineConfig({
  plugins: [react(), agentPlugin()],
})
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ai-react</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`.oxlintrc.json`:
```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

`.env.example`:
```
# Copy to .env and fill in. The key stays on the dev server; it is never sent to the browser.
OPENROUTER_API_KEY=
```

`.gitignore`: die Vite-Standardvorlage (Logs, `node_modules`, `dist`,
`dist-ssr`, `*.local`, Editor-Dateien) plus:
```
# Secrets (OpenRouter API key)
.env
.env.*
!.env.example
```

---

## Anhang D: Zuordnung der Nachbau-Lücken (v1 → v2)

| Lücke | Abschnitt in v2 | | Lücke | Abschnitt in v2 |
|---|---|---|---|---|
| 1 Modulpfade/Exporte | Anhang A | | 17 Datumsformat | 3.7, 9.7 |
| 2 Syntax-Zusatz | 2.4, 3.3 | | 18 Startfehler, Timeout | 4.3, E5 |
| 3 Manifest-Texte | 4.1 | | 19 Unbekannter Service, Reconcile | 4.4 |
| 4 parseManifest-Port | 4.1 | | 20 Proxy ohne Rest | 4.6 |
| 5 Service-Problemtexte | 7.1 | | 21 data.json in Git | E3 |
| 6 Testlauf, tsconfig | 1.1, Anhang C | | 22 Lint-Konfiguration | 1.1, Anhang C |
| 7 Systemprompt | Anhang B.1 | | 23 Loop-Details | 6 |
| 8 Text ohne Key | 3.2, E4 | | 24 Fehler seit Turn-Beginn | 7.1, E1 |
| 9 Abhängigkeiten, tsconfig | 1.1, Anhang C | | 25 Pfadformat der Fehler | 7.4 |
| 10 Absolute Pfade, Groß-/Kleinschreibung | 2.1 | | 26 Watchdog-Details | 8.4 |
| 11 Ungültiges JSON, Verzeichnis lesen | 3.1, 3.3 | | 27 Persistenz bei Deltas | 8.1 |
| 12 Hash-Format | 3.4 | | 28 UI-Texte | 9 |
| 13 Snapshot-Nachricht bei Rollback/Restore | 3.6 | | 29 Demo-Daten, Uhrzeit | 10, E2 |
| 14 Reconcile nach Restore | 3.6 | | 30 embed.ts | 10.7 |
| 15 forget-Texte | 3.6 | | 31 Watcher-Ausnahme | keine im Original |
| 16 Probe-Dateitypen | 3.5 | | | |
