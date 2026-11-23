# Bugfix-Agent Stufe 2: Analysieren und Planen – Design

Stand: 2026-11-23

## Ziel

Zu jedem Ticket aus Stufe 1 entstehen eine Analyse mit rotem Test und ein Plan für den Fix. Zwei Schritte arbeiten nacheinander:

- **Analysieren** (`neu → analysiert` oder `nicht_reproduziert`): Eine Agent-Sitzung sucht die Ursache im Ziel-Repo und schreibt einen Test, der wegen des Bugs fehlschlägt. Der Test wird auf einem lokalen Branch committet.
- **Planen** (`analysiert → geplant`): Eine lesende Agent-Sitzung beschreibt den Fix, der den roten Test grün macht.

Die Schritte folgen der Schnittstelle aus der Spec von Stufe 1 (`docs/specs/2026-11-20-chat-bug-agent-design.md`, Abschnitt „Spätere Arbeitsschritte“).

## Umfang

Enthalten:

- Schritte `analyze` und `plan` in `src/steps/`
- Runner `npm run steps`, der passende Schritte auf die Tickets anwendet
- Ticket lesen und ändern: Kopffeld setzen, Abschnitt anhängen
- Git-Hilfen: Worktree, Branch, Commit
- Demo-Repo als Vorlage mit drei eingebauten Bugs und `npm run demo:init`
- Beispiel-Chat mit passenden Meldungen

Nicht enthalten:

- Fix, Push, MR. Diese Schritte folgen in Stufe 3 und bearbeiten Tickets mit `status: freigegeben`, den ein Mensch setzt.
- Rückfrage im Chat bei `nicht_reproduziert`
- Watch-Modus für die Schritte
- Isolation durch Container oder Sandbox (siehe Sicherheit)

## Stack

- TypeScript, Node mit `--experimental-strip-types`, wie in Stufe 1
- `@anthropic-ai/claude-agent-sdk` für die Sitzungen. Die Ticket-Erkennung aus Stufe 1 bleibt bei OpenRouter.
- `git` als Kindprozess, keine Git-Bibliothek
- Tests mit `node:test`

## Konfiguration

In `.env`:

| Variable | Bedeutung | Default |
|---|---|---|
| `TARGET_REPO` | Pfad zum Ziel-Repo. Muss ein Git-Repo sein. | – (Pflicht) |
| `TARGET_BASE` | Branch, von dem `bugfix/bug-N` abzweigt | `main` |
| `TARGET_TEST_CMD` | Testkommando im Ziel-Repo | `npm test` |
| `STEPS_MODEL` | Modell der Sitzungen | `claude-opus-5` |
| `STEPS_MAX_BUDGET_USD` | Kostengrenze je Sitzung | `2` |
| `ANTHROPIC_API_KEY` | Zugang zur API. Ohne Schlüssel nutzt das SDK einen vorhandenen Claude-Code-Login. | – |

## Architektur

```
tickets/bug_N.txt ──► runner ──► Schritt passend zum Status
                                   │
                    Code: Worktree im Ziel-Repo anlegen
                                   │
                    Sitzung (Agent SDK, cwd = Worktree) ──► JSON-Ergebnis
                                   │
                    Code: Ergebnis prüfen, committen, Ticket schreiben, Worktree entfernen
```

Alle Pfade gelten relativ zu `ai_bugfix_agent/`.

