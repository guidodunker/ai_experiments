# Bugfix-Agent: Slack als Chat-Quelle – Design

Stand: 2026-11-24

## Ziel

Der Chat-Agent liest Bug-Meldungen wahlweise aus `chat.txt` oder aus dem Slack-Channel `#bugs`. Bei Slack antwortet er im Thread der Meldung: wenn ein Ticket entsteht, wenn ein Nachtrag angehängt wird und wenn `npm run steps` den Status eines Tickets ändert.

## Umfang

Enthalten:

- Schnittstelle `ChatSource` mit den Umsetzungen `FileSource` und `SlackSource`
- Rückmeldung in den Thread über `ChatReply`
- Stabile Thread-ID statt Position, Zustand als Objekt mit Umrechnung des alten Formats
- Kopffeld `quelle` im Ticket
- Statusmeldungen aus dem Runner von `npm run steps`

Nicht enthalten:

- Mehrere Channels
- Slash-Befehle, Buttons, Reaktionen per Emoji
- Auflösen von Erwähnungen (`<@U…>`) in Namen
- Rückfragen des Bots im Chat, etwa bei `nicht_reproduziert`
- Betrieb ohne Socket Mode, etwa über die Events API mit öffentlicher URL

## Stack

- Wie Stufe 1 und 2: TypeScript, Node mit `--experimental-strip-types`, Tests mit `node:test`
- `@slack/web-api` zum Lesen des Channels und zum Antworten
- `@slack/socket-mode` für die Events. Bolt wird nicht verwendet, weil der Agent nur ein Event braucht.

## Einrichtung in Slack

Der Nutzer legt einen eigenen, kostenlosen Workspace an, nicht den Firmen-Workspace, und erstellt die App aus diesem Manifest:

```yaml
display_information:
  name: Bugfix-Agent
features:
  bot_user:
    display_name: bugfix-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Danach erzeugt er ein App-Level-Token mit dem Scope `connections:write`, installiert die App, lädt den Bot mit `/invite @bugfix-agent` in `#bugs` ein und liest die Channel-ID ab. `users:read` braucht diese Stufe nicht. Der Scope bleibt im Manifest, damit die App für eine spätere Namensauflösung nicht neu installiert werden muss. Das README beschreibt die Schritte.

## Konfiguration

In `.env`:

| Variable | Bedeutung | Default |
|---|---|---|
| `CHAT_SOURCE` | `datei` oder `slack` | `datei` |
| `SLACK_BOT_TOKEN` | Bot-Token `xoxb-…` | – (Pflicht bei `slack`) |
| `SLACK_APP_TOKEN` | App-Level-Token `xapp-…` für den Socket Mode | – (Pflicht bei `slack`) |
| `SLACK_CHANNEL_ID` | ID von `#bugs`, beginnt mit `C` | – (Pflicht bei `slack`) |

`CHAT_FILE` gilt weiter für `datei`. `npm run steps` braucht nur `SLACK_BOT_TOKEN`, und nur wenn ein Ticket `quelle: slack` hat.

## Architektur

```
Datei-Änderung ─┐                          ┌─► diff() ─► handleEvent() ─► Tools ─► ChatReply
                ├─► Lauf ─► readThreads() ─┤
Slack-Event ────┘                          └─► Zustand (state.json / state.slack.json)

npm run steps ─► Statuswechsel ─► ChatReply (nur bei quelle: slack)
```

Ein Lauf liest immer den vollständigen Stand der Quelle und übergibt ihn an das vorhandene `diff()`. Events lösen nur einen Lauf aus, sie werden nicht selbst ausgewertet. War der Agent offline, holt der erste Lauf alles nach.

| Datei | Aufgabe |
|---|---|
| `src/sources/types.ts` | Typen `ChatSource` und `ChatReply` |
| `src/sources/file.ts` | `FileSource`: `parseChat` und `watchChat` wie bisher |
| `src/sources/slack.ts` | `SlackSource`: Channel lesen, Socket Mode, Antworten |
| `src/sources/slack-threads.ts` | Slack-Nachrichten zu `Thread[]`. Reine Funktion. |
| `src/sources/config.ts` | Liest `CHAT_SOURCE` und die Slack-Variablen, liefert Quelle, Antwortfunktion und Zustandsdatei |
| `src/run.ts` | bekommt `source` und `reply` statt `chatPath` |
| `src/main.ts` | wählt die Quelle über `config.ts` |
| `src/steps/runner.ts` | meldet Statuswechsel über `reply` |
| `src/steps-main.ts` | baut `reply` für Slack, wenn `SLACK_BOT_TOKEN` gesetzt ist |

### Datentypen

```ts
type Thread = { id: string; index: number; top: Post; replies: Post[] }

type ChatSource = {
  name: 'datei' | 'slack'
  /** Vollständiger Stand. 'missing', wenn die Datei fehlt. */
  readThreads(): Promise<Thread[] | 'missing'>
  /** Ruft onChange bei jeder Änderung auf, entprellt. */
  watch(onChange: () => void): void
}

/** Antwortet im Thread. Wirft bei einem Fehler. */
type ChatReply = (threadId: string, text: string) => Promise<void>

type State = { threads: Record<string, ThreadState> }
```

