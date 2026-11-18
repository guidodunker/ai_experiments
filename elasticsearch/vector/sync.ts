/**
 * Kopiert Korpus und Vektoren aus der pgvector-Datenbank von ai_embed nach
 * Elasticsearch. Es wird nichts neu eingebettet: dieselben Vektoren in beiden
 * Systemen sind die Voraussetzung dafür, dass compare.ts die Suchverfahren
 * vergleicht und nicht zwei verschiedene Embedding-Läufe.
 *
 * Der Index wird bei jedem Lauf neu angelegt. Bei 100 Produkten kostet das
 * Sekunden, und --index-type lässt sich so ohne Altlasten wechseln.
 *
 *   node --experimental-strip-types --env-file=../../ai_embed/.env sync.ts
 *   ... sync.ts --model=qwen3-8b,bge-m3 --index-type=bbq_hnsw
 */

import { getPool, closePool, assertSchema, describeTarget } from "../../ai_embed/scripts/lib/db.ts";
import { parseArgs, str, num, selectModels, fail } from "../../ai_embed/scripts/lib/cli.ts";
import { resolveModel } from "../../ai_embed/scripts/lib/models.ts";
import type { ModelSpec } from "../../ai_embed/scripts/lib/models.ts";
import { es, esUrl, esIndex, MAX_DIMS, fieldFor, indexExists, describeError } from "./lib/es.ts";

/**
 * hnsw speichert die Vektoren unquantisiert als float — das Gegenstück zu
 * pgvector und deshalb Standard hier. Elasticsearch selbst nimmt ohne Angabe
 * ein quantisiertes Verfahren (bbq_hnsw ab 384 Dimensionen), was Speicher
 * spart und Recall kosten kann. Genau das soll man messen können.
 */
const INDEX_TYPES = [
  "hnsw",
  "int8_hnsw",
  "int4_hnsw",
  "bbq_hnsw",
  "flat",
  "int8_flat",
  "int4_flat",
  "bbq_flat",
] as const;

type ModelRow = { model: string; dim: number; vectors: string };
type DocRow = {
  id: string;
  external_id: string | null;
  content: string;
  meta: Record<string, string | undefined>;
  model: string | null;
  vec: string | null;
};

async function modelsInDb(): Promise<Map<string, { dim: number; vectors: number }>> {
  const { rows } = await getPool().query<ModelRow>(
    "SELECT model, dim, count(*)::text AS vectors FROM embeddings GROUP BY model, dim ORDER BY model",
  );
  const result = new Map<string, { dim: number; vectors: number }>();
  for (const row of rows) {
    if (result.has(row.model)) {
      throw new Error(`${row.model} hat in pgvector uneinheitliche Dimensionen — erst bereinigen.`);
    }
    result.set(row.model, { dim: row.dim, vectors: Number(row.vectors) });
  }
  return result;
}

function pickModels(
  flags: ReturnType<typeof parseArgs>,
  inDb: Map<string, { dim: number }>,
): ModelSpec[] {
  // Ohne --model alles, was in pgvector liegt; die Registry kennt mehr Modelle
  // als je eingebettet wurden.
  if (!flags.values.has("model") && !flags.values.has("all")) {
    const known: ModelSpec[] = [];
    for (const id of inDb.keys()) {
      try {
        known.push(resolveModel(id));
      } catch {
        console.warn(`  übersprungen: ${id} steht nicht in ai_embed/scripts/lib/models.ts`);
      }
    }
    return known;
  }
  return selectModels(flags).filter((m) => {
    if (inDb.has(m.id)) return true;
    console.warn(`  übersprungen: ${m.alias} hat keine Vektoren in pgvector`);
    return false;
  });
}

function buildMapping(models: ModelSpec[], inDb: Map<string, { dim: number }>, indexType: string) {
  const properties: Record<string, unknown> = {
    external_id: { type: "keyword" },
    // german: Stemming und Stoppwörter für den BM25-Teil der hybriden Suche
    content: { type: "text", analyzer: "german" },
    name: { type: "text", analyzer: "german" },
    category: { type: "keyword" },
    sub_category: { type: "keyword" },
    brand: { type: "keyword" },
    price_segment: { type: "keyword" },
  };
  for (const model of models) {
    properties[fieldFor(model)] = {
      type: "dense_vector",
      dims: inDb.get(model.id)!.dim,
      similarity: "cosine",
      index: true,
      index_options: { type: indexType },
    };
  }
  return {
    // Einzelknoten: ohne Replikas bleibt der Index grün statt gelb.
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: { dynamic: "strict", properties },
  };
}