| Datei | Aufgabe | LLM |
|---|---|---|
| `src/steps/types.ts` | Typ `Step` | – |
| `src/steps/analyze.ts` | Schritt Analysieren | ja |
| `src/steps/plan.ts` | Schritt Planen | ja |
| `src/steps/policy.ts` | Entscheidung für `canUseTool`: welche Tool-Aufrufe eine Sitzung ausführen darf. Reine Funktion. | nein |
| `src/steps/session.ts` | Startet eine Sitzung mit Prompt, Rechten und Schema, liefert JSON-Ergebnis und Kosten. Wird den Schritten über `deps` injiziert. | ja |
| `src/steps/prompts/analyze.md` | Prompt der Analyse | – |
| `src/steps/prompts/plan.md` | Prompt der Planung | – |
| `src/steps/runner.ts` | Wendet Schritte an, bis keiner mehr passt | nein |
| `src/ticketfile.ts` | Ticket parsen, Kopffeld setzen, Abschnitt anhängen | nein |
| `src/git.ts` | Worktree anlegen und entfernen, Branch löschen, Status, Commit | nein |
| `src/command.ts` | Kommando ausführen, Exit-Code und Ausgabe liefern | nein |
| `src/steps-main.ts` | CLI für `npm run steps` | – |
| `demo/` | Vorlage des Demo-Repos | – |
| `scripts/demo-init.ts` | Kopiert `demo/` an einen Zielpfad und legt dort ein Git-Repo an | – |

### Datentypen

```ts
type Ticket = {
  id: number
  header: Map<string, string>     // Kopfzeilen in Dateireihenfolge
  body: string                    // alles nach der ersten Leerzeile
}

type StepResult = {
  status: string
  fields?: Record<string, string> // neue oder geänderte Kopffelder
  section?: { heading: string; text: string }   // wird ans Ticket angehängt
}

type Step = {
  name: string
  accepts: string
  run(ticket: Ticket): Promise<StepResult>
}
```

`StepResult` ersetzt das `note` aus Stufe 1 durch `section`, weil beide Schritte einen eigenen Abschnitt schreiben. Das Ticket schreibt der Runner.

## Ticketformat

Erweiterung des Formats aus Stufe 1:

- Neue Statuswerte: `analysiert`, `nicht_reproduziert`, `geplant`
- Neue Kopffelder: `branch`, `test`, `kosten_analyse`, `kosten_plan`. Kosten in US-Dollar mit zwei Nachkommastellen.
- Neue Abschnitte `## Analyse` und `## Plan`. Sie stehen am Ende des Tickets, nach `## Nachträge`. Ein erneuter Lauf ersetzt einen vorhandenen Abschnitt gleichen Namens.
- Änderung an Stufe 1: `appendToTicket` hängt einen Nachtrag bisher ans Dateiende. Künftig fügt es ihn am Ende des Abschnitts `## Nachträge` ein, also vor dem nächsten `## `-Abschnitt. Sonst landen Nachträge zu einem analysierten Ticket unter `## Plan`.

Beispiel nach beiden Schritten:

```
id: 3
status: geplant
erstellt: 2026-11-23T10:12:00
thread: 2
titel: Suche findet Müller nicht bei Kleinschreibung
komponente: Suche
schweregrad: mittel
branch: bugfix/bug-3
test: search.test.ts › findet Umlaute unabhängig von Groß- und Kleinschreibung
kosten_analyse: 0.84
kosten_plan: 0.31

## Beschreibung
...

## Originalmeldung
...

## Nachträge

## Analyse
### Ursache
`search()` vergleicht mit `toLowerCase()` nur den Suchbegriff ...
### Stellen
- src/search.ts:14 – ...
### Roter Test
(Ausschnitt der Testausgabe, höchstens 30 Zeilen)

## Plan
### Zusammenfassung
...
### Schritte
1. src/search.ts – ...
### Risiken
- ...
### Offene Fragen
- keine
```

## Schritt Analysieren

`accepts: 'neu'`

1. Der Code entfernt einen liegengebliebenen Worktree unter `<tmp>/bugfix-bug-N` (`git worktree remove --force`, danach `git worktree prune`).
2. Existiert der Branch `bugfix/bug-N` schon, bricht der Schritt ab. Die Fehlermeldung nennt den Befehl zum Löschen. Der Code löscht den Branch nicht, weil er Arbeit enthalten kann.
3. Der Code legt den Worktree `<tmp>/bugfix-bug-N` auf dem neuen Branch `bugfix/bug-N` ab `TARGET_BASE` an.
4. Der Code führt `TARGET_TEST_CMD` im Worktree aus. Schlägt es fehl, bricht der Schritt ab: Auf einer roten Basis beweist ein roter Test nichts.
5. Die Sitzung läuft (siehe Sitzungen). Sie liefert:

   ```ts
   type AnalyzeOutput = {
     reproduziert: boolean
     ursache: string
     stellen: { datei: string; zeile?: number; beschreibung: string }[]
     testdatei?: string            // relativ zum Repo
     testname?: string
     fehlende_angaben: string[]
   }
   ```