`index` bleibt als laufende Nummer für Log-Zeilen. Wiedererkannt wird ein Thread nur über `id`.

## Thread-ID und Zustand

- `FileSource` setzt `id` auf die Position als Text (`"0"`, `"1"`, …). Für `chat.txt` ändert sich am Verhalten nichts.
- `SlackSource` setzt `id` auf den Zeitstempel `ts` des Top-Posts, z. B. `1764000000.123456`.
- `State.threads` wird von einem Array zu einem Objekt mit der ID als Schlüssel. `loadState` erkennt ein Array und rechnet es um: Eintrag an Position `i` wird zu Schlüssel `"i"`, `null` entfällt. Das gilt auch für `state.stufe1.json`.
- `diff()`, `applyEvent()`, `ensureThread()` und `create_ticket` arbeiten mit `thread.id` statt `thread.index`.
- Jede Quelle hat ihre eigene Zustandsdatei: `state.json` für `datei`, `state.slack.json` für `slack`. `state.slack.json` kommt in `.gitignore`.
- Die Tickets liegen für beide Quellen in `tickets/` und werden fortlaufend nummeriert.

## Ticketformat

- `thread:` enthält die Thread-ID.
- Neues Kopffeld `quelle:` mit `datei` oder `slack`, direkt nach `thread:`. Tickets ohne `quelle` gelten als `datei`.

```
id: 5
status: neu
erstellt: 2026-11-24T09:30:00
thread: 1764000000.123456
quelle: slack
titel: Suche mit Kleinbuchstaben findet Müller nicht
…
```

## Slack lesen

`SlackSource.readThreads()`:

1. Beim ersten Aufruf ermittelt `auth.test` die eigene `user_id` und `bot_id`. Das Ergebnis wird gemerkt.
2. `conversations.history` für `SLACK_CHANNEL_ID`, alle Seiten über `cursor`.
3. Für jede Nachricht mit `reply_count > 0`: `conversations.replies` mit `ts` der Nachricht, alle Seiten. Das erste Element ist der Top-Post selbst und wird übersprungen.
4. `slack-threads.ts` baut daraus `Thread[]`:
   - Top-Post: Nachricht aus der History, Ebene 1, `text` der Nachricht.
   - Antworten: Ebene 2, in der Reihenfolge von `ts`.
   - Ausgelassen werden Nachrichten mit `user` gleich der eigenen `user_id` oder `bot_id` gleich der eigenen `bot_id`, Nachrichten mit einem anderen `subtype` als `file_share` (Meldung mit Anhang, nur der Text zählt) und `thread_broadcast`, außerdem `thread_broadcast` in der History. Eine Antwort mit „Auch im Channel posten“ zählt damit nur als Antwort im Thread.
   - Ein Top-Post vom eigenen Bot wird samt Thread ausgelassen.
   - Threads sortiert nach `ts` aufsteigend, `index` ab 0 in dieser Reihenfolge.
5. Bearbeitete Nachrichten liefert die API mit neuem Text. `diff()` erkennt einen geänderten Top-Post wie bisher über den Hash. Eine bearbeitete Antwort bleibt unbemerkt, wie bei `chat.txt`.
6. Gelöschte Nachrichten fehlen in der Antwort. Ihr Zustand bleibt stehen, ein vorhandenes Ticket bleibt bestehen.

## Slack beobachten

`SlackSource.watch(onChange)`:

- Verbindet sich mit `SLACK_APP_TOKEN` über `SocketModeClient`.
- Bestätigt jedes Event sofort mit `ack()`.
- Ruft bei jedem `message`-Event aus `SLACK_CHANNEL_ID` `onChange` auf, entprellt mit 1 Sekunde. Events aus anderen Channels werden ignoriert.
- Ruft nach jedem Verbinden, auch nach einem Reconnect, `onChange` auf, damit Nachrichten aus der Zwischenzeit nachgeholt werden.
- `main.ts` schickt `onChange` wie bisher durch `createSerialRunner`. Es laufen nie zwei Läufe gleichzeitig.

## Rückmeldungen

Die Texte erzeugt der Code, nicht das LLM.

| Auslöser | Text |
|---|---|
| `create_ticket` erfolgreich | `Ticket bug-<id> angelegt: <titel> (<komponente>, <schweregrad>)` |
| `append_to_ticket` erfolgreich | `Nachtrag an bug-<id> angehängt.` |
| Runner, Statuswechsel | `bug-<id>: <status> – <summary>`. Ohne `summary` nur `bug-<id>: <status>`. |

Kein Ticket und kein Nachtrag ergeben keine Nachricht.

