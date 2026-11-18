import { allModels } from "../../../ai_embed/scripts/lib/models.ts";
import type { ModelSpec } from "../../../ai_embed/scripts/lib/models.ts";

/**
 * Elasticsearch wird direkt über fetch angesprochen, ohne Client-Bibliothek.
 * Für ein paar Endpunkte (_bulk, _search, _mapping) lohnt keine Abhängigkeit,
 * und die Request-Bodies bleiben so 1:1 mit der Elasticsearch-Doku vergleichbar.
 *
 * URL und Index werden erst beim Aufruf gelesen, nicht beim Import: die
 * Suchseite von ai_embed lädt .env erst in configureServer (wie bei db.ts).
 */
export function esUrl(): string {
  return (process.env.ES_URL ?? "http://127.0.0.1:9200").replace(/\/$/, "");
}

export function esIndex(): string {
  return process.env.ES_INDEX ?? "ai_embed_docs";
}

/** dense_vector-Grenze in Elasticsearch 9.x. */
export const MAX_DIMS = 4096;

/** Ein Feld pro Modell, weil dense_vector eine feste Dimension verlangt. */
export function fieldFor(model: ModelSpec): string {
  return "emb_" + model.alias.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

export function modelForField(field: string): ModelSpec | undefined {
  return allModels().find((m) => fieldFor(m) === field);
}

/**
 * pg wirft bei verweigerter Verbindung einen AggregateError mit leerer
 * message (IPv4 und IPv6 schlagen beide fehl) — ohne diese Hilfe bliebe die
 * Ausgabe leer.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message) return error.message;
  const code = (error as { code?: string }).code;
  if (code === "ECONNREFUSED") {
    return (
      `pgvector-Datenbank von ai_embed nicht erreichbar (${code}).\n` +
      `  Läuft der Container? Im Ordner ai_embed: docker compose up -d`
    );
  }
  return code ?? error.name;
}

type EsError ={ error?: { type?: string; reason?: string; root_cause?: { reason?: string }[] } };

export async function es<T>(
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD",
  path: string,
  body?: unknown,
): Promise<T> {
  const ndjson = typeof body === "string";
  let response: Response;
  try {
    response = await fetch(`${esUrl()}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": ndjson ? "application/x-ndjson" : "application/json" },
      body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `Elasticsearch unter ${esUrl()} nicht erreichbar (${error instanceof Error ? error.message : error}).\n` +
        `  Läuft der Container? Im Ordner elasticsearch: docker compose up -d elasticsearch\n` +
        `  Direkt nach dem Start braucht der Knoten ~30 s, bis er antwortet: docker ps zeigt dann (healthy).`,
    );
  }

  const text = await response.text();
  const json = text.length > 0 ? (JSON.parse(text) as T & EsError) : ({} as T & EsError);
  if (!response.ok) {
    const reason =
      json.error?.root_cause?.[0]?.reason ?? json.error?.reason ?? text.slice(0, 300);
    throw new Error(`${method} ${path}: HTTP ${response.status} ${json.error?.type ?? ""}\n  ${reason}`);
  }
  return json;
}

export async function indexExists(): Promise<boolean> {
  const response = await fetch(`${esUrl()}/${esIndex()}`, { method: "HEAD" }).catch(() => null);
  return response?.status === 200;
}

export type VectorField = { field: string; dims: number; indexType: string };

type MappingResponse = Record<
  string,
  {
    mappings: {
      properties?: Record<
        string,
        { type: string; dims?: number; index_options?: { type?: string } }
      >;
    };
  }
>;

/** Vektorfelder, wie sie tatsächlich im Index stehen, nicht wie sie gedacht waren. */
export async function vectorFields(): Promise<VectorField[]> {
  const mapping = await es<MappingResponse>("GET", `/${esIndex()}/_mapping`);
  const properties = mapping[esIndex()]?.mappings.properties ?? {};
  return Object.entries(properties)
    .filter(([, p]) => p.type === "dense_vector")
    .map(([field, p]) => ({
      field,
      dims: p.dims ?? 0,
      indexType: p.index_options?.type ?? "(Standard)",
    }));
}
