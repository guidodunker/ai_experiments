# Embedding-Testbett

Spielwiese zum Ausprobieren von KI-Embedding-Modellen an einem deutschen
Produktkorpus: 100 Baumarkt-Artikel in Postgres/pgvector, eingebettet über
OpenRouter, durchsuchbar über eine React-Seite und über die Kommandozeile.

Das Projekt ist als Testbett gebaut, nicht als Produkt. Wo eine Entscheidung
zwischen „schnell" und „nachvollziehbar" stand, ist sie zugunsten von
nachvollziehbar gefallen — etwa exakte statt approximierter Vektorsuche.

## Voraussetzungen

- Docker (für Postgres 18 + pgvector)
- Node 22 oder neuer (die Skripte nutzen `--experimental-strip-types`)
- Ein OpenRouter-Key: <https://openrouter.ai/keys>

## Schnellstart

```powershell
cp .env.example .env         # dann OPENROUTER_API_KEY eintragen
npm install
docker compose up -d         # Postgres auf Port 5436

# Testkorpus einspielen (nicht über eine PowerShell-Pipe — sonst leiden Umlaute)
docker cp db/seed/01_baumarkt_products.sql ai_embed_pgvector:/tmp/seed.sql
docker exec ai_embed_pgvector psql -U embed -d embed -v ON_ERROR_STOP=1 -f /tmp/seed.sql

# Korpus einbetten: 100 Produkte, ~13 s, ~7200 Tokens, unter einem Cent
npm run embed:index

npm run dev                  # Suchseite auf http://localhost:5173
```

## Aufbau

```
docker-compose.yml        Postgres 18 + pgvector, Port 5436
db/init/                  Schema, läuft beim ersten Containerstart
db/seed/                  100 Baumarkt-Produkte als Testkorpus
scripts/                  Indexierung und Suche auf der Kommandozeile
  lib/                    Modell-Registry, OpenRouter, Datenbank
server/searchPlugin.ts    HTTP-Backend der Suchseite (Vite-Plugin)
src/search/               React-Oberfläche
```

Seite und Kommandozeile teilen sich `scripts/lib/*`: gleiches Modell, gleiche
Präfix-Logik, gleiche Distanzfunktion. Wenn die Suchseite andere Ergebnisse
lieferte als `npm run embed:query`, wäre das ein Fehler, kein Feature.

Ausführlicher:
[db/README.md](db/README.md) (Schema, Datenmodell) ·
[scripts/README.md](scripts/README.md) (CLI, Modelle, Präfixe)

## Zwei Zeitpunkte, an denen gerechnet wird

Das ist der Punkt, um den das ganze Projekt gebaut ist.

**Indexierungszeit** — einmal pro (Dokument, Modell), wenn ein Produkt
dazukommt oder sich sein Text ändert. Offline, Latenz egal.

**Query-Zeit** — bei jeder Suchanfrage. Die Anfrage muss eingebettet werden,
bevor verglichen werden kann, und dieser API-Aufruf liegt auf dem kritischen
Pfad. Gemessen für „Wand streichen":

| | Embedding-API | Datenbank |
|---|---|---|
| Textsuche | 5194 ms | 65 ms |
| Empfehlung aus 3 Produkten | — | 3 ms |

Die Suche ist fast vollständig Wartezeit auf die API, nicht auf pgvector. Der
Hebel für Latenz liegt beim Query-Embedding, nicht bei der Datenbank. Die
Empfehlungssuche zeigt den Gegenpol: dort wird gar nichts eingebettet.

## Suchseite

`npm run dev`, dann <http://localhost:5173>.

Der Browser bekommt weder den OpenRouter-Key noch eine Datenbankverbindung zu
sehen — beides bleibt in `server/searchPlugin.ts`, einem Vite-Plugin nach dem
Muster von `ai_react/server/agentPlugin.ts`.

**Textsuche** — Anfrage in eigenen Worten. Verglichen wird Bedeutung, nicht
Stichwort: „meine Terrasse ist grün und schmutzig" findet den Hochdruckreiniger,
obwohl die Anfrage kein einziges Wort mit dem Produkttext teilt.

