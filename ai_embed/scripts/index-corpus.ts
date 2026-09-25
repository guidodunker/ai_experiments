/**
 * Indexierungszeit — einmalig pro (Dokument, Modell).
 *
 * Liest documents.content, bettet den Text ein und schreibt das Ergebnis nach
 * embeddings. Läuft offline, Latenz spielt keine Rolle. Standardmäßig werden
 * nur Dokumente angefasst, für die mit diesem Modell noch kein Vektor
 * existiert — der Lauf ist also wiederholbar und nimmt nach einem Abbruch die
 * Arbeit wieder auf.
 *
 *   npm run embed:index
 *   npm run embed:index -- --model=qwen3-8b,bge-m3
 *   npm run embed:index -- --all --force
 */

import { getPool, closePool, assertSchema, describeTarget, toVectorLiteral } from "./lib/db.ts";
import { embedMany, usesSingleRequests } from "./lib/embed.ts";
import { parseArgs, flag, num, selectModels, fail } from "./lib/cli.ts";
import type { ModelSpec } from "./lib/models.ts";

type Doc = { id: string; content: string };

type ModelReport = {
  model: ModelSpec;
  embedded: number;
  skipped: number;
  dim: number | null;
  promptTokens: number;
  seconds: number;
};

async function pendingDocs(
  model: ModelSpec,
  force: boolean,
  limit: number | null,
): Promise<Doc[]> {
  const { rows } = await getPool().query<Doc>(
    `SELECT d.id::text, d.content
       FROM documents d
       LEFT JOIN embeddings e ON e.doc_id = d.id AND e.model = $1
      WHERE $2::boolean OR e.id IS NULL
      ORDER BY d.id
      ${limit === null ? "" : "LIMIT " + limit}`,
    [model.id, force],
  );
  return rows;
}

async function totalDocs(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM documents",
  );
  return Number(rows[0]!.n);
}

async function store(
  model: ModelSpec,
  docs: Doc[],
  vectors: number[][],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < docs.length; i++) {
      const vector = vectors[i]!;
      await client.query(
        `INSERT INTO embeddings (doc_id, model, dim, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (doc_id, model) DO UPDATE
            SET embedding  = EXCLUDED.embedding,
                dim        = EXCLUDED.dim,
                created_at = now()`,
        [docs[i]!.id, model.id, vector.length, toVectorLiteral(vector)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runModel(
  model: ModelSpec,
  opts: { force: boolean; batchSize: number; limit: number | null },
): Promise<ModelReport> {
  const started = Date.now();
  const docs = await pendingDocs(model, opts.force, opts.limit);
  const total = await totalDocs();

  console.log(
    `\n${model.alias}  (${model.id})` +
      `\n  offen: ${docs.length} von ${total}${model.render ? "  ·  mit Präfix für Dokumente/Anfragen" : ""}`,
  );

  if (docs.length === 0) {
    console.log("  nichts zu tun");
    return {
      model,
      embedded: 0,
      skipped: total,
      dim: null,
      promptTokens: 0,
      seconds: 0,
    };
  }

  let embedded = 0;
  let promptTokens = 0;
  let dim: number | null = null;

  for (let offset = 0; offset < docs.length; offset += opts.batchSize) {
    const chunk = docs.slice(offset, offset + opts.batchSize);
    const { vectors, promptTokens: used } = await embedMany(
      model,
      "document",
      chunk.map((d) => d.content),
    );

    const chunkDim = vectors[0]!.length;
    if (dim === null) {
      dim = chunkDim;
      console.log(
        `  Dimension: ${dim}` +
          (usesSingleRequests(model.id) ? "  ·  Einzelrequests" : "  ·  Batch-Requests"),
      );
    } else if (chunkDim !== dim) {
      throw new Error(
        `${model.alias}: Dimension wechselt mitten im Lauf (${dim} -> ${chunkDim}).`,
      );
    }

    await store(model, chunk, vectors);
    embedded += chunk.length;
    promptTokens += used;
    process.stdout.write(`\r  eingebettet: ${embedded}/${docs.length}`);
  }

  const seconds = (Date.now() - started) / 1000;
  process.stdout.write(
    `\r  eingebettet: ${embedded}/${docs.length}  in ${seconds.toFixed(1)} s` +
      (promptTokens > 0
        ? `  ·  ${promptTokens} Tokens  ·  ~${(
            (promptTokens / 1_000_000) *
            model.usdPerMtok
          ).toFixed(6)} USD\n`
        : "\n"),
  );

  return { model, embedded, skipped: total - embedded, dim, promptTokens, seconds };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const force = flag(flags, "force");
  const batchSize = num(flags, "batch", 16);
  const limit = flags.values.has("limit") ? num(flags, "limit", 0) : null;

  let models: ModelSpec[];
  try {
    models = selectModels(flags);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  await assertSchema();

  console.log(`Ziel:    ${describeTarget()}`);
  console.log(`Modelle: ${models.map((m) => m.alias).join(", ")}`);
  console.log(`Modus:   ${force ? "force (alles neu)" : "nur fehlende"}  ·  Batch ${batchSize}`);

  const reports: ModelReport[] = [];
  for (const model of models) {
    reports.push(await runModel(model, { force, batchSize, limit }));
  }

  const tokens = reports.reduce((s, r) => s + r.promptTokens, 0);
  const cost = reports.reduce(
    (s, r) => s + (r.promptTokens / 1_000_000) * r.model.usdPerMtok,
    0,
  );

  console.log("\n--- Ergebnis ---");
  for (const r of reports) {
    console.log(
      `  ${r.model.alias.padEnd(12)} ${String(r.embedded).padStart(4)} neu` +
        `   dim ${r.dim ?? "-"}`.padEnd(12) +
        `   ${r.seconds.toFixed(1)} s`,
    );
  }
  console.log(
    `  Gesamt: ${tokens} Tokens  ·  ~${cost.toFixed(6)} USD\n` +
      `  Stand:  SELECT * FROM model_stats;`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
