# Selbstheilung des internen Agenten — Design

**Status: freigegeben am 2026-09-15.** Nächster Schritt: `writing-plans` für den
Implementierungsplan. Nichts davon ist bisher implementiert.

Ziel: Wenn der interne Coding-Agent die App kaputt macht, soll er das selbst erkennen und
korrigieren — statt dass der Nutzer eine weiße Seite sieht und manuell `/recovery` benutzt.

## Getroffene Entscheidungen (Brainstorming 2026-09-14)

| Frage | Entscheidung |
|---|---|
| Welche Fehlerarten? | Compile-/Typfehler beim Schreiben, Render-Crashes zur Laufzeit, Vite-HMR-/Import-Fehler. **Nicht**: allgemeines Console-Rauschen (Warnungen, fehlgeschlagene fetches). |
| Reaktion auf Fehler? | Reparieren, sonst Rollback. Begrenzte Reparaturversuche im laufenden Turn; scheitern sie, automatischer Reset auf den Pre-Write-Snapshot plus ehrliche Meldung. |
| Prüfzeitpunkt? | Hybrid: Syntaxfehler blocken den Write hart, Typ-/Import-Fehler werden geschrieben und gemeldet (Zwischenzustände mehrteiliger Änderungen sind legitim), voller Check am Turn-Ende. |
| Auslöser? | Gate am Turn-Ende **und** Watchdog danach. |
| Prüfmechanismus? | Variante C, gestaffelt: `ts.transpileModule` beim Write · Modul-Probe + gesammelte Laufzeitfehler am Turn-Ende · `tsc --noEmit` als gründlicher zweiter Durchgang. |

Am 2026-09-15 nachgezogen:

| Frage | Entscheidung |
|---|---|
| §4 Chat-Überleben | ErrorBoundary-Fallback rendert die Fehlerkarte **und** den Chat. Im Normalbetrieb bleibt alles wie heute — `App.tsx` rendert den Chat weiter selbst. |
| §5 Reparaturversuche | Maximal 3, zusätzlich vorzeitiger Abbruch bei Stillstand (unveränderte Fehlersignatur). |
| §7 Watchdog | Automatischer Reparatur-Turn nur innerhalb von 30 s nach Turn-Ende. Später erkannte Fehler erzeugen nur eine Karte mit „Reparieren"-Button. |

## Verifizierte Annahmen

- **Kein neues npm-Paket nötig.** Vite 8.2.2 bringt kein esbuild mehr (rolldown/oxc), aber
  `typescript` ~6.0.2 liegt bereits als devDependency vor.
  `ts.transpileModule(code, {reportDiagnostics: true, fileName: 'X.tsx', compilerOptions:
  {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext}})` hat genau die richtige
  Trennschärfe — getestet:
  - `export function A(){ return <div>{x</div> }` → `35: '}' expected.`
  - `const x: string = 1` → keine Diagnostics (reiner Typfehler, gehört in die tsc-Stufe)
- **`tsc --noEmit -p tsconfig.app.json` läuft in ~3,3 s** und ist im Ist-Zustand sauber.
- **`noUnusedLocals` / `noUnusedParameters` sind aktiv** → ein ungenutzter Import ist ein
  tsc-Fehler, aber *keine kaputte App*. Diese Abstufung ist in §5 eingebaut.
- **Der Agent kann seine eigene Absicherung nicht anfassen**: alles Neue liegt in `server/`,
  `src/agent/`, `src/chat/` — alle drei sind schreibgeschützt (`server/agentPlugin.ts:25`).
  Neu hinzu kommt `tests/`, das ebenfalls schreibgeschützt wird.
- **`tsc --noEmit --incremental -p tsconfig.app.json` funktioniert** (TS 6 erlaubt die
  Kombination) und meldet im Format `src/App.tsx(12,7): error TS2304: Cannot find name 'x'.`
  Warmlauf ~3,0 s, Kaltstart ~8,8 s — der Gewinn durch `--incremental` ist gering, der
  Löwenanteil ist Prozessstart.
