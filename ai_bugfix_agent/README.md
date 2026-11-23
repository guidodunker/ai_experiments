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
npm run watch          # beobachtet chat.txt dauerhaft (Strg+C beendet)
npm test
```

`npm start -- --watch` funktioniert in PowerShell nicht: PowerShell entfernt das `--`, und npm behält `--watch` für sich.

Der Agent merkt sich in `state.json`, was er schon verarbeitet hat. Löschen von `state.json` und `tickets/` setzt ihn zurück.

Zu jedem Ereignis schreibt der Agent eine Zeile mit seiner Entscheidung und Begründung auf die Konsole und nach `agent.log`, z. B. `Thread 3 → Kein Ticket: Wunsch nach Dark Mode, keine Fehlermeldung.`

Wird ein Top-Post ohne Ticket nachträglich geändert, bewertet der Agent ihn neu. Bei einem Top-Post mit Ticket meldet er die Änderung nur als Warnung.

## Erweitern

1. Neues Tool in `src/tools/` mit `defineTool` anlegen.
2. In `src/tools/index.ts` eintragen.
3. Das Verhalten in `src/prompt.md` beschreiben.

## Analysieren und Planen

`npm run steps` bearbeitet die Tickets in `tickets/` mit Sitzungen des Claude Agent SDK im Ziel-Repo `TARGET_REPO`:

- `neu` → `analysiert`: Ursache gefunden, ein roter Test liegt als Commit auf dem lokalen Branch `bugfix/bug-N`.
- `neu` → `nicht_reproduziert`: kein roter Test. Unter `## Analyse` steht, was fehlt. Nach einer Ergänzung `status: neu` setzen, dann versucht es der nächste Lauf erneut.
- `analysiert` → `geplant`: Unter `## Plan` steht der Fix.

```powershell
npm run steps                       # alle Tickets
$env:TICKET=3; npm run steps        # nur Ticket 3
Remove-Item Env:TICKET
```

Konfiguration in `.env`, siehe `.env.example`. Ohne `ANTHROPIC_API_KEY` nutzt das SDK einen vorhandenen Claude-Code-Login; die Sitzungen zählen dann gegen dessen Nutzungskontingent. Jede Sitzung ist auf `STEPS_MAX_BUDGET_USD` begrenzt. Die Kosten stehen im Ticket unter `kosten_analyse` und `kosten_plan`, bei einem Login als rechnerischer API-Preis.

Das Ziel-Repo muss ohne Installationsschritt testbar sein: Der Worktree enthält kein `node_modules`.

Bricht ein Lauf ab, bleibt eventuell `steps.lock` liegen. Läuft kein anderer Durchgang, die Datei löschen.

**Sicherheit:** Die Sitzungen laufen ohne Sandbox. Beim Analysieren schreibt das Modell einen Test, und der Agent führt ihn aus. Ein Test kann alles, was dein Benutzerkonto darf. Nur mit dem Demo-Repo und Test-Chats verwenden. Für echte Repos müssen die Schritte in einem Container oder unter WSL2 mit aktiver Sandbox laufen, siehe Spec.

### Demo

```powershell
$env:DEMO_TARGET="C:\workspace\tests\bugfix_demo"; npm run demo:init
```

legt das Demo-Repo „Kontaktliste“ mit drei eingebauten Bugs an. `demo-chat.txt` enthält passende Meldungen und eine, die sich nicht reproduzieren lässt.

Spec: `docs/specs/2026-11-23-analyse-plan-design.md`. Fix, Push und MR folgen in Stufe 3.