- `ToolContext` bekommt `reply: (text: string) => Promise<void>`, gebunden an die ID des Threads des aktuellen Ereignisses. Die Tools rufen es nach dem Schreiben und Speichern auf. `append_to_ticket` antwortet im Thread des Ereignisses, auch wenn das LLM eine andere Ticketnummer nennt.
- `FileSource` hat keinen Kanal zurück. Ihre `ChatReply` schreibt `Antwort an Thread <id>: <text>` ins Log.
- `SlackSource` antwortet mit `chat.postMessage` (`channel`, `thread_ts` = Thread-ID, `text`).
- Der Runner liest nach dem Schreiben des Tickets `thread` und `quelle`. Bei `quelle: slack` ruft er die Slack-`ChatReply` auf. Fehlt `SLACK_BOT_TOKEN` oder `SLACK_CHANNEL_ID`, schreibt er eine Warnung ins Log und keine Nachricht.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| `CHAT_SOURCE` weder `datei` noch `slack` | Meldung beim Start, Exit-Code 2 |
| `CHAT_SOURCE=slack` und eine Slack-Variable fehlt | Meldung mit dem Namen der Variable, Exit-Code 2 |
| `auth.test` scheitert, etwa bei ungültigem Token | Lauf scheitert, im Watch-Modus wird der Fehler protokolliert |
| `conversations.history` oder `.replies` scheitert, etwa `not_in_channel` oder `channel_not_found` | Lauf scheitert vor dem ersten Ereignis, Zustand unverändert |
| Rate-Limit | `@slack/web-api` wiederholt selbst. Bleibt es dabei, scheitert der Lauf. |
| Antwort scheitert (Tool oder Runner) | Warnung mit Fehlertext ins Log. Das Ereignis oder der Statuswechsel gilt trotzdem als erledigt. Keine Wiederholung, weil sonst ein zweites Ticket oder ein doppelter Nachtrag entstehen könnte. |
| Socket-Verbindung bricht ab | Der `SocketModeClient` verbindet neu. Danach folgt ein Lauf. |

Ein gescheiterter Lauf setzt beim nächsten Lauf an derselben Stelle an, wie in Stufe 1.

## Sicherheit

Ein echter Slack-Workspace macht den Chat nicht vertrauenswürdiger als `chat.txt`. Es gilt weiter die Einschränkung aus Stufe 2: Freigabe nur für das Demo-Repo und für Testdaten in einem eigenen Workspace. Die Tokens stehen nur in `.env`, die per `.gitignore` ausgeschlossen ist, und erscheinen nicht im Log.

## Tests

Unit-Tests ohne Netz:

- `slack-threads`: Top-Posts und Antworten in `ts`-Reihenfolge; eigener Bot über `user` und über `bot_id` gefiltert; Thread mit Top-Post vom Bot fehlt; `channel_join` gefiltert; `file_share` bleibt; `thread_broadcast` nur als Antwort; Thread-ID gleich `ts`
- `SlackSource.readThreads` mit Fake-Client: mehrere Seiten in History und Replies; `auth.test` nur einmal; Replies nur bei `reply_count > 0`
- `SlackSource.watch` mit Fake-Socket: `message` aus `#bugs` löst nach Entprellen genau einmal aus; anderer Channel nicht; Verbinden löst aus
- `config`: `datei` als Default; `slack` mit fehlender Variable meldet ihren Namen; unbekannte Quelle
- `state`: altes Array-Format wird zum Objekt, `null` entfällt
- `diff`: Wiedererkennung über `id`, auch wenn sich `index` verschiebt
- `tools`: `create_ticket` schreibt `quelle` und ruft `reply` mit dem Anlagetext; `append_to_ticket` ruft `reply` mit dem Nachtragstext; scheiternde `reply` lässt das Ticket bestehen und erzeugt beim nächsten Lauf kein zweites
- `run`: mit Fake-Quelle statt Datei
- `runner`: Statuswechsel bei `quelle: slack` ruft `reply` mit Thread-ID; bei `quelle: datei` oder ohne `quelle` nicht; scheiternde `reply` lässt den Schritt als erfolgreich gelten
- Die vorhandenen Tests bleiben grün, angepasst an `id` und das neue `State`-Format.

Manueller Lauf im eigenen Workspace:

1. App nach „Einrichtung in Slack“ anlegen, Werte in `.env`, `CHAT_SOURCE=slack`
2. `npm run watch`
3. In `#bugs`: eine Bug-Meldung, eine Antwort mit Details darauf, eine Nachricht ohne Bug
4. Erwartet: Ticket mit `quelle: slack`, Antwort „Ticket bug-N angelegt …“ im Thread, Nachtrag im Ticket und Antwort „Nachtrag an bug-N angehängt.“, zur Nachricht ohne Bug keine Antwort. Die Antworten des Bots erzeugen keine weiteren Ereignisse.
5. Agent beenden, eine weitere Antwort schreiben, Agent starten: Die Antwort wird nachgeholt.
6. `npm run steps`: Im Thread erscheinen die Statuswechsel, z. B. `bug-N: analysiert – …` und `bug-N: geplant – …`.