- **Automatisierte Tests ohne neues Framework möglich**: `node --experimental-strip-types
  --test tests/x.test.ts` läuft mit `node:test`/`node:assert` direkt auf TypeScript-Dateien
  (verifiziert). Genutzt für die reinen Funktionen (Syntaxcheck, tsc-Parser, Report-Helfer);
  alles mit Browser- oder Git-Bezug bleibt manuelles Szenario.
- **Die Modul-Probe gehört auf den Server, nicht in den Browser** — siehe §3a.

## 1. Architekturüberblick

Drei Verteidigungslinien, von billig nach teuer:

| Linie | Wann | Prüft | Reaktion |
|---|---|---|---|
| Write-Gate | bei jedem `write_file` | Syntax (`ts.transpileModule`) | Write wird abgelehnt, Datei landet nie auf Platte |
| Turn-Gate | bevor der Turn endet | Modul-Probe · Laufzeitfehler · tsc | Reparatur-Iteration statt Turn-Ende |
| Watchdog | nach Turn-Ende | Laufzeit-/HMR-Fehler | Reparatur-Turn: automatisch < 30 s, danach per Button |

## 2. Write-Gate (`server/syntaxCheck.ts`, `server/agentPlugin.ts:217`)

Bei `.ts/.tsx/.js/.jsx` wird der Inhalt vor dem Schreiben durch `ts.transpileModule`
geschickt. Diagnostics → HTTP 422 mit
`Syntax error in src/X.tsx (line 12, col 7): '}' expected.` Das landet über den bestehenden
Fehlerpfad in `executeTool` (`src/agent/tools.ts:99`) als `ERROR: …` im Turn, der Agent
korrigiert in der nächsten Iteration. CSS wird nicht geprüft — kaputtes CSS macht die App
nicht kaputt.

**Reihenfolgeänderung:** heute Snapshot → Write (`server/agentPlugin.ts:233`), künftig
prüfen → Snapshot → Write. Sonst verbraucht ein abgelehnter Write den einmaligen Snapshot
des Turns.

## 3. Fehlersammler im Browser (`src/agent/health.ts`, neu)

Ringpuffer der letzten ~20 Fehler mit Zeitstempel, gespeist aus vier Quellen:

- `window.addEventListener('error')` und `'unhandledrejection'`
- `import.meta.hot.on('vite:error')` — der Inhalt des Vite-Overlays (Meldung, Datei, Zeile)
- `componentDidCatch` der ErrorBoundary (Fehler + Component-Stack)

API: `errorsSince(ts)`, `subscribe(cb)`, `reportRenderError(error, stack)`, `waitForHmr(timeoutMs)`.
Den Turn-Beginn stempelt die Loop selbst — der Sammler braucht dafür keinen Zustand.

Der Browser sammelt also nur, was **zur Laufzeit** schiefgeht. Ob ein Modul überhaupt lädt,
klärt der Server — siehe §3a.

## 3a. Modul-Probe auf dem Server (`POST /api/health/probe`)

Ursprünglich war die Probe im Browser geplant (dynamischer Import mit Cache-Buster). Der
Praxistest hat das widerlegt: Ein kaputtes Modul liefert über HTTP nur ein nacktes
`500` **ohne Body**, und eine fehlende Datei sogar `200 text/html` (SPA-Fallback) — sie sähe
damit gesund aus. Ein Import mit Cache-Buster würde zusätzlich bei jedem Durchlauf CSS erneut
injizieren und eine zweite Modulinstanz erzeugen.

Stattdessen stößt der Dev-Server die Transformation selbst an —
`server.environments.client.transformRequest(url)`. Verifiziert:

| Fall | Ergebnis |
|---|---|
| gesundes Modul | Result mit `code` |
| Syntaxfehler | wirft `Transform failed … [PARSE_ERROR] Unterminated regular expression … src/x.tsx:1:38` |
| unauflösbarer Import | wirft `Failed to resolve import "./Fehlt.tsx" from "src/x.tsx". Does the file exist?` |
| fehlende Datei | wirft `Failed to load url /src/Fehlt.tsx … Does the file exist?` |

Die Route nimmt `{ paths: string[] }`, invalidiert jeden Pfad vorher explizit
(`moduleGraph.getModuleByUrl` → `invalidateModule`, gegen Race zwischen Write und Watcher) und
gibt pro Pfad `null` oder die Fehlermeldung zurück. ANSI-Escapes werden entfernt, sonst landen
Terminalfarben im Prompt des Modells.

