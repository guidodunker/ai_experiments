/**
 * Elasticsearch als zweite Suchmaschine hinter der Suchseite.
 *
 * Der Index entsteht mit elasticsearch/vector/sync.ts aus genau den Vektoren,
 * die auch in pgvector liegen. Elasticsearch liefert hier nur das Ranking
 * (Dokument-ID + Score); die Anzeigedaten (useCases, features …) kommen
 * weiter aus documents.meta. So bleibt der Index schlank, und beide
 * Suchmaschinen zeigen die Treffer mit denselben Daten an.
 */

import { getPool } from "../scripts/lib/db.ts";
import type { ModelSpec } from "../scripts/lib/models.ts";
import {
  es,
  esIndex,
  esUrl,
  fieldFor,
  indexExists,
  vectorFields,
} from "../../elasticsearch/vector/lib/es.ts";

export type ProductMeta = {
  name: string;
  category: string;
  subCategory: string;
  brand: string;
  priceSegment: string;
  useCases: string[];
  features: string[];
};

/**
 * distance: Cosine-Distanz wie bei pgvector. Bei der hybriden Suche gibt es
 * keine Distanz, nur den summierten Score (score), deshalb null.
 */
export type RankedHit = { docId: string; distance: number | null; score?: number };

export type EsStatus =
  | { available: false; reason: string }
  | {
      available: true;
      url: string;
      index: string;
      documents: number;
      field: string;
      dims: number | null;
      indexType: string | null;
    };

type SearchResponse = {
  took: number;
  hits: { hits: { _id: string; _score: number }[] };
};

/**
 * num_candidates: wie viele Kandidaten der HNSW-Graph prüft. Bei 100 Produkten
 * ist das praktisch exakt; bei großen Korpora die Stellschraube für Recall.
 */
function numCandidates(k: number): number {
  return Math.max(50, k * 5);
}

export async function esStatus(model: ModelSpec): Promise<EsStatus> {
  try {
    if (!(await indexExists())) {
      return {
        available: false,
        reason:
          `Index ${esIndex()} fehlt unter ${esUrl()}.\n` +
          `Erst in elasticsearch/vector: node --experimental-strip-types --env-file=../../ai_embed/.env sync.ts`,
      };
    }
    const [fields, count] = await Promise.all([
      vectorFields(),
      es<{ count: number }>("GET", `/${esIndex()}/_count`),
    ]);
    const field = fields.find((f) => f.field === fieldFor(model));
    return {
      available: true,
      url: esUrl(),
      index: esIndex(),
      documents: count.count,
      field: fieldFor(model),
      dims: field?.dims ?? null,
      indexType: field?.indexType ?? null,
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * kNN-Suche. Bei similarity=cosine ist der Score (1 + cos) / 2; umgerechnet
 * auf die Cosine-Distanz von pgvector (1 − cos) sind die Zahlen auf der
 * Suchseite direkt vergleichbar.
 */
export async function esKnn(
  model: ModelSpec,
  vector: number[],
  k: number,
  excludeDocIds: string[] = [],
): Promise<{ hits: RankedHit[]; took: number; searchMs: number }> {
  const t0 = Date.now();
  const response = await es<SearchResponse>("POST", `/${esIndex()}/_search`, {
    size: k,
    _source: false,
    knn: {
      field: fieldFor(model),
      query_vector: vector,
      k,
      num_candidates: numCandidates(k),
      ...(excludeDocIds.length > 0
        ? { filter: { bool: { must_not: { ids: { values: excludeDocIds } } } } }
        : {}),
    },
  });
  return {
    hits: response.hits.hits.map((h) => ({ docId: h._id, distance: 2 - 2 * h._score })),
    took: response.took,
    searchMs: Date.now() - t0,
  };
}

/**
 * Hybride Suche: BM25 auf dem Produkttext und kNN im selben Request,
 * Elasticsearch addiert beide Scores. Der rrf-Retriever (Rangfusion) wäre
 * robuster, ist in der Basic-Lizenz aber gesperrt (HTTP 403, gemessen mit 9.5.5).
 *
 * Die Summe ist schief: der kNN-Score liegt in [0, 1], BM25 ist unbeschränkt
 * und bei Wortübereinstimmung schnell bei 5–15. textBoost skaliert den
 * BM25-Anteil; 0 ergibt reines kNN.
 */
export async function esHybrid(
  model: ModelSpec,
  vector: number[],
  query: string,
  k: number,
  textBoost: number,
): Promise<{ hits: RankedHit[]; took: number; searchMs: number }> {
  const t0 = Date.now();
  const response = await es<SearchResponse>("POST", `/${esIndex()}/_search`, {
    size: k,
    _source: false,
    query: { match: { content: { query, boost: textBoost } } },
    knn: {
      field: fieldFor(model),
      query_vector: vector,
      k,
      num_candidates: numCandidates(k),
    },
  });
  return {
    hits: response.hits.hits.map((h) => ({ docId: h._id, distance: null, score: h._score })),
    took: response.took,
    searchMs: Date.now() - t0,
  };
}

type MgetResponse = {
  docs: { _id: string; found: boolean; _source?: Record<string, number[] | undefined> }[];
};

/**
 * Zentroid für die Empfehlungssuche. pgvector rechnet avg(embedding) in SQL;
 * Elasticsearch kann über Vektoren nicht aggregieren, deshalb werden die
 * Vektoren geholt und hier gemittelt. Für Cosine ist die Länge des Mittelwerts
 * egal, nur die Richtung zählt.
 */
export async function esCentroid(
  model: ModelSpec,
  docIds: string[],
): Promise<{ vector: number[] | null; found: string[]; missing: string[] }> {
  const field = fieldFor(model);
  const response = await es<MgetResponse>(
    "POST",
    `/${esIndex()}/_mget?_source_includes=${encodeURIComponent(field)}`,
    { ids: docIds },
  );

  const vectors: number[][] = [];
  const found: string[] = [];
  const missing: string[] = [];
  for (const doc of response.docs) {
    const vector = doc._source?.[field];
    if (doc.found && Array.isArray(vector) && vector.length > 0) {
      vectors.push(vector);
      found.push(doc._id);
    } else {
      missing.push(doc._id);
    }
  }
  if (vectors.length === 0) return { vector: null, found, missing };

  const sum = new Array<number>(vectors[0]!.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < vector.length; i++) sum[i]! += vector[i]!;
  }
  return { vector: sum.map((v) => v / vectors.length), found, missing };
}

/** Anzeigedaten aus Postgres, in der Reihenfolge des Elasticsearch-Rankings. */
export async function withMeta(
  hits: RankedHit[],
): Promise<(RankedHit & { externalId: string } & ProductMeta)[]> {
  if (hits.length === 0) return [];
  const { rows } = await getPool().query<{ doc_id: string; external_id: string; meta: ProductMeta }>(
    `SELECT id::text AS doc_id, external_id, meta
       FROM documents
      WHERE id = ANY($1::bigint[])`,
    [hits.map((h) => h.docId)],
  );
  const byId = new Map(rows.map((r) => [r.doc_id, r]));
  return hits.flatMap((hit) => {
    const row = byId.get(hit.docId);
    // Im Index, aber nicht mehr in Postgres: Index ist veraltet, sync.ts neu laufen lassen.
    return row ? [{ ...hit, externalId: row.external_id, ...row.meta }] : [];
  });
}
