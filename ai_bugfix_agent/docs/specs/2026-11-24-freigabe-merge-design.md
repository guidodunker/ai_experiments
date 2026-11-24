# Bugfix-Agent: Freigabe im Chat und Merge – Design

Stand: 2026-11-24

## Ziel

Steht ein Ticket auf `pr_offen`, kann jemand im Slack-Thread der Meldung „approved“ oder „freigegeben“ schreiben. Der Chat-Agent setzt das Ticket dann auf `freigegeben`. Beim nächsten `npm run steps` merged ein neuer Schritt `merge` den Pull Request per Squash in `TARGET_BASE`, löscht den Branch, schließt das Issue und setzt `erledigt`.

## Umfang

Enthalten:

- Erkennung der Freigabe im Code des Chat-Agenten, vor dem LLM
- Absender einer Nachricht (`Post.author`) aus Slack
- Schritt `merge` (`freigegeben` → `erledigt` oder `merge_gescheitert`)
- `TicketStore.close`
- Merge, Branch löschen und PR-Status über die GitHub-API

Nicht enthalten:

- Prüfung, wer freigeben darf (`SLACK_APPROVERS`, siehe Sicherheit)
- Freigabe über ein Review auf GitHub
- Automatisches Aktualisieren des lokalen `TARGET_BASE`

## Freigabe im Chat

### Erkennung

Eine Antwort gilt als Freigabe, wenn ihr Text nach `trim()` ohne Beachtung der Groß- und Kleinschreibung genau `approved` oder `freigegeben` lautet, höchstens gefolgt von einem `!` oder `.`. Reine Funktion `isApproval(text)` in `src/approval.ts`.

Beispiele: `approved`, `Approved!`, `freigegeben.` sind Freigaben. `approved? noch nicht`, `ok`, `approved bitte`, `👍` nicht.

### Ablauf in `runOnce`

Für jedes Ereignis `NewReply` in einem Thread mit Ticket prüft `runOnce` vor `handleEvent`, ob die Antwort eine Freigabe ist. Wenn ja, ruft es `handleApproval` statt `handleEvent` auf. Das LLM sieht die Antwort nicht. Danach wird das Ereignis wie jedes andere im Zustand vermerkt.

`handleApproval`:

1. Ticket über `store.read(id)` lesen.
2. Status `pr_offen`:
   - `store.appendReply(id, { level, text: 'Freigegeben im Slack-Thread von <author>.' }, now)`. Ohne Autor (Datei-Quelle) steht dort `unbekannt`.
   - `store.applyResult(id, { status: 'freigegeben', fields: { freigegeben_von: <author> }, summary: '' })`
   - Antwort im Thread: `<label> freigegeben. Der nächste Lauf von npm run steps merged <pr>.`
   - Log: `Thread <index> → Freigabe für <label> von <author>.`
3. Status `freigegeben`: Antwort `<label> ist schon freigegeben.`
4. Anderer Status: Antwort `<label> kann noch nicht freigegeben werden, Status ist <status>.`

Antworten laufen wie bisher über `reply` und scheitern nur weich. Wirft `store.read` oder `store.applyResult`, bricht der Lauf ab und wiederholt das Ereignis beim nächsten Mal.

### Absender

- `Post` bekommt das optionale Feld `author`.
- `toThreads` setzt es für Slack auf `user` der Nachricht, z. B. `U0ABC123`. In Antworten an Slack erscheint es als Erwähnung `<@U0ABC123>`, im Ticket als `U0ABC123`.
- `parseChat` setzt kein `author`.

## Schritt Merge

`accepts: 'freigegeben'`. Nur aktiv, wenn `GITHUB_TOKEN` und `GITHUB_REPO` gesetzt sind.

1. PR-Nummer aus dem Kopffeld `pr` (letzte Zahl der URL). Fehlt das Feld oder enthält es keine Nummer, scheitert der Schritt.
2. PR lesen (`GET /repos/{repo}/pulls/{n}`).
   - Schon gemergt: weiter mit Schritt 4, Merge-Commit aus `merge_commit_sha`.
   - Geschlossen ohne Merge: Ergebnis `merge_gescheitert`, Grund „PR #n ist geschlossen.“
3. Squash-Merge: `PUT /repos/{repo}/pulls/{n}/merge` mit `merge_method: 'squash'` und `commit_title: 'Fix <label>: <titel> (#<n>)'`. Bei HTTP 405 oder 409 (nicht mergebar, Konflikt, Head geändert): Ergebnis `merge_gescheitert` mit der Meldung von GitHub.
4. Branch löschen: `DELETE /repos/{repo}/git/refs/heads/<branch>` und `git branch -D <branch>` im Ziel-Repo. Scheitert eines davon, etwa weil der Branch schon fehlt, schreibt der Schritt eine Warnung ins Log und macht weiter.
5. `store.close(id)`. Bei GitHub: `PATCH /repos/{repo}/issues/{id}` mit `state: closed`, `state_reason: completed`. Bei Dateien: nichts.
6. Ergebnis: `status: erledigt`, Feld `merge_commit`, Abschnitt `## Merge` mit PR, Merge-Commit und Basis. Zusammenfassung: `gemergt in <base>: <pr>`.