Geprüft werden `src/App.tsx` plus alle Dateien, die der Agent in diesem Turn geschrieben hat.
Damit sieht die Probe auch eine neu geschriebene Datei, die noch nirgends importiert ist.

## 4. ErrorBoundary, die den Chat am Leben hält (`src/chat/AppErrorBoundary.tsx`, `src/main.tsx`)

Das Stück, ohne das der Rest wertlos ist: Heute rendert `App.tsx` den `<Chat />` **in sich**
(`src/App.tsx:57`). Crasht App beim Rendern, stirbt der Chat mit — und ein Agent ohne Chat
kann sich nicht korrigieren.

Künftig rendert `main.tsx` `<AppErrorBoundary><App /></AppErrorBoundary>`. Das Fallback zeigt
eine Fehlerkarte **und darunter `<Chat />` direkt** — aus `src/chat`, unabhängig von
`App.tsx`. Ergebnis: App kaputt, Chat lebt, Agent repariert. Die Boundary resettet sich auf
`vite:afterUpdate`, damit die reparierte App ohne Reload wieder erscheint.

`src/main.tsx` ist für den Agenten bereits schreibgeschützt (`server/agentPlugin.ts:26`).

**Im Normalbetrieb ändert sich nichts**: `App.tsx` rendert den Chat weiterhin selbst als Seite
„Coding Agent", die Boundary ist unsichtbar. Nur im Crash-Fall erscheint der Chat im Fallback —
dann ohne Sidebar und Navigation, weil die zum abgestürzten Baum gehören. Das ist bewusst so:
Ein Crash soll sichtbar anders aussehen als der Normalzustand. Der Transkript-Zustand überlebt,
weil der Store modul-global ist (`src/chat/store.ts:1`).

## 5. Turn-Gate (`src/agent/loop.ts:61`)

Antwortet das Modell ohne Tool-Calls, endet der Turn künftig nur noch dann sofort, wenn in
diesem Turn nichts geschrieben wurde. Sonst:

1. auf HMR warten (`vite:afterUpdate`, max 600 ms)
2. `POST /api/health/probe` mit `App.tsx` + allen in diesem Turn geschriebenen Dateien
3. Laufzeitfehler seit Turn-Beginn (`errorsSince`)
4. `GET /api/health/typecheck` → tsc-Diagnostics

Sauber → Turn endet wie bisher. Sonst wird eine `user`-Nachricht mit dem Fehlerbericht
(Datei, Zeile, Meldung) angehängt und die Schleife läuft weiter. Maximal **3
Reparaturversuche**, dann Rollback.

**Abbruch bei Stillstand:** Aus jedem Fehlerbericht wird eine Signatur gebildet (sortierte
Liste aus `datei:zeile:code` bzw. Fehlermeldung bei Laufzeitfehlern). Ist die Signatur
identisch mit der des vorigen Versuchs, wird sofort abgebrochen und zurückgerollt, statt den
nächsten Versuch zu bezahlen — wenn sich nichts bewegt hat, bewegt sich auch nichts mehr.
Eine *veränderte* Signatur gilt als Fortschritt, auch wenn noch Fehler offen sind.