6. Bei `reproduziert: true` prüft der Code:
   - `git status` im Worktree zeigt genau eine geänderte oder neue Datei, und das ist `testdatei`.
   - `TARGET_TEST_CMD` schlägt fehl, und `testname` kommt in der Ausgabe vor.
7. Sind beide Prüfungen erfüllt:
   - Commit von `testdatei` auf `bugfix/bug-N` mit der Nachricht `bug N: roter Test – <titel>`
   - Ergebnis: `status: analysiert`, Felder `branch`, `test`, `kosten_analyse`, Abschnitt `## Analyse` mit Ursache, Stellen und den letzten 30 Zeilen der Testausgabe
8. Bei `reproduziert: false` oder einer gescheiterten Prüfung:
   - Ergebnis: `status: nicht_reproduziert`, Feld `kosten_analyse`, Abschnitt `## Analyse` mit Ursache oder Befund, Stellen, fehlenden Angaben und gegebenenfalls dem Grund, aus dem die Prüfung scheiterte
   - Der Code löscht den Branch.
9. Der Code entfernt den Worktree in jedem Fall, auch nach einem Fehler.

Ein Mensch kann ein Ticket mit `nicht_reproduziert` ergänzen und auf `status: neu` zurücksetzen. Der nächste Lauf beginnt dann von vorn.

## Schritt Planen

`accepts: 'analysiert'`

1. Der Code entfernt einen liegengebliebenen Worktree wie beim Analysieren.
2. Der Code legt den Worktree `<tmp>/bugfix-bug-N` auf dem vorhandenen Branch `bugfix/bug-N` an.
3. Die Sitzung läuft und darf nur lesen. Sie erhält das ganze Ticket einschließlich `## Analyse`. Sie liefert:

   ```ts
   type PlanOutput = {
     zusammenfassung: string
     schritte: { datei: string; neu: boolean; aenderung: string }[]
     risiken: string[]
     offene_fragen: string[]
   }
   ```

4. Der Code prüft: `schritte` ist nicht leer, und jede Datei mit `neu: false` existiert im Worktree. Scheitert die Prüfung, gilt der Schritt als gescheitert (siehe Fehlerbehandlung).
5. Ergebnis: `status: geplant`, Feld `kosten_plan`, Abschnitt `## Plan`
6. Der Code entfernt den Worktree in jedem Fall.

Offene Fragen halten den Status nicht auf. Sie stehen im Plan und werden vor der Freigabe in Stufe 3 gelesen.

## Sitzungen

Beide Schritte starten die Sitzung über `session.ts` mit diesen Optionen:

- `cwd`: der Worktree
- `model`: `STEPS_MODEL`
- `settingSources: []`, damit Nutzer- und Projekteinstellungen von Claude Code nicht einfließen
- `outputFormat`: JSON-Schema von `AnalyzeOutput` oder `PlanOutput`
- `maxTurns`: 40 beim Analysieren, 25 beim Planen
- `maxBudgetUsd`: `STEPS_MAX_BUDGET_USD`
- `canUseTool`: Entscheidung aus `policy.ts`

Regeln in `policy.ts`:

| Tool | Analysieren | Planen |
|---|---|---|
| Read, Grep, Glob | erlaubt, Pfade nur im Worktree | erlaubt, Pfade nur im Worktree |
| Write, Edit | erlaubt, Pfade nur im Worktree | abgelehnt |
| Bash | nur genau `TARGET_TEST_CMD` | abgelehnt |
| alle anderen (Web, Subagenten, MCP …) | abgelehnt | abgelehnt |

