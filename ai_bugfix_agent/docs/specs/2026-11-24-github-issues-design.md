# Bugfix-Agent: GitHub-Issues als Ticketsystem – Design

Stand: 2026-11-24

## Ziel

Tickets entstehen wahlweise als Dateien in `tickets/` oder als Issues im GitHub-Repo `GITHUB_REPO`. Bei GitHub sind die Issues die einzige Ablage: Der Chat-Agent legt sie an und hängt Nachträge an, `npm run steps` liest sie und schreibt Status, Analyse und Plan zurück. Die Slack-Antworten verlinken das Issue.

## Umfang

Enthalten:

- Schnittstelle `TicketStore` mit den Umsetzungen `FileStore` und `GitHubStore`
- Auswahl über `TICKET_STORE`
- Tools `create_ticket`, `append_to_ticket` und Runner arbeiten nur noch über den Store
- Branch-Name abhängig vom Store
- Slack-Texte mit Ticketbezeichnung und Link

Nicht enthalten:

- Migration der vorhandenen Datei-Tickets 1 bis 5
- Schließen von Issues durch den Agenten (folgt mit Stufe 3)
- Filter für Kommentare von Nicht-Mitgliedern (siehe Sicherheit)
- Webhooks: Der Runner liest Issues bei jedem Lauf

## Stack

- Wie bisher: TypeScript, Node mit `--experimental-strip-types`, `node:test`
- GitHub-REST-API mit `fetch`, ohne Octokit und ohne `gh`-CLI
- Header: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`

## Konfiguration

In `.env`:

| Variable | Bedeutung | Default |
|---|---|---|
| `TICKET_STORE` | `datei` oder `github` | `datei` |
| `GITHUB_TOKEN` | Fine-grained Personal Access Token, nur für `GITHUB_REPO`, Berechtigung „Issues: Read and write“ | – (Pflicht bei `github`) |
| `GITHUB_REPO` | `owner/name`, z. B. `guidodunker/ai_experiments` | – (Pflicht bei `github`) |

`npm start`, `npm run watch` und `npm run steps` wählen den Store gleich. Fehlt bei `github` eine Variable, bricht der Start mit Exit-Code 2 ab und nennt sie. Beim Start prüft `GET /repos/{repo}`, ob Token und Repo stimmen. Scheitert das, ebenfalls Exit-Code 2 mit der Meldung von GitHub.

## Architektur

| Datei | Aufgabe |
|---|---|
| `src/store/types.ts` | `TicketStore` |
| `src/store/file.ts` | `FileStore` aus dem bisherigen Code von `tickets.ts` und `ticketfile.ts` |
| `src/store/github.ts` | `GitHubStore` gegen die Schnittstelle `GitHubApi` |
| `src/store/github-format.ts` | Body, Kommentare und Ticket hin und zurück. Reine Funktionen. |
| `src/store/github-client.ts` | echte Umsetzung von `GitHubApi` mit `fetch`, Wiederholungen |
| `src/store/config.ts` | wählt den Store aus der Umgebung |
| `src/tools/*.ts`, `src/agent.ts`, `src/run.ts`, `src/main.ts` | Store statt `ticketDir` |
| `src/steps/runner.ts`, `src/steps-main.ts`, `src/steps/common.ts` | Store statt Dateien, Branch-Name vom Store |

`tickets.ts` und `ticketfile.ts` bleiben als Bausteine von `FileStore` bestehen.

### Schnittstelle

```ts
type TicketStore = {
  kind: 'datei' | 'github'
  /** Für Slack-Antworten und Logs: 'bug-5' bzw. '#7' */
  label(id: number): string
  /** Branch im Ziel-Repo: 'bugfix/bug-5' bzw. 'bugfix/issue-7' */
  branch(id: number): string
  create(thread: Thread, fields: TicketFields, source: SourceName, link?: string): Promise<{ id: number; url?: string }>
  /** false, wenn das Ticket nicht existiert */
  appendReply(id: number, entry: { level: number; text: string }, now: Date): Promise<boolean>
  /** Offene Tickets des Agenten, aufsteigend */
  list(): Promise<number[]>
  read(id: number): Promise<Ticket>
  /** Setzt Status und Felder, hängt den Abschnitt an, liefert das neue Ticket */
  applyResult(id: number, result: StepResult): Promise<Ticket>
}
```

`Ticket` und `StepResult` bleiben wie in Stufe 2. Analyse, Plan, Prompts und Policy ändern sich nicht. Der Worktree-Pfad folgt dem Branch: `<tmp>/bugfix-bug-N` bzw. `<tmp>/bugfix-issue-N`.

Der Branch-Name hängt vom Store ab, weil Issue-Nummern und Datei-Nummern unabhängig zählen. Im Demo-Repo existieren schon `bugfix/bug-1` bis `bugfix/bug-3` und `bugfix/bug-5`.

## Abbildung auf ein Issue

| Ticket | Issue |
|---|---|
| `id` | Issue-Nummer |
| `titel` | Titel |
| `status` | Label `status:<wert>`, genau eines |
| Zugehörigkeit | Label `bugfix-agent` |
| `komponente`, `schweregrad` | im JSON-Block, zusätzlich Labels `komponente:<wert>` und `schweregrad:<wert>` zum Filtern |
| `erstellt`, `thread`, `quelle`, `link`, `branch`, `test`, `kosten_analyse`, `kosten_plan` | im JSON-Block |
| `## Beschreibung`, `## Originalmeldung` | im Body |
| Nachtrag des Agenten | Kommentar, beginnt mit `<!-- bugfix-agent:nachtrag ebene=<n> -->` |
| `## Analyse`, `## Plan` | Kommentar, beginnt mit `<!-- bugfix-agent:abschnitt <Name> -->` |

