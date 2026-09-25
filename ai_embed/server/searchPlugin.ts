/**
 * Die HTTP-Fläche der Suchseite, eingehängt in den Vite-Dev-Server.
 *
 * Warum überhaupt ein Server: der Browser darf weder den OpenRouter-Key sehen
 * noch Postgres erreichen. Beides bleibt hier. Die Seite schickt nur Text und
 * bekommt Treffer zurück.
 *
 * Das ist derselbe Code, den auch scripts/query.ts benutzt — ein Korpus, eine
 * Modellkonfiguration, eine Präfix-Logik. Wenn die Suchseite andere Ergebnisse
 * liefern würde als die Kommandozeile, wäre das ein Fehler, kein Feature.
 *
 * Nur Dev-Server. Für einen Produktivbetrieb müsste das ein eigener Prozess
 * werden — dann wandert diese Datei nach server/ als eigenständiger Service.
 */

import { loadEnv } from "vite";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getPool, describeTarget, toVectorLiteral } from "../scripts/lib/db.ts";
import { embedOne } from "../scripts/lib/embed.ts";
import { defaultModel } from "../scripts/lib/models.ts";
import type { ModelSpec } from "../scripts/lib/models.ts";

type ProductMeta = {
  name: string;
  category: string;
  subCategory: string;
  brand: string;
  priceSegment: string;
  useCases: string[];
  features: string[];
};

type HitRow = {
  doc_id: string;
  external_id: string;
  meta: ProductMeta;
  distance: number;
};