**Abstufung:** Nur Probe-Fehler und Render-Crashes gelten als „App kaputt" und können einen
Rollback auslösen. Reine tsc-Diagnostics (z.B. ungenutzter Import) werden gemeldet und
repariert, führen aber **nie** zum Rollback — sie brechen den Build, nicht die laufende App.
Sind nach dem letzten Versuch **nur noch** tsc-Diagnostics offen, endet der Turn regulär, die
Änderungen bleiben stehen, und der Agent sagt im Klartext, was noch offen ist („Die App läuft,
aber `npm run build` schlägt fehl: …").

**Laufzeitkosten:** Der tsc-Durchgang läuft auch im sauberen Fall, sonst würde er genau die
Fehler verpassen, für die er da ist. Ein Turn mit Writes wird dadurch am Ende rund 3 s länger;
Turns ohne Writes bleiben unverändert schnell. Gemildert durch `--incremental` (nutzt die in
`tsconfig.app.json` konfigurierte `tsBuildInfoFile`) und Single-Flight serverseitig: parallele
Anfragen warten auf denselben laufenden Check statt einen zweiten zu starten.

Neuer Callback `onHealth(status, detail)` in `AgentCallbacks`, damit der Chat eine eigene
Karte rendern kann („Health-Check: 2 Fehler → repariere …").

## 6. Rollback (`POST /api/git/rollback`)

Nach dem dritten Fehlversuch — oder vorzeitig bei Stillstand — und nur bei tatsächlich
kaputter App: Reset auf den Pre-Write-Snapshot dieses Turns,
vorwärts committet — dieselbe Mechanik wie `/api/git/restore` (`server/agentPlugin.ts:298`),
es wird nie Historie umgeschrieben. Dafür merkt sich der Server statt nur `lastSnapshotTurn`
(`server/agentPlugin.ts:125`) künftig `{turnId, hash}`.

Der Agent meldet danach ehrlich: „Ich habe die App kaputt gemacht und konnte es in 3
Versuchen nicht beheben. Meine Änderungen wurden auf `<hash>` zurückgerollt. Ursache: …"

## 7. Watchdog (`src/chat/store.ts`)

Nach Turn-Ende bleibt der Sammler scharf. Ein neuer Render-/HMR-Fehler, während der Chat idle
ist und der Agent in dieser Session geschrieben hat, wird nach seinem Abstand zum Turn-Ende
unterschiedlich behandelt:

- **Innerhalb von 30 s** → automatischer Reparatur-Turn. Der Schaden ist eindeutig frisch und
  der Nutzer wartet ohnehin noch auf das Ergebnis des Turns.
- **Später** → keine automatische Aktion, sondern eine Karte im Transkript: „App ist kaputt:
  `<Fehler>` [Reparieren]". Erst der Klick startet den Turn. So läuft kein Modellaufruf,
  während der Nutzer an etwas ganz anderem sitzt.

Beide Wege erscheinen als eigene Transkript-Karte, nicht getarnt als Nutzernachricht.

Grenzen, damit nichts Amok läuft: nie während `busy`, 1 s Debounce, jede Fehlersignatur nur
einmal, **maximal ein automatischer Reparatur-Turn in Folge** — scheitert der, schaltet der
Watchdog auf den Karte-mit-Button-Modus zurück und verweist auf `/recovery`.

## 8. Was der Entwurf nicht rettet

Erzwingt Vite einen Full-Reload und ein Modul kompiliert nicht, stirbt die Seite samt Chat —
kein Browser-Code kann sich dann selbst heilen. Genau diese Fehlerklasse fängt das Write-Gate
ab, bevor sie entsteht. `/recovery` (`server/recoveryPage.ts`) bleibt die letzte Instanz.

## 9. Test

Das Projekt hat kein Testframework; es wird keins eingeführt. Stattdessen manuelle Szenarien,
die der Implementierungsplan abarbeitet:

1. Agent schreibt Syntaxfehler → Write abgelehnt, Datei unverändert auf Platte
2. Agent schreibt `undefined.map()` in eine Komponente → Chat überlebt, Auto-Reparatur
3. `App.tsx` importiert nicht existierende Datei → Probe schlägt an
4. 3× fehlgeschlagene Reparatur → Rollback auf Snapshot, ehrliche Meldung
5. reiner Typfehler (ungenutzter Import) → gemeldet, **kein** Rollback
6. Zweimal identische Fehlersignatur → vorzeitiger Abbruch, kein dritter Versuch
7. Crash < 30 s nach Turn-Ende → Watchdog repariert automatisch
8. Nutzer navigiert Minuten später auf eine kaputte Seite → Karte mit „Reparieren"-Button,
   kein ungefragter Modellaufruf
9. Watchdog-Reparatur scheitert → kein zweiter Auto-Turn, Hinweis auf `/recovery`
10. Normalbetrieb ohne Fehler → Turn mit Writes endet rund 3 s später (tsc), Turn ohne Writes
    läuft ganz ohne Health-Check
11. Nach dem letzten Versuch sind nur noch tsc-Diagnostics offen → kein Rollback, Änderungen
    bleiben, Agent benennt den offenen Build-Fehler
