/**
 * Query-Zeit — einmal pro Suchanfrage, online.
 *
 * Die Anfrage muss mit demselben Modell eingebettet werden wie der Korpus,
 * sonst ist der Vergleich bedeutungslos. Dieser API-Call liegt auf dem
 * kritischen Pfad; das Skript weist Embedding-Dauer und DB-Dauer getrennt aus,
 * damit sichtbar bleibt, wo die Zeit hingeht.
 *
 *   npm run embed:query -- "womit säge ich Kurven in Holz"
 *   npm run embed:query -- "billiger Akkuschrauber für Möbelaufbau" --k=5
 *   npm run embed:query -- "Hecke schneiden" --model=qwen3-8b
 */

import { getPool, closePool, assertSchema, describeTarget, toVectorLiteral } from "./lib/db.ts";
import { embedOne } from "./lib/embed.ts";
import { parseArgs, num, selectModels, fail } from "./lib/cli.ts";
import type { ModelSpec } from "./lib/models.ts";

type Hit = {
  doc_id: string;
  external_id: string;
  content: string;
  distance: number;
};

type Result = {
  model: ModelSpec;
  dim: number;
  hits: Hit[];
  embedMs: number;
  searchMs: number;
};

/** Modelle, für die tatsächlich Vektoren in der DB liegen. */
async function indexedModels(): Promise<Map<string, number>> {
  const { rows } = await getPool().query<{ model: string; dim: number }>(
    "SELECT model, dim FROM embeddings GROUP BY model, dim ORDER BY model",
  );
  return new Map(rows.map((r) => [r.model, r.dim]));
}

async function runOne(model: ModelSpec, query: string, k: number): Promise<Result> {
  const t0 = Date.now();
  const vector = await embedOne(model, "query", query);
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  const { rows } = await getPool().query<Hit>(
    "SELECT * FROM search($1::vector, $2, $3)",
    [toVectorLiteral(vector), model.id, k],
  );
  const searchMs = Date.now() - t1;

  return { model, dim: vector.length, hits: rows, embedMs, searchMs };
}

function shortName(hit: Hit): string {
  // Der gerenderte Text beginnt mit dem Produktnamen bis zum ersten Punkt-Space.
  const cut = hit.content.indexOf(". Kategorie:");
  return cut === -1 ? hit.content.slice(0, 60) : hit.content.slice(0, cut);
}

function printResult(result: Result): void {
  const { model, dim, hits, embedMs, searchMs } = result;
  console.log(
    `\n${model.alias}  ·  dim ${dim}  ·  Embedding ${embedMs} ms  ·  DB ${searchMs} ms`,
  );
  if (hits.length === 0) {
    console.log("  keine Treffer — ist der Korpus für dieses Modell indexiert?");
    return;
  }
  for (const [i, hit] of hits.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}  ${hit.distance.toFixed(4)}  ${shortName(hit)}`,
    );
  }
}

/** Anteil gemeinsamer Treffer in den Top-k — das eigentliche Vergleichssignal. */
function printAgreement(results: Result[]): void {
  if (results.length < 2) return;

  console.log("\n--- Übereinstimmung der Top-k (Anteil gemeinsamer Treffer) ---");
  const width = Math.max(...results.map((r) => r.model.alias.length));
  const header = results.map((r) => r.model.alias.slice(0, 7).padStart(7)).join(" ");
  console.log(" ".repeat(width + 2) + header);

  for (const a of results) {
    const cells = results.map((b) => {
      if (a === b) return "      ·";
      const setA = new Set(a.hits.map((h) => h.doc_id));
      const shared = b.hits.filter((h) => setA.has(h.doc_id)).length;
      const denom = Math.max(a.hits.length, b.hits.length, 1);
      return (shared / denom).toFixed(2).padStart(7);
    });
    console.log(`  ${a.model.alias.padEnd(width)}${cells.join(" ")}`);
  }
  console.log(
    "\n  1.00 = identische Trefferliste, 0.00 = kein gemeinsamer Treffer.\n" +
      "  Niedrige Werte heißen nicht, dass ein Modell falsch liegt — sie zeigen,\n" +
      "  wo du selbst entscheiden musst, welche Liste die bessere ist.",
  );
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const query = flags.positional.join(" ").trim();
  if (!query) {
    fail(
      'Keine Suchanfrage angegeben.\n  npm run embed:query -- "womit säge ich Kurven in Holz"',
    );
  }
  const k = num(flags, "k", 5);

  await assertSchema();
  const indexed = await indexedModels();

  if (indexed.size === 0) {
    fail(
      "In embeddings liegen noch keine Vektoren.\n  Erst indexieren: npm run embed:index",
    );
  }

  // Ohne --model genau ein Modell: das aus EMBEDDING_MODEL.
  let models: ModelSpec[];
  try {
    models = selectModels(flags);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const missing = models.filter((m) => !indexed.has(m.id));
  if (missing.length > 0) {
    const aliases = missing.map((m) => m.alias).join(",");
    fail(
      `Für dieses Modell liegen keine Vektoren im Korpus: ${aliases}\n` +
        `  Erst indexieren:  node --experimental-strip-types --env-file=.env scripts/index-corpus.ts --model=${aliases}\n` +
        `  Indexiert sind:   ${[...indexed.keys()].join(", ")}`,
    );
  }

  console.log(`Ziel:    ${describeTarget()}`);
  console.log(`Anfrage: "${query}"   (Top ${k})`);

  const results: Result[] = [];
  for (const model of models) {
    const result = await runOne(model, query, k);
    printResult(result);
    results.push(result);
  }

  printAgreement(results);

  const embedTotal = results.reduce((s, r) => s + r.embedMs, 0);
  const dbTotal = results.reduce((s, r) => s + r.searchMs, 0);
  console.log(
    `\n  Summe: ${embedTotal} ms Embedding-API gegen ${dbTotal} ms Datenbank.`,
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