const MAX_QUERY_LENGTH = 500;
const MAX_K = 25;
const MAX_BASIS = 50;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Ein Suchfeld braucht keine Megabytes; harte Grenze gegen Ausrutscher.
      if (data.length > 64_000) reject(new Error("Request zu groß"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Wieviele Vektoren liegen für dieses Modell im Korpus? */
async function corpusState(model: ModelSpec): Promise<{
  vectors: number;
  dim: number | null;
  documents: number;
  otherModels: string[];
}> {
  const pool = getPool();
  const [mine, docs, others] = await Promise.all([
    pool.query<{ n: string; dim: number | null }>(
      "SELECT count(*)::text AS n, min(dim) AS dim FROM embeddings WHERE model = $1",
      [model.id],
    ),
    pool.query<{ n: string }>("SELECT count(*)::text AS n FROM documents"),
    pool.query<{ model: string }>(
      "SELECT DISTINCT model FROM embeddings WHERE model <> $1 ORDER BY model",
      [model.id],
    ),
  ]);

  return {
    vectors: Number(mine.rows[0]?.n ?? 0),
    dim: mine.rows[0]?.dim ?? null,
    documents: Number(docs.rows[0]?.n ?? 0),
    otherModels: others.rows.map((r) => r.model),
  };
}

async function handleStatus(res: ServerResponse): Promise<void> {
  const model = defaultModel();
  const state = await corpusState(model);
  sendJson(res, 200, {
    model: model.alias,
    modelId: model.id,
    languages: model.languages,
    note: model.note ?? null,
    database: describeTarget(),
    ...state,
    ready: state.vectors > 0,
  });
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let parsed: { query?: unknown; k?: unknown };
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Ungültiges JSON im Request-Body." });
  }

  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
  if (!query) {
    return sendJson(res, 400, { error: "Keine Suchanfrage übergeben." });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return sendJson(res, 400, {
      error: `Suchanfrage zu lang (${query.length} Zeichen, erlaubt sind ${MAX_QUERY_LENGTH}).`,
    });
  }

  const requestedK = Number(parsed.k);
  const k = Number.isFinite(requestedK)
    ? Math.min(Math.max(Math.trunc(requestedK), 1), MAX_K)
    : 10;

  const model = defaultModel();
  const state = await corpusState(model);
  if (state.vectors === 0) {
    return sendJson(res, 409, {
      error:
        `Für ${model.alias} liegen keine Vektoren im Korpus.\n` +
        `Erst indexieren: node --experimental-strip-types --env-file=.env scripts/index-corpus.ts`,
      indexed: state.otherModels,
    });
  }

  // Query-Zeit: erst einbetten, dann suchen. Beide Dauern getrennt messen —
  // die Aufteilung ist der interessante Teil.
  const t0 = Date.now();
  const vector = await embedOne(model, "query", query);
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  const { rows } = await getPool().query<HitRow>(
    `SELECT d.id::text AS doc_id,
            d.external_id,
            d.meta,
            (e.embedding <=> $1::vector)::float8 AS distance
       FROM embeddings e
       JOIN documents d ON d.id = e.doc_id
      WHERE e.model = $2
      ORDER BY e.embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(vector), model.id, k],
  );
  const searchMs = Date.now() - t1;

  sendJson(res, 200, {
    query,
    model: model.alias,
    modelId: model.id,
    dim: vector.length,
    embedMs,
    searchMs,
    hits: rows.map((row) => ({
      docId: row.doc_id,
      externalId: row.external_id,
      distance: row.distance,
      ...row.meta,
    })),
  });
}

/** Alle Produkte als Auswahlliste für die Empfehlungssuche. */
async function handleProducts(res: ServerResponse): Promise<void> {
  const { rows } = await getPool().query<{
    doc_id: string;
    external_id: string;
    meta: ProductMeta;
  }>(
    `SELECT id::text AS doc_id, external_id, meta
       FROM documents
      ORDER BY meta ->> 'category', meta ->> 'name'`,
  );
  sendJson(res, 200, {
    products: rows.map((r) => ({
      docId: r.doc_id,
      externalId: r.external_id,
      name: r.meta.name,
      category: r.meta.category,
      subCategory: r.meta.subCategory,
    })),
  });
}

/**
 * Empfehlungssuche: der Suchvektor ist der Mittelwert der Vektoren mehrerer
 * Produkte (Zentroid), nicht das Embedding eines Textes.
 *
 * Deshalb wird hier KEINE Embedding-API aufgerufen — die Vektoren liegen
 * bereits im Korpus. Die Suche kostet nur den Datenbankdurchlauf.
 *
 * Dass der Mittelwert hier die saubere Mittelrichtung ist, hängt daran, dass
 * die Vektoren auf Länge 1 normiert sind (geprüft: min = max = 1.0 für
 * qwen3-embedding-8b). Bei unnormierten Vektoren würden längere Vektoren die
 * Richtung dominieren; dann müsste vor dem Mitteln l2_normalize() stehen.
 */
async function handleRecommend(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let parsed: { docIds?: unknown; k?: unknown; includeBasis?: unknown };
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Ungültiges JSON im Request-Body." });
  }

  const wanted = Array.isArray(parsed.docIds) ? parsed.docIds : [];
  const docIds = [
    ...new Set(
      wanted
        .map((value) => Number(value))
        .filter((n) => Number.isInteger(n) && n > 0)
        .map((n) => String(n)),
    ),
  ];

  if (docIds.length === 0) {
    return sendJson(res, 400, {
      error: "Keine gültigen doc_ids übergeben. Erwartet werden positive ganze Zahlen.",
    });
  }
  if (docIds.length > MAX_BASIS) {
    return sendJson(res, 400, {
      error: `Zu viele Ausgangsprodukte (${docIds.length}, erlaubt sind ${MAX_BASIS}).`,
    });
  }

  const requestedK = Number(parsed.k);
  const k = Number.isFinite(requestedK)
    ? Math.min(Math.max(Math.trunc(requestedK), 1), MAX_K)
    : 10;
  const includeBasis = parsed.includeBasis === true;

  const model = defaultModel();
  const pool = getPool();

  // Welche der angefragten Produkte haben überhaupt einen Vektor für dieses
  // Modell? Ein stillschweigend ignoriertes Produkt würde das Ergebnis
  // verfälschen, ohne dass es jemand merkt.
  const { rows: basisRows } = await pool.query<{
    doc_id: string;
    meta: ProductMeta;
  }>(
    `SELECT d.id::text AS doc_id, d.meta
       FROM documents d
       JOIN embeddings e ON e.doc_id = d.id AND e.model = $2
      WHERE d.id = ANY($1::bigint[])
      ORDER BY d.id`,
    [docIds, model.id],
  );

  const gefunden = new Set(basisRows.map((r) => r.doc_id));
  const fehlend = docIds.filter((id) => !gefunden.has(id));

  if (basisRows.length === 0) {
    return sendJson(res, 404, {
      error:
        `Für keine der angegebenen doc_ids liegt ein Vektor von ${model.alias} vor.\n` +
        `Nicht gefunden: ${fehlend.join(", ")}`,
      missing: fehlend,
    });
  }

  const t0 = Date.now();
  const { rows } = await pool.query<HitRow>(
    `WITH zentroid AS (
         SELECT avg(embedding) AS v
           FROM embeddings
          WHERE model = $2 AND doc_id = ANY($1::bigint[])
     )
     SELECT d.id::text AS doc_id,
            d.external_id,
            d.meta,
            (e.embedding <=> z.v)::float8 AS distance
       FROM embeddings e
       JOIN documents d ON d.id = e.doc_id
       CROSS JOIN zentroid z
      WHERE e.model = $2
        AND ($4::boolean OR NOT (e.doc_id = ANY($1::bigint[])))
      ORDER BY e.embedding <=> z.v
      LIMIT $3`,
    [[...gefunden], model.id, k, includeBasis],
  );
  const searchMs = Date.now() - t0;

  sendJson(res, 200, {
    model: model.alias,
    modelId: model.id,
    basis: basisRows.map((r) => ({ docId: r.doc_id, name: r.meta.name })),
    missing: fehlend,
    includeBasis,
    searchMs,
    hits: rows.map((row) => ({
      docId: row.doc_id,
      externalId: row.external_id,
      distance: row.distance,
      ...row.meta,
    })),
  });
}

export function searchPlugin(): Plugin {
  return {
    name: "ai-embed-search",
    configureServer(server) {
      // Vite lädt .env nicht in process.env. Der Key und die DB-URL müssen
      // aber dort landen, weil scripts/lib/* sie von dort liest.
      const env = loadEnv(server.config.mode, server.config.root, "");
      for (const key of [
        "OPENROUTER_API_KEY",
        "DATABASE_URL",
        "EMBEDDING_MODEL",
      ]) {
        if (env[key] && !process.env[key]) process.env[key] = env[key];
      }

      const ROUTES = new Set([
        "/api/status",
        "/api/products",
        "/api/search",
        "/api/recommend",
      ]);

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (!ROUTES.has(path)) return next();

        try {
          if (path === "/api/status" && req.method === "GET") {
            await handleStatus(res);
          } else if (path === "/api/products" && req.method === "GET") {
            await handleProducts(res);
          } else if (path === "/api/search" && req.method === "POST") {
            await handleSearch(req, res);
          } else if (path === "/api/recommend" && req.method === "POST") {
            await handleRecommend(req, res);
          } else {
            sendJson(res, 405, { error: `${req.method} nicht erlaubt für ${path}` });
          }
        } catch (error) {
          // Nie den Dev-Server mitreißen: jeder Fehler wird zur Antwort.
          const message =
            error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[suche] ${message}`);
          sendJson(res, 500, { error: message });
        }
      });
    },
  };
}
