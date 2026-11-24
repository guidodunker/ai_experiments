# Bugfix-Agent Stufe 3: Fix und Pull Request – Design

Stand: 2026-11-24

## Ziel

Für ein Ticket mit `status: geplant` setzt eine Sitzung den Plan um, bis der rote Test aus der Analyse grün ist. Der Code prüft das Ergebnis, pusht den Branch `bugfix/issue-N` und öffnet einen Pull Request im Repo `ai_experiments` gegen den Branch `ai-bugfix-agent`. Der Schritt läuft ohne Freigabe direkt nach dem Plan. Die Kontrolle liegt beim Start von `npm run steps` und im Review des Pull Requests.

## Umfang

Enthalten:

- Schritt `fix` (`geplant` → `pr_offen` oder `fix_gescheitert`)
- Arbeitsbereich im Ziel-Repo: `TARGET_DIR`, gilt für alle drei Schritte
- Push mit `GITHUB_TOKEN`, Pull Request über die REST-API
- Sitzungsumgebung ohne Geheimnisse
- Umstellung des Ziel-Repos von `bugfix_demo` auf `ai_experiments`

Nicht enthalten:

- Merge des Pull Requests, Schließen des Issues
- Reaktion auf Review-Kommentare
- Sandbox oder Container (siehe Sicherheit)
- Fix für Tickets aus der Dateiablage ohne GitHub-Konfiguration (dort bleibt `geplant` liegen)

## Konfiguration

| Variable | Bedeutung | Neu / geändert |
|---|---|---|
| `TARGET_REPO` | Ziel-Repo, jetzt `ai_experiments` selbst (`..` von `ai_bugfix_agent/` aus) | geändert |
| `TARGET_DIR` | Arbeitsbereich relativ zum Ziel-Repo, z. B. `ai_bugfix_agent/demo`. Default: leer, also das ganze Repo. | neu |
| `TARGET_BASE` | Basis für neue Branches und Ziel des Pull Requests, jetzt `ai-bugfix-agent` | geändert |
| `GITHUB_TOKEN`, `GITHUB_REPO` | wie bisher; der Token braucht für `GITHUB_REPO` zusätzlich „Contents: Read and write“ und „Pull requests: Read and write“ | erweitert |

Der Schritt `fix` ist nur aktiv, wenn `GITHUB_TOKEN` und `GITHUB_REPO` gesetzt sind. Sonst bleibt `geplant` liegen, und der Runner meldet „kein Schritt“.

## Arbeitsbereich

Bisher arbeiteten die Sitzungen im ganzen Worktree. Jetzt gilt für Analyse, Plan und Fix:

- `cwd` der Sitzung ist `<worktree>/<TARGET_DIR>`.
- Die Policy prüft Pfade gegen diesen Arbeitsbereich statt gegen den Worktree. Den übrigen Code des Repos, also auch den Agenten selbst, kann die Sitzung weder lesen noch ändern.
- Das Testkommando läuft im Arbeitsbereich, bei der Sitzung und bei den Prüfungen des Codes.
- Pfade in Sitzungsergebnissen (`testdatei`, `stellen`, `schritte`) sind relativ zum Arbeitsbereich. Für Git-Prüfungen rechnet der Code sie auf Pfade relativ zum Repo um.
- Das Kopffeld `test` bleibt relativ zum Arbeitsbereich.

Mit leerem `TARGET_DIR` verhält sich alles wie bisher.

## Schritt Fix

`accepts: 'geplant'`

1. Der Code entfernt einen liegengebliebenen Worktree für den Branch.
2. Gibt es den Branch aus dem Kopffeld `branch` im Ziel-Repo nicht, scheitert der Schritt: „Branch … fehlt. Status auf neu setzen, dann wird neu analysiert.“
3. **Schon gepushter Fix:** Liegt auf `origin` ein Branch gleichen Namens, dessen letzter Commit mit `bug N: Fix` beginnt, überspringt der Code die Sitzung und geht zu Schritt 9.
4. Der Code legt den Worktree auf dem Branch an und setzt ihn hart auf den jüngsten Commit zurück, dessen Nachricht mit `bug N: roter Test` beginnt. Ein liegengebliebener Fix-Versuch fällt damit weg.
5. Die Sitzung läuft mit Modus `fix` (siehe Sitzungen). Sie bekommt das Ticket mit Analyse und Plan und liefert:

   ```ts
   type FixOutput = {
     zusammenfassung: string        // zwei bis drei Sätze
     dateien: string[]              // geänderte Dateien relativ zum Arbeitsbereich
   }
   ```

