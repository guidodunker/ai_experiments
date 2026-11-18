# Vektorsuche: pgvector gegen Elasticsearch

Nimmt den Baumarkt-Korpus samt fertiger Embeddings aus [`ai_embed`](../../ai_embed/README.md),
kopiert ihn nach Elasticsearch und stellt für eine Suchanfrage die Trefferlisten
nebeneinander:

| Verfahren | Wie | Rolle |
|---|---|---|
| pgvector exakt | `ORDER BY embedding <=> q` | Referenz |
| ES exakt | `script_score` mit `cosineSimilarity`, Brute-Force | sollte identisch zur Referenz sein |
| ES kNN | `knn`-Query auf dem HNSW-Index | approximiert, Recall messbar |
| ES hybrid | `--hybrid`: BM25 auf `content` + kNN, Scores addiert | was pgvector so nicht kann |

```
ai_embed (pgvector, Port 5436)          elasticsearch (Port 9200)
documents + embeddings  ── sync.ts ──►  Index ai_embed_docs
                                          content, name, category, …
                                          emb_<modell>: dense_vector, ein Feld pro Modell
          ▲                                      ▲
          └──────────── compare.ts ──────────────┘
                 ein Query-Vektor pro Modell (OpenRouter), an alle Verfahren
```

Es wird **nichts neu eingebettet**: Elasticsearch bekommt dieselben Vektoren wie
pgvector. Unterschiede in den Trefferlisten liegen damit am Suchverfahren.

## Voraussetzungen

- `ai_embed` ist eingerichtet: Container läuft, Korpus eingespielt,
  `npm run embed:index` gelaufen, `ai_embed/.env` mit `OPENROUTER_API_KEY`.
  Die Skripte hier lesen genau diese `.env` und nutzen `ai_embed/scripts/lib/*`
  (Modell-Registry, Präfixe, OpenRouter, Datenbank).
- `npm install` in `ai_embed` **und** hier.
- Elasticsearch aus diesem Repo läuft. Postgres und Logstash von dort werden
  nicht gebraucht:

```powershell
cd ..                                   # Ordner elasticsearch
docker compose up -d elasticsearch
```

## Benutzung

```powershell
cd vector
npm install

# pgvector -> Elasticsearch, alle Modelle mit Vektoren, unquantisierter HNSW
node --experimental-strip-types --env-file=../../ai_embed/.env sync.ts

node --experimental-strip-types --env-file=../../ai_embed/.env compare.ts "Hecke schneiden"
node --experimental-strip-types --env-file=../../ai_embed/.env compare.ts "Wand streichen" --k=10 --hybrid
```