async function loadDocs(models: ModelSpec[]): Promise<Map<string, Record<string, unknown>>> {
  const { rows } = await getPool().query<DocRow>(
    `SELECT d.id::text, d.external_id, d.content, d.meta,
            e.model, e.embedding::text AS vec
       FROM documents d
       LEFT JOIN embeddings e ON e.doc_id = d.id AND e.model = ANY($1)
      ORDER BY d.id`,
    [models.map((m) => m.id)],
  );

  const fieldById = new Map(models.map((m) => [m.id, fieldFor(m)]));
  const docs = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    let doc = docs.get(row.id);
    if (!doc) {
      doc = {
        external_id: row.external_id,
        content: row.content,
        name: row.meta.name,
        category: row.meta.category,
        sub_category: row.meta.subCategory,
        brand: row.meta.brand,
        price_segment: row.meta.priceSegment,
      };
      docs.set(row.id, doc);
    }
    // pgvector liefert "[0.1,0.2,…]" — das ist bereits gültiges JSON.
    if (row.model && row.vec) doc[fieldById.get(row.model)!] = JSON.parse(row.vec) as number[];
  }
  return docs;
}

type BulkResponse = {
  errors: boolean;
  items: { index: { _id: string; error?: { reason?: string } } }[];
};

async function bulkIndex(docs: Map<string, Record<string, unknown>>, batchSize: number): Promise<void> {
  const entries = [...docs.entries()];
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const chunk = entries.slice(offset, offset + batchSize);
    // _id = documents.id, damit Treffer aus beiden Systemen direkt vergleichbar sind.
    const body =
      chunk
        .flatMap(([id, doc]) => [JSON.stringify({ index: { _id: id } }), JSON.stringify(doc)])
        .join("\n") + "\n";
    const result = await es<BulkResponse>("POST", `/${esIndex()}/_bulk`, body);
    if (result.errors) {
      const first = result.items.find((i) => i.index.error);
      throw new Error(`Bulk-Fehler bei _id ${first?.index._id}: ${first?.index.error?.reason}`);
    }
    process.stdout.write(`\r  indexiert: ${Math.min(offset + batchSize, entries.length)}/${entries.length}`);
  }
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const indexType = str(flags, "index-type", "hnsw");
  const batchSize = num(flags, "batch", 20);
  if (!(INDEX_TYPES as readonly string[]).includes(indexType)) {
    fail(`--index-type="${indexType}" unbekannt. Erlaubt: ${INDEX_TYPES.join(", ")}`);
  }

  await assertSchema();
  const inDb = await modelsInDb();
  if (inDb.size === 0) {
    fail("In pgvector liegen noch keine Vektoren.\n  Erst in ai_embed: npm run embed:index");
  }

  let models: ModelSpec[];
  try {
    models = pickModels(flags, inDb);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (models.length === 0) fail("Keine Modelle zu übertragen.");

  const tooLarge = models.filter((m) => inDb.get(m.id)!.dim > MAX_DIMS);
  if (tooLarge.length > 0) {
    fail(`dense_vector erlaubt höchstens ${MAX_DIMS} Dimensionen: ${tooLarge.map((m) => m.alias).join(", ")}`);
  }

  console.log(`Quelle:  ${describeTarget()}`);
  console.log(`Ziel:    ${esUrl()}/${esIndex()}  ·  index_options.type = ${indexType}`);
  for (const m of models) {
    const info = inDb.get(m.id)!;
    console.log(`  ${m.alias.padEnd(12)} dim ${String(info.dim).padStart(4)}  ${String(info.vectors).padStart(4)} Vektoren  -> ${fieldFor(m)}`);
  }

  if (await indexExists()) await es("DELETE", `/${esIndex()}`);
  await es("PUT", `/${esIndex()}`, buildMapping(models, inDb, indexType));

  const started = Date.now();
  const docs = await loadDocs(models);
  await bulkIndex(docs, batchSize);
  await es("POST", `/${esIndex()}/_refresh`);

  const { count } = await es<{ count: number }>("GET", `/${esIndex()}/_count`);
  console.log(`\n  ${count} Dokumente in ${esIndex()}  ·  ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`  Weiter: node --experimental-strip-types --env-file=../../ai_embed/.env compare.ts "Hecke schneiden"`);
}

try {
  await main();
} catch (error) {
  console.error(`\n${describeError(error)}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
