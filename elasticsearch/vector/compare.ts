/**
 * Eine Anfrage, ein Query-Vektor, drei (optional vier) Suchverfahren:
 *
 *   pgvector exakt   ORDER BY embedding <=> q — die Referenz aus ai_embed
 *   ES exakt         script_score mit cosineSimilarity, Brute-Force über alle Dokumente
 *   ES kNN           HNSW-Graph, approximiert, mit num_candidates als Stellschraube
 *   ES hybrid        --hybrid: BM25 auf dem Text + kNN, Scores addiert
 *
 * Der Query-Vektor wird pro Modell genau einmal geholt und an alle Verfahren
 * gegeben. Unterschiede in den Trefferlisten liegen damit am Suchverfahren,
 * nicht am Embedding.
 *
 *   node --experimental-strip-types --env-file=../../ai_embed/.env compare.ts "Hecke schneiden"
 *   ... compare.ts "Wand streichen" --k=10 --num-candidates=20 --category=Farben --hybrid
 */

import { getPool, closePool, assertSchema, toVectorLiteral } from "../../ai_embed/scripts/lib/db.ts";
import { embedOne } from "../../ai_embed/scripts/lib/embed.ts";
import { parseArgs, flag, num, selectModels, fail } from "../../ai_embed/scripts/lib/cli.ts";
import { allModels } from "../../ai_embed/scripts/lib/models.ts";
import type { ModelSpec } from "../../ai_embed/scripts/lib/models.ts";
import { es, esUrl, esIndex, fieldFor, indexExists, describeError, vectorFields } from "./lib/es.ts";
import type { VectorField } from "./lib/es.ts";

type Hit = { id: string; name: string; distance: number | null };
type Method = { label: string; hits: Hit[]; ms: number; note?: string };

type Options = {
  k: number;
  numCandidates: number;
  category: string | null;
  hybrid: boolean;
  textBoost: number;
};

type SearchResponse = {
  took: number;
  hits: { hits: { _id: string; _score: number; _source: { name?: string } }[] };
};