Interaktiv geht es über die Suchseite von `ai_embed` (`npm run dev` dort,
http://localhost:5173): der Schalter pgvector / Elasticsearch / ES hybrid im
Kopf wählt die Suchmaschine, bei hybrid mit einstellbarem Text-Gewicht.

Wie in `ai_embed`: unter PowerShell nicht `npm run … -- --flag`, `npm.ps1`
schluckt das `--`. Direkt `node` aufrufen oder `npm.cmd`.

### sync.ts

| Option | |
|---|---|
| `--model=a,b` / `--all` | nur diese Modelle; ohne Angabe alle, für die pgvector Vektoren hat |
| `--index-type=hnsw` | `index_options.type`: `hnsw`, `int8_hnsw`, `int4_hnsw`, `bbq_hnsw`, `flat`, `int8_flat`, `int4_flat`, `bbq_flat` |
| `--batch=20` | Dokumente pro `_bulk`-Request |

Der Index `ai_embed_docs` wird bei jedem Lauf gelöscht und neu angelegt.

**Standard ist `hnsw`, nicht der Standard von Elasticsearch.** Ohne Angabe
quantisiert Elasticsearch die Vektoren (bbq_hnsw ab 384 Dimensionen). Das spart
viel Speicher, kann aber Recall kosten. Mit `hnsw` liegen die Vektoren als float
vor wie in pgvector. Zum Vergleich mit `--index-type=bbq_hnsw` neu
synchronisieren und `compare.ts` erneut laufen lassen.

### compare.ts

| Option | |
|---|---|
| `--k=5` | Länge der Trefferlisten |
| `--num-candidates=50` | Kandidaten pro Shard bei kNN, die Recall-Stellschraube |
| `--model=a,b` / `--all` | Standard `EMBEDDING_MODEL`; `--all` = alle Modelle im Index |
| `--category=…` | Filter auf `meta.category`, in ES während der kNN-Suche |
| `--hybrid` | zusätzlich BM25 + kNN in einem Request |
| `--text-boost=0.1` | Gewicht des BM25-Anteils bei `--hybrid` |

Ausgabe pro Modell: vier Trefferlisten mit Cosine-Distanz (umgerechnet auf die
Skala von pgvector `<=>`), Laufzeit (`took` von Elasticsearch, bei pgvector
Roundtrip), Recall@k gegen die pgvector-Liste und die größte
Distanzabweichung zwischen ES exakt und pgvector. Ein `*` markiert Treffer, die
in der exakten Liste fehlen.

## Unterschiede zu pgvector, die hier sichtbar werden

- **Feste Dimension pro Feld.** `ai_embed` hält alle Modelle in einer
  dimensionslosen Spalte. `dense_vector` braucht `dims`, deshalb ein Feld
  `emb_<alias>` pro Modell. Dafür hat jedes Feld sofort einen HNSW-Index;
  `materialize_model()` entfällt.
- **4096 statt 2000 Dimensionen** für einen Index. `qwen3-8b` (4096) und
  `oai-3-large` (3072) brauchen keinen halfvec-Umweg.
- **Filter während der Graphsuche.** `knn.filter` liefert k Treffer auch bei
  engem Filter. pgvector mit HNSW filtert nach der Indexsuche und kann dabei
  Treffer verlieren (hier nicht sichtbar, weil pgvector exakt sucht).
- **Hybride Suche** ist ein Request: `query` und `knn` nebeneinander,
  Elasticsearch addiert die Scores. Der `rrf`-Retriever (Rangfusion, robuster
  gegen unterschiedliche Score-Skalen) ist in der Basic-Lizenz gesperrt:
  `HTTP 403 … current license is non-compliant for [Reciprocal Rank Fusion (RRF)]`.
  Die Score-Summe ist schief, weil kNN-Scores in [0, 1] liegen und BM25-Scores
  unbeschränkt sind; `--text-boost` gleicht das von Hand aus.
- **Scores sind keine Distanzen.** Bei `similarity: cosine` liefert kNN
  `(1 + cos) / 2`. `compare.ts` rechnet auf `1 − cos` zurück. Bei quantisierten
  Indextypen ist der Wert eine Näherung.

## Gemessen

Elasticsearch 9.5.5, `qwen3-8b` (4096 Dimensionen), 100 Produkte, 18.11.2026:

| Anfrage | Index | Recall gegen pgvector | max. Distanzabweichung ES exakt |
|---|---|---|---|
| „Hecke schneiden", k=5 | `hnsw` | 1.00 (kNN und exakt) | 2.9e-7 |
| „Wand streichen", k=5, `--hybrid` | `hnsw` | 1.00, hybrid zieht das Malerwalzen-Set auf Platz 1 | 1.3e-7 |
| „Hecke schneiden", k=3, `--category=Garten` | `hnsw` | 1.00 | 2.9e-7 |
| „womit säge ich Kurven in Holz", k=10 | `bbq_hnsw` | 1.00, Distanzen identisch | 1.3e-7 |

Die Abweichungen liegen im Bereich der float-Rundung: beide Systeme rechnen
dieselbe Cosine-Distanz. Dass auch `bbq_hnsw` vollen Recall hat, sagt bei 100
Dokumenten wenig: mit `num_candidates` 50 wird die Hälfte des Korpus geprüft
und mit den Originalvektoren nachbewertet. Unterschiede zwischen den
Indextypen werden erst bei deutlich größeren Korpora und kleinem
`num_candidates` sichtbar.

Laufzeiten: Elasticsearch 10–50 ms (`took`, beim ersten Aufruf nach dem Start
bis ~300 ms), pgvector 50–75 ms Roundtrip. Das Query-Embedding über OpenRouter
dauert 0,8–6 s und dominiert wie in `ai_embed`.

## Dateien

| | |
|---|---|
| `sync.ts` | pgvector → Elasticsearch, legt Mapping und Index neu an |
| `compare.ts` | eine Anfrage, alle Verfahren, Recall und Laufzeiten |
| `lib/es.ts` | fetch-Wrapper für Elasticsearch, Feldnamen pro Modell; auch von `ai_embed/server/esSearch.ts` genutzt |

`ES_URL` (Standard `http://127.0.0.1:9200`) und `ES_INDEX` (Standard
`ai_embed_docs`) lassen sich per Umgebungsvariable überschreiben.