### Body

```
<!-- bugfix-agent:kopf -->
| Feld | Wert |
|---|---|
| Quelle | [Slack-Thread](<link>) |
| Komponente | Suche |
| Schweregrad | mittel |
| Erstellt | 2026-11-24T09:20:59 |
| Branch | bugfix/issue-7 |
| Test | test/search-umlaute.test.ts › … |
| Kosten | Analyse 0.53 $, Plan 0.38 $ |
<!-- bugfix-agent {"erstellt":"…","thread":"…","quelle":"slack","link":"…","komponente":"Suche","schweregrad":"mittel"} -->
<!-- /bugfix-agent:kopf -->

## Beschreibung
…

## Originalmeldung
> …
```

Die Tabelle enthält nur Zeilen mit Wert. Sie wird bei jeder Änderung aus dem JSON neu erzeugt. Der Teil zwischen `<!-- bugfix-agent:kopf -->` und `<!-- /bugfix-agent:kopf -->` gehört dem Agenten. Der Rest des Bodys bleibt bei Änderungen unangetastet, auch wenn ein Mensch ihn bearbeitet hat. Fehlt der Kopfblock oder ist das JSON ungültig, wirft `read` einen Fehler mit der Issue-Nummer.

### Lesen

`read(id)` lädt Issue und alle Kommentare (alle Seiten) und baut daraus:

- Kopf in dieser Reihenfolge: `id`, `status` (aus dem Label), `erstellt`, `thread`, `quelle`, `link`, `titel` (Issue-Titel), `komponente`, `schweregrad`, danach `branch`, `test`, `kosten_analyse`, `kosten_plan`, soweit vorhanden
- Rumpf: der Body ohne Kopfblock, dann `## Nachträge` mit einem Eintrag je Nachtrag-Kommentar und je Kommentar ohne Markierung, in zeitlicher Reihenfolge, dann je Abschnittsname der jüngste Abschnitt-Kommentar
- Nachtrag-Eintrag: `### <erstellt, lokale Zeit> (Antwort, Ebene <n>)` bzw. `### <erstellt> (GitHub-Kommentar von @<login>)`, darunter der Text ohne Markierung

Hat ein Issue kein oder mehr als ein `status:`-Label, wirft `read` einen Fehler. Der Runner meldet ihn für dieses Ticket und macht mit dem nächsten weiter.

### Anlegen

`create` ruft `POST /repos/{repo}/issues` mit Titel, Body und den Labels `bugfix-agent`, `status:neu`, `komponente:<wert>`, `schweregrad:<wert>`. Rückgabe: Issue-Nummer und `html_url`.

### Nachtrag

`appendReply` prüft mit `GET /repos/{repo}/issues/{id}`, ob das Issue existiert und das Label `bugfix-agent` trägt, sonst `false`. Danach `POST …/comments` mit Markierung und Text.

### Ändern

`applyResult`:

1. Issue lesen.
2. Status-Labels tauschen: alle `status:`-Labels entfernen, `status:<neu>` setzen (`PUT …/labels` mit der vollständigen Liste).
3. Felder aus `result.fields` ins JSON übernehmen, Kopfblock neu erzeugen, Body mit `PATCH` schreiben.
4. Gibt es `result.section`, Kommentar mit Abschnittsmarkierung anlegen.
5. Ticket neu lesen und zurückgeben.

Schritte 2 bis 4 sind nicht atomar. Scheitert einer, wirft `applyResult`. Der Runner protokolliert dann Fehler und Zusammenfassung des Ergebnisses (siehe Fehlerbehandlung).

### Liste

`list` ruft `GET /repos/{repo}/issues?labels=bugfix-agent&state=open&per_page=100` über alle Seiten und lässt Pull Requests weg (Feld `pull_request`).

### Labels

Fehlende Labels legt der Store beim ersten Gebrauch an (`POST /repos/{repo}/labels`). Ob GitHub fehlende Labels beim Setzen selbst anlegt, wird bei der Umsetzung geprüft; dann entfällt dieser Schritt.

## Rückmeldungen in Slack

Die Texte nutzen `store.label(id)` und bei der Anlage die URL:

| Auslöser | Datei | GitHub |
|---|---|---|
| Anlage | `Ticket bug-5 angelegt: <titel> (<komponente>, <schweregrad>)` | `Ticket #7 angelegt: <titel> (<komponente>, <schweregrad>) <url>` |
| Nachtrag | `Nachtrag an bug-5 angehängt.` | `Nachtrag an #7 angehängt.` |
| Statuswechsel | `bug-5: <status> <summary>` | `#7: <status> <summary>` |

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| `TICKET_STORE` unbekannt, Variable fehlt, `GET /repos/{repo}` scheitert | Meldung beim Start, Exit-Code 2 |
| Netzfehler, HTTP 5xx, HTTP 403 oder 429 mit Rate-Limit | Client wiederholt dreimal, Wartezeit 1 s, 2 s, 4 s bzw. `Retry-After`. Danach Fehler. |
| HTTP 401, 404, 422 und andere | Fehler sofort, mit Status und `message` von GitHub |
| `create` oder `appendReply` scheitert | Lauf bricht ab, nächster Lauf setzt an derselben Stelle an. Kam die Anfrage an, die Antwort aber nicht, kann ein doppeltes Issue oder ein doppelter Kommentar entstehen. |
| `applyResult` scheitert nach erfolgreichem Schritt | Runner protokolliert `Ticket N <schritt>: Ergebnis nicht gespeichert: <fehler>` und die Zusammenfassung, zählt das Ticket als gescheitert. Beim Analysieren bleibt der Branch; der nächste Lauf meldet „Branch existiert“ mit Löschbefehl. |
| `read` scheitert (Kopfblock fehlt, Status-Label falsch) | Runner meldet den Fehler für dieses Ticket, nächstes Ticket |

## Sicherheit

- Das Repo `guidodunker/ai_experiments` ist öffentlich. Meldungen, Nachträge, Analyse und Plan sind für alle sichtbar. Freigabe nur für den Demo-Workspace und Testdaten.
- Kommentare ohne Markierung zählen als Nachtrag und erreichen Analyse und Plan. In einem öffentlichen Repo kann jeder mit GitHub-Konto kommentieren. Sie stehen im Ticket-Block, den die Prompts als Text von Dritten kennzeichnen. Vor einem echten Einsatz müssen sie auf Repo-Mitglieder gefiltert werden (`author_association`).
- Der Token steht nur in `.env` und erscheint nicht im Log. Fehlermeldungen enthalten nur Status und `message` von GitHub.
- Es gelten weiter die Einschränkungen aus Stufe 2: Sitzungen ohne Sandbox, nur Demo-Repo.

## Tests

Ohne Netz, mit Fake-`GitHubApi` im Speicher:

- `github-format`: Body erzeugen und zerlegen; Tabelle nur mit gesetzten Werten; Kommentar-Markierungen erkennen; unmarkierter Kommentar wird Nachtrag mit Login; mehrere Abschnitte, jüngster gilt; ungültiges JSON wirft
- `GitHubStore.create`: Labels, Body, Rückgabe von Nummer und URL
- `GitHubStore.read`: ergibt ein `Ticket`, das `formatTicketFile` lesbar ausgibt, mit Kopf in fester Reihenfolge
- `GitHubStore.applyResult`: Status-Label getauscht, Felder im JSON, Abschnitt als Kommentar, von Hand geänderte Beschreibung bleibt
- `GitHubStore.appendReply`: unbekanntes Issue und Issue ohne `bugfix-agent` ergeben `false`
- `GitHubStore.list`: mehrere Seiten, nur offene, ohne Pull Requests
- `github-client`: Wiederholung bei 503, sofortiger Fehler bei 401, Fehlertext ohne Token
- `FileStore`: die vorhandenen Ticket-Tests über die Schnittstelle
- Tools, `run` und Runner mit beiden Stores; Slack-Texte mit `bug-5` bzw. `#7` und URL
- `steps/common`: Branch- und Worktree-Name aus dem Store
- `config`: Default `datei`, fehlende Variable, unbekannter Store

Manueller Lauf:

1. Fine-grained Token für `guidodunker/ai_experiments` mit „Issues: Read and write“ anlegen, in `.env`: `TICKET_STORE=github`, `GITHUB_TOKEN`, `GITHUB_REPO`
2. `CHAT_SOURCE=slack`, `npm run watch`, in `#bugs` eine neue Bug-Meldung, eine Antwort darauf
3. Erwartet: Issue mit Labels `bugfix-agent`, `status:neu`, Komponente, Schweregrad; Tabelle mit Slack-Link; Nachtrag als Kommentar; in Slack `Ticket #N angelegt: … <url>` und `Nachtrag an #N angehängt.`
4. Im Issue von Hand einen Kommentar schreiben
5. `$env:TICKET=<N>; npm run steps`
6. Erwartet: Label `status:geplant`, Kommentare `## Analyse` und `## Plan`, Tabelle mit Branch, Test und Kosten; Branch `bugfix/issue-N` im Demo-Repo; in Slack `#N: analysiert …` und `#N: geplant …`; `store.read(N)` zeigt den Kommentar aus Schritt 4 unter `## Nachträge` als `(GitHub-Kommentar von @<login>)`