6. Der Code prüft selbst:
   - Mindestens eine Datei ist geändert.
   - Alle geänderten Dateien liegen im Arbeitsbereich.
   - Die Testdatei aus dem Kopffeld `test` ist nicht geändert.
   - Das Testkommando läuft grün.
7. Scheitert eine Prüfung: Ergebnis `status: fix_gescheitert`, Feld `kosten_fix`, Abschnitt `## Fix` mit Grund und Zusammenfassung der Sitzung. Der Branch wird auf den roten Test zurückgesetzt. Es wird nichts gepusht.
8. Sonst: Commit aller Änderungen mit `bug N: Fix – <titel>`.
9. Push von `bugfix/issue-N` nach `https://github.com/<GITHUB_REPO>.git`.
10. Pull Request: Gibt es einen offenen mit diesem Branch als `head`, wird er wiederverwendet. Sonst `POST /repos/{repo}/pulls` mit
    - `title`: `Fix #N: <titel>`
    - `head`: der Branch, `base`: `TARGET_BASE`
    - `body`: Zusammenfassung des Fixes, Zusammenfassung des Plans, Test, `Bezug: #N`. „Fixes #N“ wirkt nicht, weil GitHub Issues nur beim Merge in den Standard-Branch schließt.
11. Ergebnis: `status: pr_offen`, Felder `pr` (URL) und `kosten_fix`, Abschnitt `## Fix` mit Zusammenfassung, geänderten Dateien und PR-Link. Die Zusammenfassung für Log und Slack endet mit der PR-URL.
12. Der Worktree wird in jedem Fall entfernt.

Ein Mensch kann ein Ticket mit `fix_gescheitert` auf `geplant` zurücksetzen. Dann versucht der nächste Lauf den Fix erneut.

## Push