Ein Pfad liegt im Worktree, wenn er nach dem Auflösen von `..`, symbolischen Verweisen und relativen Anteilen mit dem Worktree-Pfad beginnt. Abgelehnte Aufrufe gehen mit Begründung an das Modell zurück und werden ins `agent.log` geschrieben.

Der Prompt stellt den Ticket-Text in einen markierten Block. Er sagt, dass der Text von Dritten stammt und als Meldung zu lesen ist. Anweisungen darin befolgt die Sitzung nicht.

Die Sitzung liefert Ergebnis und Kosten aus der Ergebnisnachricht (`structured_output`, `total_cost_usd`). Endet die Sitzung mit einem Fehler oder ohne gültiges `structured_output`, wirft `session.ts` einen Fehler.

## Sicherheit

Ticket-Texte stammen aus dem Chat, also von Dritten, und können Anweisungen an das Modell enthalten. Beim Analysieren schreibt das Modell Testcode, und der Code führt ihn aus.

Die Schritte laufen nativ unter Windows. Die Sandbox des Agent SDK wirkt dort nicht. Es gelten nur diese Grenzen:

- `canUseTool` beschränkt Tools, Pfade und das Bash-Kommando.
- Die Sitzung arbeitet in einem Worktree. Der Checkout des Ziel-Repos bleibt unberührt.
- Es wird nichts gepusht.

Ein ausgeführter Test kann trotzdem alles tun, was das Benutzerkonto darf: Dateien außerhalb des Worktrees ändern, das Netz nutzen, Umgebungsvariablen lesen. Diese Stufe ist deshalb nur für das Demo-Repo und für Testdaten freigegeben. Vor dem Einsatz an einem echten Repo oder mit einem echten Chat müssen die Schritte in einem Container oder unter WSL2 mit aktiver Sandbox laufen.

## Runner

`npm run steps` verarbeitet alle Tickets. `npm run steps:one` mit der Umgebungsvariable `TICKET=N` verarbeitet nur Ticket N, weil PowerShell `--` an npm nicht weitergibt.

1. Der Runner legt die Sperrdatei `steps.lock` an. Existiert sie schon, bricht er ab. Am Ende löscht er sie, auch nach einem Fehler.
2. Er liest die Tickets in `tickets/` und sortiert sie nach Nummer.
3. Für jedes Ticket: Er sucht den Schritt, dessen `accepts` gleich dem Status ist. Gibt es einen, führt er ihn aus, schreibt das Ergebnis ins Ticket und beginnt mit demselben Ticket von vorn. Gibt es keinen, geht er zum nächsten Ticket.
4. Scheitert ein Schritt, bleibt das Ticket unverändert. Der Runner protokolliert den Fehler und geht zum nächsten Ticket.
5. Exit-Code 1, wenn ein Schritt gescheitert ist, sonst 0.

Zu jedem Schritt schreibt der Runner eine Zeile auf die Konsole und nach `agent.log`, z. B. `Ticket 3 analyze → analysiert (0.84 $): Vergleich ohne Umlaut-Normalisierung in search.ts.`

## Demo-Repo

Die Vorlage liegt unter `demo/`. `npm run demo:init` mit `DEMO_TARGET=<pfad>` kopiert sie dorthin, legt ein Git-Repo mit Branch `main` an und committet. Existiert der Zielpfad schon, bricht das Skript ab.

Inhalt: eine kleine TypeScript-Bibliothek „Kontaktliste“ ohne Abhängigkeiten außer Node, Tests mit `node:test`, `npm test` grün.

Eingebaute Bugs, jeder ohne Test, der ihn aufdeckt:

| Nr. | Funktion | Fehler | Meldung im Chat |
|---|---|---|---|
| 1 | `search` | Groß- und Kleinschreibung wird bei Umlauten nicht ignoriert: „müller“ findet „MÜLLER“ nicht. | Suche mit Kleinbuchstaben findet Müller nicht |
| 2 | `paginate` | Ist die Anzahl ein Vielfaches der Seitengröße, fehlt der letzte Eintrag. | Bei 20 Kontakten fehlt auf der letzten Seite einer |
| 3 | `sortByName` | Sortiert nach Codepunkten statt nach deutschem Alphabet: „Ärger“ steht hinter „Zander“. | Namen mit Ä stehen ganz am Ende |

