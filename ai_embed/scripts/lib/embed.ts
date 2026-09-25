import { OpenRouter } from "@openrouter/sdk";
import { renderFor } from "./models.ts";
import type { EmbeddingRole, ModelSpec } from "./models.ts";

/**
 * Der Key wird erst beim ersten echten Aufruf verlangt, nicht beim Import.
 * Sonst quittiert ein Tippfehler im Modellnamen mit "API-Key fehlt" statt mit
 * der Meldung, die weiterhilft.
 *
 * Fehlt der Key, wird geworfen und nicht der Prozess beendet: derselbe Code
 * läuft im Dev-Server, und ein process.exit() dort würde den Server abschießen.
 */
export const MISSING_KEY_MESSAGE =
  "OPENROUTER_API_KEY ist nicht gesetzt.\n" +
  "  Key holen: https://openrouter.ai/keys\n" +
  "  Eintragen in .env, dann erneut starten.";

let client: OpenRouter | null = null;

function getClient(): OpenRouter {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  client = new OpenRouter({ apiKey });
  return client;
}

export type EmbedBatch = {
  vectors: number[][];
  /** Vom Anbieter gemeldete Input-Tokens, 0 wenn nicht geliefert. */
  promptTokens: number;
};

/**
 * Ob das Modell mehrere Texte pro Request akzeptiert, wird nicht angenommen,
 * sondern beim ersten Batch ausprobiert. Schlägt es fehl, fällt dieses Modell
 * dauerhaft auf Einzelrequests zurück.
 */
const singleOnly = new Set<string>();

export function usesSingleRequests(modelId: string): boolean {
  return singleOnly.has(modelId);
}

async function rawEmbed(
  modelId: string,
  input: string | string[],
): Promise<EmbedBatch> {
  const response = await getClient().embeddings.generate({
    requestBody: { model: modelId, input, encodingFormat: "float" },
  });

  if (typeof response === "string") {
    throw new Error(`Unerwartete Rohantwort: ${response.slice(0, 200)}`);
  }

  const wanted = Array.isArray(input) ? input.length : 1;
  if (response.data.length !== wanted) {
    throw new Error(
      `${modelId}: ${wanted} Texte geschickt, ${response.data.length} Vektoren zurück.`,
    );
  }

  // Reihenfolge nicht voraussetzen — die API liefert einen index mit.
  const sorted = [...response.data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );

  const vectors = sorted.map((item, i) => {
    const vector = item.embedding;
    if (typeof vector === "string") {
      throw new Error(
        `${modelId}: Float-Vektor erwartet, base64-String bekommen (Position ${i}).`,
      );
    }
    if (vector.length === 0) {
      throw new Error(`${modelId}: leerer Vektor an Position ${i}.`);
    }
    return vector;
  });

  const dims = new Set(vectors.map((v) => v.length));
  if (dims.size > 1) {
    throw new Error(
      `${modelId}: uneinheitliche Dimensionen in einer Antwort (${[...dims].join(", ")}).`,
    );
  }

  return { vectors, promptTokens: response.usage?.promptTokens ?? 0 };
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|5\d\d)\b|rate.?limit|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    message,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;
      const waitMs = 500 * 2 ** (attempt - 1);
      console.warn(
        `  ${label}: Versuch ${attempt} fehlgeschlagen (${error instanceof Error ? error.message : error}), neuer Versuch in ${waitMs} ms`,
      );
      await sleep(waitMs);
    }
  }
  throw lastError;
}

/**
 * Bettet mehrere Texte mit einem Modell ein. Präfixe kommen aus der Registry
 * und hängen an der Rolle (Anfrage vs. Dokument).
 */
export async function embedMany(
  model: ModelSpec,
  role: EmbeddingRole,
  texts: string[],
): Promise<EmbedBatch> {
  if (texts.length === 0) return { vectors: [], promptTokens: 0 };

  const rendered = texts.map((t) => renderFor(model, role, t));

  if (rendered.length === 1) {
    const first = rendered[0]!;
    return withRetry(model.alias, () => rawEmbed(model.id, first));
  }

  if (!singleOnly.has(model.id)) {
    try {
      return await withRetry(model.alias, () => rawEmbed(model.id, rendered));
    } catch (error) {
      console.warn(
        `  ${model.alias}: Batch-Request abgelehnt (${error instanceof Error ? error.message : error}).\n` +
          `  Falle für dieses Modell auf Einzelrequests zurück.`,
      );
      singleOnly.add(model.id);
    }
  }

  const vectors: number[][] = [];
  let promptTokens = 0;
  for (const text of rendered) {
    const one = await withRetry(model.alias, () => rawEmbed(model.id, text));
    vectors.push(one.vectors[0]!);
    promptTokens += one.promptTokens;
  }
  return { vectors, promptTokens };
}

export async function embedOne(
  model: ModelSpec,
  role: EmbeddingRole,
  text: string,
): Promise<number[]> {
  const { vectors } = await embedMany(model, role, [text]);
  return vectors[0]!;
}
