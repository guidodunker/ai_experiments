# Chat-Bug-Agent – Design

Stand: 2026-11-20

## Ziel

Ein Agent überwacht einen Chat, der in einer Textdatei liegt. Er erkennt Bug-Meldungen in Top-Threads und legt dafür Tickets als Dateien an. Antworten auf Threads mit Ticket werden dem Ticket als Nachtrag hinzugefügt.

Der Agent ist der erste Baustein einer späteren Pipeline: Ticket anlegen → Bug analysieren → Plan erstellen → Bugfix coden und testen → Branch erstellen, committen, pushen → MR erstellen. Umgesetzt wird jetzt nur der erste Schritt. Die Struktur hält die übrigen offen.

## Umfang

Enthalten:

- Parser für das Chat-Format
- Erkennung neuer Top-Threads und neuer Antworten über einen gespeicherten Zustand
- LLM-Agent mit den Tools `create_ticket` und `append_to_ticket`
- Tickets `tickets/bug_N.txt` mit Statuskopf
- Einmallauf und `--watch`-Modus

Nicht enthalten:

- Arbeitsschritte nach dem Ticket (Analyse, Plan, Fix, Git, MR). Die Schnittstelle ist unten festgelegt, implementiert wird sie nicht.
- Erneute Bug-Erkennung, wenn ein Top-Post nachträglich geändert wird

## Chat-Format

- Eine Zeile, die mit genau `>` beginnt, startet einen Top-Post (Ebene 1).
- Eine Zeile, die mit `>>`, `>>>` usw. beginnt, startet eine Antwort. Die Anzahl der `>` ist die Ebene.
- Eine Zeile ohne `>`-Präfix setzt den vorigen Post fort (mehrzeilige Posts). Steht sie vor dem ersten Post, wird sie ignoriert.
- Ein Leerzeichen nach den `>` wird entfernt.
- Ein Thread besteht aus einem Top-Post und allen folgenden Antworten bis zum nächsten Top-Post.

Annahme: Die Datei wächst nur am Ende. Ein Thread wird über seine Position erkannt (Index des Top-Posts, ab 0).

## Stack

- TypeScript, Node mit `--experimental-strip-types`, wie im Nachbarprojekt `openrouter/`
- `@openrouter/agent` für den Tool-Loop, begrenzt mit `stepCountIs`
- `.env` mit `OPENROUTER_API_KEY`. Das Modell kommt aus `OPENROUTER_MODEL`, Default `~anthropic/claude-haiku-latest`
- Tests mit `node:test`

## Architektur

```
chat.txt ──► parser ──► Threads ──► diff (gegen state.json) ──► Ereignisse
                                                                  │
                                         pro Ereignis, in Reihenfolge
                                                                  ▼
                                   Agent (LLM + Tools) ──► tickets/bug_N.txt
                                                                  │
                                         nach jedem Ereignis: state.json speichern
```

Alle Pfade gelten relativ zu `ai_bugfix_agent/`.

| Datei | Aufgabe | LLM |
|---|---|---|
| `src/parser.ts` | `parseChat(text): Thread[]`. Reine Funktion. | nein |
| `src/diff.ts` | `diff(threads, state): { events: Event[], warnings: string[] }`. Reine Funktion. | nein |
| `src/state.ts` | Lädt und speichert `state.json`. Fehlt die Datei, gilt ein leerer Zustand. | nein |
| `src/tickets.ts` | Ticket anlegen, Nachtrag anhängen, Ticket lesen. Nummer = höchste vorhandene Nummer in `tickets/` + 1. | nein |
| `src/tools/create_ticket.ts` | Tool `create_ticket` | – |
| `src/tools/append_to_ticket.ts` | Tool `append_to_ticket` | – |
| `src/tools/index.ts` | Liste der Tools, die der Agent erhält | – |
| `src/prompt.md` | System-Prompt mit der Beschreibung der Verhalten | – |
| `src/agent.ts` | `handleEvent(event, context, deps)`. Ruft das LLM mit Prompt, Ereignis, Thread-Kontext und Tools auf. Der Modell-Aufruf wird über `deps` injiziert. | ja |
| `src/main.ts` | CLI: `npm start` für einen Lauf, `npm start -- --watch` für den Dauerbetrieb | – |

### Datentypen

```ts
type Post = { level: number; text: string }          // level 1 = Top-Post
type Thread = { index: number; top: Post; replies: Post[] }

type Event =
  | { kind: 'NewThread'; thread: Thread }
  | { kind: 'NewReply'; thread: Thread; reply: Post; replyIndex: number }

type ThreadState = { topHash: string; replyCount: number; ticket: number | null }
type State = { threads: ThreadState[] }               // Position = Thread-Index
```

`topHash` ist der SHA-256 des Top-Post-Texts.

### diff

Für jeden Thread im Chat:

- Thread-Index ohne Eintrag im Zustand: ein Ereignis `NewThread`, danach ein `NewReply` für jede bereits vorhandene Antwort.
- Bekannter Thread mit passendem Hash und mehr Antworten als `replyCount`: ein `NewReply` für jede neue Antwort.
- Bekannter Thread mit abweichendem Hash: eine Warnung, keine Ereignisse.

### Agent

Für jedes Ereignis gibt es einen eigenen LLM-Lauf mit:

- System-Prompt aus `src/prompt.md`
- Ereignis (Art, betroffener Post)
- dem kompletten Thread als Kontext
- der Ticketnummer des Threads oder dem Hinweis „kein Ticket“

Verhalten laut Prompt:

- `NewThread`: Ist der Top-Post eine Bug-Meldung, ruft der Agent `create_ticket` auf. Sonst tut er nichts.
- `NewReply` in einem Thread mit Ticket: Der Agent ruft `append_to_ticket` mit der Antwort auf, im Wortlaut oder zusammengefasst, wenn sie etwas zum Bug beiträgt.
- `NewReply` in einem Thread ohne Ticket: Der Agent tut nichts. Die Bug-Erkennung gilt nur für Top-Posts.

Erweitern bedeutet: ein neues Tool in `src/tools/` anlegen, es in `src/tools/index.ts` eintragen und das Verhalten in `src/prompt.md` beschreiben.

### Tools

`create_ticket(title, description, component, severity)`

- `severity` ist `niedrig`, `mittel` oder `hoch`.
- Das Tool ergänzt Kopf, Originalmeldung und Zeitstempel. Diese Teile schreibt nicht das LLM.
- Das Tool schreibt die Ticketnummer sofort in den Zustand des Threads.
- Hat der Thread schon ein Ticket, lehnt das Tool den Aufruf mit einem Fehlertext an das LLM ab.

`append_to_ticket(ticket, text)`

- Hängt unter `## Nachträge` einen Abschnitt mit Zeitstempel und Ebene an.
- Ist die Ticketnummer unbekannt, gibt das Tool einen Fehlertext an das LLM zurück und wirft keine Exception.

Beide Tools erhalten den Thread-Kontext des aktuellen Ereignisses vom Agenten, nicht vom LLM.

## Ticketformat

`tickets/bug_23.txt`:

```
id: 23
status: neu
erstellt: 2026-11-20T15:42:00
thread: 4
titel: Suche reagiert sehr langsam
komponente: Suche
schweregrad: mittel

## Beschreibung
Nutzer meldet, dass die Suche sehr langsam ist. Keine Angaben zu Datenmenge oder Suchbegriff.

## Originalmeldung
> Die Suche funktioniert sehr langsam.

## Nachträge
### 2026-11-20T15:50:00 (Antwort, Ebene 2)
>> oje
```

- Der Kopf besteht aus `schlüssel: wert`-Zeilen bis zur ersten Leerzeile. Spätere Schritte dürfen `status` ändern und Felder ergänzen, etwa `branch:` oder `mr:`.
- Neue Tickets haben immer `status: neu`.
- Zeitstempel in lokaler Zeit, ISO-Format ohne Zeitzone.

## Spätere Arbeitsschritte (nur Schnittstelle)

Jeder Schritt ist ein Modul in `src/steps/` mit der Form:

```ts
type Step = {
  name: string
  accepts: string                     // Status, den der Schritt bearbeitet, z. B. 'neu'
  run(ticket: Ticket): Promise<{ status: string; fields?: Record<string, string>; note?: string }>
}
```

Vorgesehene Statusfolge: `neu` → `analysiert` → `geplant` → `gefixt` → `mr_offen`.

Schritte mit Code- oder Git-Arbeit starten einen Coding-Agenten (Claude Code headless oder Agent SDK) in einem eigenen Git-Worktree. Der Chat-Agent führt keine Schritte aus.

Offene Frage für später: Ist das Ziel-Repo für Fixes dieses Repo oder ein konfigurierbares Repo?

## Fehlerbehandlung

- **LLM-Fehler oder Timeout:** Der Zustand ist bis zum letzten erfolgreichen Ereignis gespeichert. Der Lauf bricht mit einer Fehlermeldung und Exit-Code 1 ab. Der nächste Lauf versucht das Ereignis erneut. Doppelte Tickets verhindert die Sperre in `create_ticket`.
- **Schrittlimit erreicht** (`stepCountIs(4)`): Warnung, das Ereignis gilt als verarbeitet.
- **Top-Post geändert:** Warnung aus `diff`, keine Ereignisse für diesen Thread.
- **Watch-Modus:** `fs.watch` auf `chat.txt` mit 500 ms Debounce. Fehler werden geloggt und der Watcher läuft weiter. Läuft gerade ein Durchgang, wird genau ein weiterer vorgemerkt, nie zwei parallel.
- **Fehlende `chat.txt`:** Fehlermeldung und Exit-Code 1. Im Watch-Modus wird auf das Anlegen der Datei gewartet.

## Tests

- **Unit-Tests ohne LLM:**
  - `parser`: Ebenen, mehrzeilige Posts, Text vor dem ersten Post, leere Datei
  - `diff`: neuer Thread mit und ohne Antworten, neue Antworten, geänderter Hash
  - `tickets`: Nummerierung (leeres Verzeichnis, Lücken), Format, Anhängen
  - Tools gegen ein temporäres Verzeichnis, einschließlich doppeltem `create_ticket` und unbekannter Ticketnummer
- **Agent-Test mit Fake-LLM:** Das injizierte Modell liefert einen festen Tool-Aufruf. Geprüft wird, dass Ticket und Zustand stimmen.
- **Manueller Durchlauf mit echtem Modell:** `chat.txt` mit gemischten Beispielen (Bug, Frage, Lob, Antworten) verarbeiten und die Tickets prüfen.