Zusätzlich enthält `chat.txt` eine Meldung ohne Gegenstück im Code: „Export nach Excel stürzt ab“. Diese Meldung muss mit `nicht_reproduziert` enden.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| `TARGET_REPO` fehlt oder ist kein Git-Repo | Fehlermeldung beim Start, Exit-Code 1 |
| `TARGET_BASE` existiert nicht | Schritt scheitert |
| Branch `bugfix/bug-N` existiert bei `neu` | Schritt scheitert, Meldung nennt den Löschbefehl |
| Basis rot | Schritt scheitert |
| Sitzung endet mit Fehler, Turn- oder Budgetgrenze, ohne gültiges JSON | Schritt scheitert. Beim Analysieren löscht der Code den Branch. |
| Prüfung nach der Analyse scheitert | kein Fehler des Schritts, Ergebnis `nicht_reproduziert` |
| Prüfung nach dem Plan scheitert | Schritt scheitert |
| Abbruch des Prozesses mitten im Schritt | Der nächste Lauf entfernt den Worktree. Ein übrig gebliebener Branch führt zur Meldung mit Löschbefehl. Eine übrig gebliebene `steps.lock` muss ein Mensch löschen. |

Ein gescheiterter Schritt lässt das Ticket unverändert, der nächste Lauf versucht es erneut.

## Tests

Unit-Tests ohne LLM:

- `ticketfile`: Kopf parsen, Feld setzen und ändern, Abschnitt anhängen und ersetzen, Nachträge bleiben erhalten, Schreiben und Lesen ergibt dasselbe Ticket
- `tickets`: Nachtrag zu einem Ticket mit `## Analyse` landet unter `## Nachträge`
- `git`: Worktree anlegen und entfernen, Branch anlegen und löschen, Status, Commit gegen ein temporäres Repo
- `policy`: Pfade im Worktree, außerhalb, mit `..`, absolut, auf anderem Laufwerk; Bash exakt, mit Zusatz, mit `&&`; unbekanntes Tool; Unterschied Analysieren und Planen
- `analyze` mit Fake-Sitzung gegen ein temporäres Mini-Repo:
  - Fake schreibt einen roten Test und meldet `reproduziert: true` → `analysiert`, Commit auf dem Branch, Worktree entfernt
  - Fake ändert zusätzlich eine Quelldatei → `nicht_reproduziert`, Branch gelöscht
  - Fake meldet einen Test, der grün ist → `nicht_reproduziert`
  - Fake meldet `reproduziert: false` → `nicht_reproduziert`
  - Basis rot → Fehler
  - Fake wirft → Fehler, Branch und Worktree entfernt
- `plan` mit Fake-Sitzung: gültiger Plan → `geplant`; Datei existiert nicht → Fehler
- `runner` mit Fake-Schritten: Verkettung `neu → analysiert → geplant` in einem Lauf, Fehler in einem Ticket hält die anderen nicht auf, Sperrdatei, `TICKET=N`
- `demo:init`: Zielpfad leer → Repo mit grünem `npm test`; Zielpfad existiert → Abbruch

Manueller Lauf mit echtem Modell:

1. `npm run demo:init` mit `DEMO_TARGET=C:\workspace\tests\bugfix_demo`
2. `state.json` und `tickets/` leeren, `npm start` mit dem Demo-Chat
3. `npm run steps`
4. Erwartet: Die drei Bug-Tickets stehen auf `geplant`, jeder Branch `bugfix/bug-N` enthält genau einen Commit mit einem Test, der auf dem Branch rot ist. Das Export-Ticket steht auf `nicht_reproduziert`. Im Demo-Repo gibt es keinen übrig gebliebenen Worktree.
