# elasticsearch

Local demo: a Postgres table is synced into Elasticsearch by Logstash and searched through a small web UI.
Includes a generator for 2 million test products and measured search times.

```
 Postgres            Logstash (JDBC input)          Elasticsearch         nginx + index.html
 products table ───► every 30 s: rows with  ──────► index "products" ◄─── search UI
 (sql/*.sql)         updated_at > last value                               http://127.0.0.1:8080
```

| Service         | Image                       | URL / port                      |
|-----------------|-----------------------------|---------------------------------|
| `elasticsearch` | elasticsearch 9.5.5         | http://127.0.0.1:9200           |
| `postgres`      | postgres 18                 | `127.0.0.1:5432`, db/user/password `app` |
| `logstash`      | logstash 9.5.5 + pgjdbc 42.7.14 (built locally) | no port          |
| `search-ui`     | nginx 1.30-alpine           | http://127.0.0.1:8080           |

All ports are bound to `127.0.0.1`. Elasticsearch security is **disabled**; this setup is for local experiments only.
Versions, ports, credentials, heap sizes and the sync schedule are set in `.env`.

## Setup

Requirements: Docker with Compose v2 and about 4 GB of free memory for Docker (Elasticsearch 1 GB heap, Logstash 512 MB heap, plus file cache).

```powershell
# 1. Start Elasticsearch and Postgres
docker compose up -d elasticsearch postgres

# 2. Create the products table with 20 sample products
Get-Content -Raw sql\01_products.sql | docker exec -i postgres psql -U app -d app

# 3. Build and start Logstash (first build downloads the Logstash image)
docker compose up -d --build logstash
docker compose logs -f logstash      # wait for "Pipeline started", then a SELECT every 30 s

# 4. Start the search UI
docker compose up -d search-ui
```

Check the result:

```powershell
Invoke-RestMethod http://127.0.0.1:9200/products/_count          # 20
Invoke-RestMethod 'http://127.0.0.1:9200/products/_search?q=ergonomic' | % { $_.hits.hits._source.name }
```

Then open http://127.0.0.1:8080.