async function pgExact(model: ModelSpec, vector: number[], o: Options): Promise<Method> {
  const t0 = Date.now();
  const { rows } = await getPool().query<{ id: string; name: string; distance: number }>(
    `SELECT d.id::text, d.meta ->> 'name' AS name,
            (e.embedding <=> $1::vector)::float8 AS distance
       FROM embeddings e
       JOIN documents d ON d.id = e.doc_id
      WHERE e.model = $2
        AND ($4::text IS NULL OR d.meta ->> 'category' = $4)
      ORDER BY e.embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(vector), model.id, o.k, o.category],
  );
  return { label: "pgvector exakt", hits: rows, ms: Date.now() - t0 };
}

function categoryFilter(o: Options) {
  return o.category === null ? undefined : { term: { category: o.category } };
}

function toHits(response: SearchResponse, toDistance: ((score: number) => number) | null): Hit[] {
  return response.hits.hits.map((h) => ({
    id: h._id,
    name: h._source.name ?? "?",
    distance: toDistance ? toDistance(h._score) : null,
  }));
}

async function esExact(field: string, vector: number[], o: Options): Promise<Method> {
  const filter = categoryFilter(o);
  const response = await es<SearchResponse>("POST", `/${esIndex()}/_search`, {
    size: o.k,
    _source: ["name"],
    query: {
      script_score: {
        query: filter ?? { match_all: {} },
        // +1, weil script_score keine negativen Scores erlaubt
        script: {
          source: `cosineSimilarity(params.q, '${field}') + 1.0`,
          params: { q: vector },
        },
      },
    },
  });
  // score = cos + 1  →  Cosine-Distanz wie pgvector: 1 − cos = 2 − score
  return { label: "ES exakt", hits: toHits(response, (s) => 2 - s), ms: response.took };
}

async function esKnn(field: string, vector: number[], o: Options, indexType: string): Promise<Method> {
  const filter = categoryFilter(o);
  const response = await es<SearchResponse>("POST", `/${esIndex()}/_search`, {
    size: o.k,
    _source: ["name"],
    knn: {
      field,
      query_vector: vector,
      k: o.k,
      num_candidates: o.numCandidates,
      // Filter läuft während der Graphsuche, nicht danach: es kommen trotzdem k Treffer.
      ...(filter ? { filter } : {}),
    },
  });
  // Bei similarity=cosine ist score = (1 + cos) / 2  →  1 − cos = 2 − 2·score
  return {
    label: `ES kNN (${indexType})`,
    hits: toHits(response, (s) => 2 - 2 * s),
    ms: response.took,
    note: `num_candidates ${o.numCandidates}`,
  };
}

/**
 * query + knn im selben Request: Elasticsearch addiert BM25-Score und
 * kNN-Score, jeweils mit boost gewichtet. Der rrf-Retriever wäre die robustere
 * Variante, ist in der Basic-Lizenz aber gesperrt (HTTP 403, gemessen mit 9.5.5).
 *
 * Die Summe ist schief: kNN-Scores liegen in [0, 1], BM25-Scores sind
 * unbeschränkt. Mit --text-boost verschiebt man das Gewicht.
 */
async function esHybrid(field: string, vector: number[], query: string, o: Options): Promise<Method> {
  const filter = categoryFilter(o);
  const match = { match: { content: { query, boost: o.textBoost } } };
  const response = await es<SearchResponse>("POST", `/${esIndex()}/_search`, {
    size: o.k,
    _source: ["name"],
    query: filter ? { bool: { must: match, filter } } : match,
    knn: {
      field,
      query_vector: vector,
      k: o.k,
      num_candidates: o.numCandidates,
      ...(filter ? { filter } : {}),
    },
  });
  // Score-Summe, keine Distanz.
  return {
    label: "ES hybrid (BM25 + kNN, Score-Summe)",
    hits: toHits(response, null),
    ms: response.took,
    note: `text-boost ${o.textBoost}`,
  };
}

/** Anteil der exakten Top-k, die ein Verfahren ebenfalls findet. */
function recall(reference: Hit[], hits: Hit[]): number {
  if (reference.length === 0) return 1;
  const ids = new Set(hits.map((h) => h.id));
  return reference.filter((h) => ids.has(h.id)).length / reference.length;
}

function printMethod(method: Method, reference: Method): void {
  const isReference = method === reference;
  const header =
    `  ${method.label}  ·  ${method.ms} ms` +
    (method.note ? `  ·  ${method.note}` : "") +
    (isReference ? "  ·  Referenz" : `  ·  Recall@${reference.hits.length} ${recall(reference.hits, method.hits).toFixed(2)}`);
  console.log(`\n${header}`);

  if (method.hits.length === 0) {
    console.log("    keine Treffer");
    return;
  }
  const refIds = new Set(reference.hits.map((h) => h.id));
  for (const [i, hit] of method.hits.entries()) {
    const distance = hit.distance === null ? "      -" : hit.distance.toFixed(4).padStart(7);
    // * = steht nicht in der exakten Top-k-Liste von pgvector
    const marker = isReference || refIds.has(hit.id) ? " " : "*";
    console.log(`   ${marker}${String(i + 1).padStart(2)}  ${distance}  ${hit.name}`);
  }
}

/** Größte Abweichung der Distanzen zwischen ES exakt und pgvector, über gleiche Dokumente. */
function maxDistanceDelta(a: Hit[], b: Hit[]): number | null {
  const byId = new Map(b.map((h) => [h.id, h.distance]));
  const deltas = a
    .map((h) => {
      const other = byId.get(h.id);
      return other == null || h.distance === null ? null : Math.abs(h.distance - other);
    })
    .filter((d): d is number => d !== null);
  return deltas.length === 0 ? null : Math.max(...deltas);
}

async function runModel(model: ModelSpec, vf: VectorField, query: string, o: Options): Promise<void> {
  const t0 = Date.now();
  const vector = await embedOne(model, "query", query);
  const embedMs = Date.now() - t0;

  console.log(`\n=== ${model.alias}  ·  dim ${vf.dims}  ·  Query-Embedding ${embedMs} ms ===`);

  const reference = await pgExact(model, vector, o);
  const methods: Method[] = [
    reference,
    await esExact(vf.field, vector, o),
    await esKnn(vf.field, vector, o, vf.indexType),
  ];
  if (o.hybrid) {
    try {
      methods.push(await esHybrid(vf.field, vector, query, o));
    } catch (error) {
      console.warn(`\n  ES hybrid fehlgeschlagen: ${error instanceof Error ? error.message : error}`);
    }
  }

  for (const method of methods) printMethod(method, reference);

  const delta = maxDistanceDelta(methods[1]!.hits, reference.hits);
  if (delta !== null) {
    console.log(`\n  max. Distanzabweichung ES exakt ↔ pgvector: ${delta.toExponential(2)}`);
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const query = flags.positional.join(" ").trim();
  if (!query) {
    fail('Keine Suchanfrage angegeben.\n  ... compare.ts "womit säge ich Kurven in Holz"');
  }
  const options: Options = {
    k: num(flags, "k", 5),
    numCandidates: num(flags, "num-candidates", 50),
    category: flags.values.get("category")?.at(-1) ?? null,
    hybrid: flag(flags, "hybrid"),
    textBoost: num(flags, "text-boost", 0.1),
  };
  if (options.numCandidates < options.k) {
    fail(`--num-candidates (${options.numCandidates}) muss mindestens --k (${options.k}) sein.`);
  }

  await assertSchema();
  if (!(await indexExists())) {
    fail(`Index ${esIndex()} fehlt unter ${esUrl()}.\n  Erst: node --experimental-strip-types --env-file=../../ai_embed/.env sync.ts`);
  }
  const fields = new Map((await vectorFields()).map((f) => [f.field, f]));

  // --all heißt hier: alle Modelle, die in Elasticsearch liegen.
  let models: ModelSpec[];
  try {
    models = flag(flags, "all")
      ? allModels().filter((m) => fields.has(fieldFor(m)))
      : selectModels(flags);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const missing = models.filter((m) => !fields.has(fieldFor(m)));
  if (missing.length > 0) {
    fail(
      `Kein Vektorfeld in ${esIndex()} für: ${missing.map((m) => m.alias).join(", ")}\n` +
        `  Vorhanden: ${[...fields.keys()].join(", ") || "(keine)"}\n` +
        `  sync.ts überträgt alle Modelle, die in pgvector liegen.`,
    );
  }

  console.log(`Anfrage: "${query}"   (Top ${options.k}${options.category ? `, Kategorie ${options.category}` : ""})`);
  console.log("  * = nicht in der exakten Top-k-Liste von pgvector");

  for (const model of models) {
    await runModel(model, fields.get(fieldFor(model))!, query, options);
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n${describeError(error)}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