Der Branch kommt aus dem Kopffeld `branch`, sonst aus `store.branch(id)`.

Ein Ticket mit `merge_gescheitert` setzt ein Mensch nach einer Korrektur per Label wieder auf `freigegeben`.

### Hinweis nach dem Merge

Neue Analysen starten vom lokalen `TARGET_BASE`. Nach einem Merge ist `origin/<TARGET_BASE>` voraus. Nach jedem Lauf, in dem mindestens ein Ticket `erledigt` wurde, schreibt `steps-main` ins Log: `<TARGET_BASE> lokal aktualisieren: git -C "<TARGET_REPO>" pull`. Der Agent pullt nicht selbst, weil im Checkout gearbeitet wird.

## Schnittstellen

```ts
// src/types.ts
type Post = { level: number; text: string; author?: string }

// src/store/types.ts, TicketStore
close(id: number): Promise<void>

// src/store/github.ts, GitHubApi
getPull(number: number): Promise<{ state: 'open' | 'closed'; merged: boolean; mergeCommit?: string }>
mergePull(number: number, commitTitle: string): Promise<{ merged: true; sha: string } | { merged: false; message: string }>
deleteBranch(branch: string): Promise<void>
closeIssue(number: number): Promise<void>
```

Der Schritt bekommt `mergePull`, `getPull` und `deleteBranch` über eine kleine Schnittstelle `Merger` wie `Publisher` beim Fix, dazu `closeTicket` und `label` aus dem Store.

## Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| Freigabe in einem Thread ohne Ticket | wie jede Antwort ohne Ticket: nichts |
| Freigabe bei anderem Status | Antwort mit Status, keine Änderung |
| Freigabe doppelt | Antwort „schon freigegeben“ |
| `read` oder `applyResult` scheitert bei der Freigabe | Lauf bricht ab, nächster Lauf wiederholt |
| Kopffeld `pr` fehlt | Schritt scheitert, Status bleibt `freigegeben` |
| PR schon gemergt | Erfolg, Branch löschen und Schließen laufen trotzdem |
| PR geschlossen ohne Merge | `merge_gescheitert` |
| PR nicht mergebar (405, 409) | `merge_gescheitert` mit Meldung von GitHub |
| Branch löschen scheitert | Warnung, Merge zählt |
| Issue schließen scheitert | Schritt scheitert. Der nächste Lauf findet den PR gemergt und holt Branch und Schließen nach. |

## Sicherheit

- Die Freigabe prüft den Absender nicht. Jeder im Slack-Workspace kann einen Merge in `TARGET_BASE` auslösen. Das ist nur für den eigenen Demo-Workspace vertretbar. Vor einem echten Einsatz: Liste `SLACK_APPROVERS` mit erlaubten User-IDs.
- Die Erkennung liegt im Code, nicht beim LLM. Eine Meldung kann keine Freigabe herbeiformulieren.
- Gemergt wird nur der PR aus dem Ticket und nur über die API, mit Ziel `TARGET_BASE` aus dem PR selbst. Der Code fordert nie einen Merge nach `main` an.
- Wer freigegeben hat, steht im Ticket (`freigegeben_von`, Nachtrag).

## Tests

Ohne Netz:

- `approval`: Freigabe-Texte und Nicht-Freigaben aus „Erkennung“
- `slack-threads`: `author` aus `user`, auch bei Antworten
- `run` mit Fake-Quelle, Datei-Store und Fake-Modell:
  - Freigabe bei `pr_offen`: Status `freigegeben`, Feld `freigegeben_von`, Nachtrag mit Autor, Antwort im Thread mit PR, Modell nicht aufgerufen
  - Freigabe bei `analysiert`: nur Antwort mit Status, Modell nicht aufgerufen
  - Freigabe doppelt: Antwort „schon freigegeben“
  - normale Antwort („ok“) geht weiter ans Modell
- `merge` mit Fake-Merger, Fake-Close und temporärem Git-Repo:
  - Erfolg: Squash mit Titel `Fix #7: Summe falsch (#3)`, Remote- und lokaler Branch gelöscht, Ticket geschlossen, `erledigt` mit `merge_commit`
  - PR schon gemergt: keine zweite Merge-Anfrage, `erledigt`
  - PR geschlossen: `merge_gescheitert`
  - nicht mergebar: `merge_gescheitert` mit Meldung
  - `pr` fehlt: Fehler
  - Branch löschen scheitert: Warnung, `erledigt`
- `github-client`: `getPull`, `mergePull` (200 und 405), `deleteBranch`, `closeIssue`
- `GitHubStore.close`, `FileStore.close`

Manueller Lauf:

1. Im Slack-Thread von #15 `approved` schreiben
2. Erwartet: Antwort `#15 freigegeben. Der nächste Lauf von npm run steps merged https://github.com/…/pull/17.`, Issue auf `status:freigegeben`
3. `$env:TICKET=15; npm run steps`
4. Erwartet: PR #17 als Squash gemergt in `ai-bugfix-agent`, Branch `bugfix/issue-15` auf GitHub und lokal gelöscht, Issue #15 geschlossen mit `status:erledigt`, in Slack `#15: erledigt gemergt in ai-bugfix-agent: …`, im Log der Hinweis auf `git pull`