`sql/01_products.sql` drops and recreates the table, so re-running it resets Postgres. The index keeps its documents until you delete them (see [Cleanup](#cleanup)).

## Usage

### Search UI

The page searches `name` (boosted ×2) and `description` while you type, highlights matches and shows score, category, brand, price, stock and tags.
The drop-down selects the query type:

| Mode                       | Elasticsearch query                         | Example                                   |
|----------------------------|---------------------------------------------|-------------------------------------------|
| Match, typo-tolerant       | `multi_match` with `fuzziness: AUTO`        | `ergonomik` finds "Ergonomic …"           |
| Match, exact terms         | `multi_match`                               | `wireless`                                |
| Phrase                     | `multi_match` with `type: phrase`           | `noise cancellation`                      |
| Prefix (search as you type)| `multi_match` with `type: bool_prefix`      | `mech` finds "Mechanical"                 |

While you type, a drop-down proposes up to 8 words from product names that start with the word at the end of the search field.
Arrow keys select a word, Enter or a click puts it into the field and searches, Esc closes the list.
In the typo-tolerant mode the proposals tolerate typos as well (`wirles` proposes "Wireless").
The proposals come from a [completion suggester](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/search-suggesters#completion-suggester) on the field `name_suggest`, which Logstash fills with the words of `name`.

"Query sent to Elasticsearch" shows the request body, ready to copy into your own tests; "Suggest query sent to Elasticsearch" shows the same for the drop-down.
When Elasticsearch stops counting at 10,000, the UI shows "10,000+ hits".

nginx forwards only `POST /api/search` to `products/_search`; every other request to Elasticsearch through the UI is refused.

### Sync behaviour

`logstash/pipeline/products.conf` runs on the `SYNC_SCHEDULE` from `.env` (default every 30 s):

- It selects rows with `updated_at > :sql_last_value` and stores the last value in the `lsdata` volume, so restarts continue where they stopped.
- A trigger in Postgres sets `updated_at` on every `UPDATE`, so changed rows are picked up automatically.
- The Postgres `id` is the document id: an update overwrites the document instead of creating a duplicate.
- Rows are read in pages of 10,000 (`LIMIT :size OFFSET :offset`), so large syncs never sit in Logstash's heap at once.
- `tags` (a Postgres array) is sent as a comma-separated string and split again in Logstash, because the JDBC input cannot convert arrays.
- The words of `name` are copied into `name_suggest` (a `completion` field) for the type-ahead.
- The index mapping comes from `logstash/templates/products.json`, which Logstash installs as an index template.
  The template only applies when the index is created: after changing it, re-sync from scratch (see [Cleanup](#cleanup)).

Try it:

```powershell
docker exec postgres psql -U app -d app -c "UPDATE products SET stock = 3 WHERE sku = 'DSK-001';"
# after the next run (≤ 30 s): _version goes up by 1 and stock is 3
Invoke-RestMethod http://127.0.0.1:9200/products/_doc/20 | % { "$($_._version) stock=$($_._source.stock)" }
```

**Limitation: deletes are not synced.** A row deleted in Postgres stays in the index. Use soft deletes (a `deleted` flag) or remove the document yourself.

## Load test with 2 million products

`sql/02_generate_products.sql` adds 2,000,000 products with SKUs `GEN-0000001` … `GEN-2000000`.
Names and descriptions are combined from word lists plus a random model code (for example "Elite Speaker M3953"), so the index gets a large vocabulary.
Each row gets its own `updated_at`, 1 µs apart, so the paged sync has a stable order.

```powershell
Get-Content -Raw sql\02_generate_products.sql | docker exec -i postgres psql -U app -d app
```

Logstash picks the new rows up on its next run.

### Measurements

Environment: laptop with Intel Core i7-1165G7 (4 cores / 8 threads), 32 GB RAM, Windows 11, Docker Desktop on WSL2 with 8 CPUs and 15.5 GB.
Single Elasticsearch node, 1 shard, 0 replicas, 1 GB heap. Measured on 2026-10-23.

**Loading**

| Step                                   | Result                                       |
|----------------------------------------|----------------------------------------------|
| Generate 2,000,000 rows in Postgres    | 59 s, table incl. indexes 712 MB             |
| Logstash sync into Elasticsearch       | ≈ 7.5 min (~4,400 docs/s on average), no errors |
| Index size                             | 537 MB for 2,000,020 documents               |

The sync started at about 6,000 docs/s and slowed down as the page offset grew, because Postgres has to skip all earlier rows for every `OFFSET` page.

**Searching** (`took` reported by Elasticsearch, median of 5 runs, request cache disabled, `size: 20` with highlighting, exactly as the UI sends it)

| Mode          | Search                                  | Hits     | Median | Max    |
|---------------|-----------------------------------------|----------|--------|--------|
| Exact terms   | `wireless`                              | 10,000+  | 12 ms  | 17 ms  |
| Exact terms   | `silent keyboard`                       | 10,000+  | 13 ms  | 15 ms  |
| Phrase        | `noise cancellation`                    | 10,000+  | 19 ms  | 33 ms  |
| Prefix        | `silent ke`                             | 10,000+  | 19 ms  | 22 ms  |
| Prefix        | `mech`                                  | 1        | 4 ms   | 6 ms   |
| Typo-tolerant | `M3935` (typo of model code `M3953`)    | 411      | 38 ms  | 70 ms  |
| Typo-tolerant | `ergonomik`                             | 10,000+  | 118 ms | 154 ms |
| Typo-tolerant | `wireles headphnes`                     | 10,000+  | 374 ms | 841 ms |

Findings:

- Exact, phrase and prefix searches stay in the low tens of milliseconds on 2 million documents.
  Search cost depends mostly on the matching documents, not on the total number of documents.
- Typo-tolerant search is the only slow mode, and only for misspellings of common words that match many documents.
  A rare term (the model code) stays fast.
- `prefix_length` (first letters must match exactly) did **not** help:

  | Search              | `prefix_length` 0 | 1      | 2      |
  |---------------------|-------------------|--------|--------|
  | `ergonomik`         | 105 ms            | 99 ms  | 69 ms  |
  | `wireles headphnes` | 362 ms            | 566 ms | 398 ms |

  So the time does not seem to go into expanding similar terms. Scoring the many matching documents is the likely cause, but this is not yet confirmed (the Profile API, `"profile": true`, would show it).
- Ideas to try: search exactly first and only fall back to fuzzy search when there are few hits, or allow typos only on `name`.

## Cleanup

Remove the generated products (deletes are not synced, so clean up both sides):

```powershell
docker exec postgres psql -U app -d app -c "DELETE FROM products WHERE sku LIKE 'GEN-%';"
Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Body '{"query":{"prefix":{"sku":"GEN-"}}}' 'http://127.0.0.1:9200/products/_delete_by_query'
```

Stop everything:

```powershell
docker compose down        # keeps data in the volumes esdata, pgdata, lsdata
docker compose down -v     # also deletes all data and the Logstash sync position
```

To re-sync everything from scratch without deleting Postgres data, stop Logstash first (it may write its position on shutdown), then delete the index and the sync position:

```powershell
docker compose stop logstash
Invoke-RestMethod -Method Delete http://127.0.0.1:9200/products
docker compose run --rm --no-deps --entrypoint rm logstash /usr/share/logstash/data/products_last_run
docker compose start logstash
```

## Files

| Path                               | Purpose                                                  |
|------------------------------------|----------------------------------------------------------|
| `compose.yaml`, `.env`             | Services and their settings                              |
| `sql/01_products.sql`              | `products` table, `updated_at` trigger, 20 sample rows   |
| `sql/02_generate_products.sql`     | 2 million generated products for load tests              |
| `logstash/Dockerfile`              | Logstash image with the PostgreSQL JDBC driver           |
| `logstash/pipeline/products.conf`  | Sync pipeline Postgres → Elasticsearch                   |
| `logstash/templates/products.json` | Index template (field types of the `products` index)     |
| `search-ui/index.html`             | Search page, no external dependencies                    |
| `search-ui/nginx.conf`             | Serves the page, read-only proxy to `products/_search`   |
| `vector/`                          | Vector search experiment: pgvector vs. Elasticsearch kNN on the `ai_embed` corpus, see [vector/README.md](vector/README.md) |

## Troubleshooting

- **Logstash: `unable to load … postgresql.jar … file not readable`**: the image was built from an old Dockerfile. Rebuild with `docker compose up -d --build logstash`.
- **Index stays empty**: check `docker compose logs logstash` for SQL errors. To force a full re-sync, see [Cleanup](#cleanup).
- **Kibana** is not part of this setup. Add it to `compose.yaml` if you want Dev Tools or Discover.