**Empfehlungen** — mehrere Produkte als `doc_id` eingeben, aus der Liste wählen
oder in der Textsuche per `+` übernehmen. Aus ihren Vektoren wird der Mittelwert
gebildet (`avg(embedding)` in SQL) und damit gesucht. Kein API-Aufruf, die
Vektoren liegen bereits im Korpus.

Dass der einfache Mittelwert die richtige Mittelrichtung ergibt, hängt daran,
dass die Vektoren auf Länge 1 normiert sind — nachgemessen, min = max = 1.0.
Bei unnormierten Vektoren würden längere Vektoren die Richtung still
dominieren; dann müsste vor dem Mitteln `l2_normalize()` stehen.

| Route | |
|---|---|
| `GET /api/status` | aktives Modell, Dimension, Größe des indexierten Korpus |
| `GET /api/products` | alle Produkte mit `doc_id` als Auswahlliste |
| `POST /api/search` | `{ query, k }` → Treffer, Embedding- und DB-Dauer getrennt |
| `POST /api/recommend` | `{ docIds, k, includeBasis }` → Treffer zum Zentroid |

## Kommandozeile

```powershell
npm run embed:index                       # Korpus einbetten, überspringt Vorhandenes
node --experimental-strip-types --env-file=.env scripts/query.ts "Hecke schneiden" --k=5
```

**Unter PowerShell nicht `npm run … -- --flag` verwenden.** `npm.ps1` schluckt
das `--`, die Argumente kommen nie im Skript an, und der Lauf startet still mit
den Standardwerten. Entweder `npm.cmd` nehmen oder direkt `node`. Details und
alle Optionen: [scripts/README.md](scripts/README.md).

## Konfiguration

Alles in `.env` (steht in `.gitignore`):

| | |
|---|---|
| `OPENROUTER_API_KEY` | von <https://openrouter.ai/keys> |
| `EMBEDDING_MODEL` | Standard `qwen3-8b`, Aliase in `scripts/lib/models.ts` |
| `DATABASE_URL` | `postgresql://embed:embed@localhost:5436/embed` |
| `POSTGRES_PORT` | 5436, weil 5432 auf diesem Rechner belegt ist |

`EMBEDDING_MODEL` gilt für Indexierung **und** Suche. Das ist Absicht: ein
Korpus, der mit Modell A eingebettet wurde, ist mit einer Anfrage aus Modell B
nicht durchsuchbar, auch nicht bei gleicher Dimension. Modellwechsel heißt
neu indexieren.

## Modellvergleich

`--model` und `--all` sind der ausdrückliche Weg in einen Mehrmodell-Vergleich.
`scripts/query.ts` gibt dann pro Modell die Rangliste aus und dazu eine Matrix,
wie stark sich die Modelle in den Top-k einig sind.

Absolute Distanzen sind dabei **nicht** zwischen Modellen vergleichbar — nur
Ranglisten. `intfloat/multilingual-e5-large` liefert für dieselbe Anfrage Werte
um 0,16, `openai/text-embedding-3-large` um 0,55; das sagt nichts über die
Trefferqualität aus.

## Grenzen

- Die Suchseite läuft nur auf dem Vite-Dev-Server. `npm run build` baut das
  Frontend, nicht das Backend. Für einen Produktivbetrieb müsste
  `server/searchPlugin.ts` ein eigener Prozess werden.
- Die Vektorsuche läuft als exakter Seq-Scan ohne ANN-Index. Bei 100 Produkten
  ist das schneller und ehrlicher als ein approximierter Index; ab einigen
  zehntausend Vektoren wäre `materialize_model()` aus `db/init/02_schema.sql`
  der nächste Schritt.
- Voyage (`input_type`) und Gemini (`task_type`) haben eigene Parameter für die
  Unterscheidung zwischen Anfrage und Dokument. Über die OpenAI-kompatible Route
  von OpenRouter sind die nicht setzbar — diese Modelle laufen hier unterhalb
  ihrer Möglichkeiten.