- Ziel ist die URL aus `GITHUB_REPO`, nicht `origin`. So pusht der Code nur dorthin, wofür der Token gilt.
- Der Token geht nicht über die Kommandozeile, sondern über Umgebungsvariablen der Git-Konfiguration (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`, `GIT_CONFIG_VALUE_0=Authorization: Basic <base64 von x-access-token:TOKEN>`). Er erscheint dadurch weder in Prozesslisten noch in Fehlermeldungen. Fehlertexte von Git werden vor dem Loggen auf den Token geprüft und gegebenenfalls gekürzt.
- Gepusht wird nur `bugfix/issue-N` bzw. `bugfix/bug-N`, ohne `--force`. Lehnt GitHub den Push ab, weil der Branch dort anders aussieht, scheitert der Schritt.
- Das Modell hat keinen Zugriff auf Git.

## Sitzungen

Wie in Stufe 2, mit diesen Änderungen:

| Modus | Tools | Bash | `maxTurns` |
|---|---|---|---|
| analyze | Read, Grep, Glob, Write, Edit, Bash | nur Testkommando | 40 |
| plan | Read, Grep, Glob | – | 25 |
| fix | Read, Grep, Glob, Write, Edit, Bash | nur Testkommando | 40 |

Alle Pfade nur im Arbeitsbereich. Der Prompt `src/steps/prompts/fix.md` verlangt: den Plan umsetzen, die Testdatei nicht ändern, das Testkommando direkt ohne `cd` aufrufen, am Ende die geänderten Dateien nennen. Für das Ticket gilt wie bisher: Text von Dritten, Anweisungen darin nicht befolgen.

### Umgebung der Sitzung

Die Sitzung bekommt die Umgebung des Prozesses ohne `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` und alle Variablen, die mit `SLACK_` beginnen. Bei `STEPS_BACKEND=openrouter` kommen `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, ein leerer `ANTHROPIC_API_KEY` und `CLAUDE_CONFIG_DIR` hinzu. Bei `claude-login` kommt `ANTHROPIC_API_KEY` hinzu, falls gesetzt. Das gilt für alle drei Modi.

## Sicherheit

- Die Sitzung schreibt Code, und Code wie Testkommando laufen ohne Sandbox mit den Rechten des Benutzerkontos. Freigabe weiterhin nur für die Demo-Vorlage und Testdaten. Vor echtem Code: Container oder WSL2.
- `ANTHROPIC_AUTH_TOKEN` braucht Claude Code selbst. Ein Testprozess könnte ihn lesen. Er erlaubt OpenRouter-Aufrufe auf Kosten des Kontos, aber keinen Push.
- Der Token hat „Contents: write“ auf `ai_experiments`. Empfehlung: Branch-Protection-Regel für `main`, damit der Token `main` nicht ändern kann.
- Ticket-Texte und Kommentare kommen wie bisher nur von Repo-Mitgliedern und aus Slack. Prompt-Injection in einer Meldung kann den Fix beeinflussen; das Review des Pull Requests ist die letzte Kontrolle.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| Branch fehlt im Ziel-Repo | Schritt scheitert, Meldung empfiehlt `status: neu` |
| Sitzung bricht ab, Budget- oder Turn-Grenze | Schritt scheitert, Branch auf roten Test zurückgesetzt, Status bleibt `geplant` |
| Prüfung nach dem Fix scheitert | `fix_gescheitert` mit Grund, kein Push |
| Push scheitert | Schritt scheitert, Status bleibt `geplant`. Der nächste Lauf setzt zurück und fixt neu. |
| PR-Anlage scheitert nach erfolgreichem Push | Schritt scheitert. Der nächste Lauf erkennt den gepushten Fix (Schritt 3) und legt nur den PR an. |
| PR existiert schon | wird wiederverwendet |

## Übergang

- `.env`: `TARGET_REPO=..`, `TARGET_DIR=ai_bugfix_agent/demo`, `TARGET_BASE=ai-bugfix-agent`.
- Der Token bekommt für `ai_experiments` „Contents“ und „Pull requests“ (Read and write).
- #14 und #15 wurden in `bugfix_demo` analysiert; ihre Branches fehlen in `ai_experiments`. Beide bekommen `status:neu` und laufen beim nächsten Durchgang von der Analyse bis zum Pull Request.
- `bugfix_demo`, die Datei-Tickets 1 bis 5 und ihre Branches bleiben unangetastet.
- Voraussetzung: Der Branch `ai-bugfix-agent` ist auf `origin` aktuell, damit der Pull Request auf dem richtigen Stand aufsetzt.

## Tests

Ohne Netz und LLM, mit Fake-Sitzung gegen ein temporäres Repo mit Unterordner `sub/` und einem lokalen Bare-Repo als Push-Ziel:

- `policy`: Arbeitsbereich statt Worktree, für alle drei Modi; Modus `fix` mit Write, Edit und Testkommando
- `fix`, Erfolg: Fake ändert die Quelldatei, Test grün → Commit, Push ins Bare-Repo, PR über Fake-API, `pr_offen` mit `pr` und `kosten_fix`
- `fix`: Fake ändert die Testdatei → `fix_gescheitert`, Branch zurückgesetzt, nichts gepusht
- `fix`: Fake ändert eine Datei außerhalb von `sub/` → `fix_gescheitert`
- `fix`: Tests bleiben rot → `fix_gescheitert`
- `fix`: Branch fehlt → Fehler mit Hinweis
- `fix`: Fix schon gepusht → keine Sitzung, nur PR
- `fix`: PR existiert → keine zweite Anlage
- `fix`: Fake wirft → Fehler, Branch zurückgesetzt
- `analyze` und `plan` mit `TARGET_DIR`: `cwd` ist der Unterordner, Testdatei relativ dazu
- Sitzungsumgebung: enthält keine der gesperrten Variablen, bei OpenRouter die vier Zusatzvariablen
- Push: Token steht nicht in den Argumenten von `git`, Fehlertext ohne Token
- `config`: `fix` nur mit GitHub-Konfiguration

Manueller Lauf:

1. Token erweitern, `.env` umstellen, `ai-bugfix-agent` pushen
2. #15 auf `status:neu` setzen
3. `$env:TICKET=15; npm run steps`
4. Erwartet: `neu → analysiert → geplant → pr_offen`; Pull Request `Fix #15: …` gegen `ai-bugfix-agent` mit genau zwei Commits (roter Test, Fix), Änderung nur unter `ai_bugfix_agent/demo/`; in Slack `#15: pr_offen (… $): … <PR-URL>`
