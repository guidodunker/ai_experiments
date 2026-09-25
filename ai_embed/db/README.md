# pgvector-Testbett

Postgres 18.6 + pgvector 0.8.6 als Spielwiese zum Vergleich von Embedding-Modellen.

## Starten

```bash
cp .env.example .env      # einmalig
docker compose up -d
```

Verbindung: `postgresql://embed:embed@localhost:5436/embed`

```bash
docker compose exec db psql -U embed -d embed
```

Port 5436, weil 5432 und 5438 auf diesem Rechner bereits von anderen
Postgres-Containern belegt sind. Änderbar über `POSTGRES_PORT` in `.env`.

## Schema

| Objekt | Zweck |
|---|---|
| `documents` | Der Testkorpus, ein Chunk pro Zeile |
| `embeddings` | Vektoren, **ein Eintrag pro (Dokument, Modell)** |
| `model_stats` | View: welche Modelle liegen mit wie vielen Vektoren drin |
| `search(vec, model, k)` | Exaktes Top-k für ein Modell |
| `compare_models(jsonb, k)` | Dasselbe Ranking für mehrere Modelle nebeneinander |
| `materialize_model(model)` | Typisierte Kopie + HNSW-Index für Index-Benchmarks |

`embeddings.embedding` ist bewusst als `vector` **ohne feste Dimension**
deklariert. Dadurch liegen 384-, 768-, 1024-, 1536- und 3072-dimensionale
Modelle in derselben Tabelle. Der Preis: pgvector kann darauf keinen
HNSW-/IVFFlat-Index anlegen, Suchen laufen als exakter Seq-Scan.

Für den Modellvergleich ist das die richtige Wahl — du misst Modellqualität
und bekommst echtes Top-k statt approximierter Treffer. Bis in den Bereich
einiger zehntausend Vektoren ist das schnell genug.

Ein `CHECK`-Constraint erzwingt `vector_dims(embedding) = dim`, damit kein
falsch dimensionierter Vektor unbemerkt unter einer Modellkennung landet.

## Testkorpus einspielen

100 Baumarkt-Produkte (Elektrowerkzeuge, Garten, Sanitär, Baustoffe, …):

```powershell
docker cp db/seed/01_baumarkt_products.sql ai_embed_pgvector:/tmp/seed.sql
docker exec ai_embed_pgvector psql -U embed -d embed -v ON_ERROR_STOP=1 -f /tmp/seed.sql
```

Nicht über eine PowerShell-Pipe einspielen — dabei gehen die Umlaute kaputt.
Das Skript ist wiederholbar (`ON CONFLICT` auf `external_id`).

Die Produktfelder (`name`, `category`, `subCategory`, `useCases`, `brand`,
`priceSegment`, `features`) liegen strukturiert in `documents.meta`. Der Text,
der eingebettet wird, entsteht daraus über `render_product(meta)`:

> Bosch Stichsäge PST 900 PEL. Kategorie: Elektrowerkzeuge, Sägen. Marke: Bosch.
> Einsatzgebiete: Holz schneiden, Kurvenschnitte, Heimwerken. Merkmale: Pendelhub,
> CutControl, 620 W, werkzeugloser Sägeblattwechsel. Preissegment: mittel.

Die Textvorlage ist beim Modellvergleich selbst eine Variable. Andere Vorlage
testen heißt: `render_product` ändern und neu rendern —

```sql
UPDATE documents SET content = render_product(meta) WHERE meta ? 'name';
```

— danach müssen die Embeddings natürlich neu erzeugt werden.

## Daten einfügen

```sql
INSERT INTO documents (external_id, content) VALUES ('doc-1', 'Text …');

INSERT INTO embeddings (doc_id, model, dim, embedding)
VALUES (1, 'nomic-embed-text', 768, '[0.013, -0.22, …]'::vector);
```

Beim Nachladen desselben Modells:

```sql
INSERT INTO embeddings (doc_id, model, dim, embedding) VALUES (…)
ON CONFLICT (doc_id, model) DO UPDATE SET embedding = EXCLUDED.embedding;
```

## Suchen

```sql
-- ein Modell
SELECT * FROM search('[…]'::vector, 'nomic-embed-text', 5);

-- mehrere Modelle nebeneinander; jedes braucht seinen eigenen Query-Vektor,
-- weil jedes Modell die Anfrage selbst einbetten muss
SELECT * FROM compare_models(
  '{"nomic-embed-text": [...], "bge-m3": [...]}'::jsonb, 5);
```

Distanzoperatoren: `<=>` Cosine, `<->` L2, `<#>` negatives Inneres Produkt.
Die Funktionen oben nutzen Cosine.

## Index-Benchmark

```sql
SELECT materialize_model('nomic-embed-text');
-- -> emb_nomic_embed_text mit vector(768) + HNSW-Index

EXPLAIN ANALYZE
SELECT doc_id FROM emb_nomic_embed_text
ORDER BY embedding <=> '[…]'::vector LIMIT 10;
```

Ab Dimension > 2000 (z.B. `text-embedding-3-large` mit 3072) legt
`materialize_model` den Index automatisch auf `halfvec`, weil pgvector
`vector`-Indizes nur bis 2000 Dimensionen unterstützt.

## Zurücksetzen

```bash
docker compose down -v     # löscht auch das Volume -> init-Skripte laufen neu
```

Ohne `-v` bleiben die Daten erhalten; die Skripte in `db/init/` laufen dann
**nicht** erneut — Schemaänderungen müssen manuell nachgezogen werden.
