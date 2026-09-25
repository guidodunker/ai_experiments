/**
 * Registry der Embedding-Modelle, die verglichen werden sollen.
 *
 * Zwei Dinge, die hier drinstecken und leicht übersehen werden:
 *
 * 1. Die Dimension steht NICHT in der OpenRouter-API. Sie wird beim ersten
 *    Embedding-Call aus der Antwort gelesen und in embeddings.dim gespeichert.
 *
 * 2. Manche Modelle sind asymmetrisch: Suchanfrage und Dokument müssen
 *    unterschiedlich präfigiert werden. Das ist keine Feinheit — falsch
 *    gesetzt misst der Vergleich das Präfix statt das Modell. Die Konvention
 *    steht jeweils auf der Modellkarte; die Angaben hier sind der Stand der
 *    verbreiteten Dokumentation und gehören gegengeprüft, bevor du ein
 *    Ergebnis als belastbar ausgibst.
 */

export type EmbeddingRole = "document" | "query";

export type ModelSpec = {
  /** OpenRouter-Modell-ID */
  id: string;
  /** Kurzform für die Kommandozeile */
  alias: string;
  /** Sprachabdeckung — für einen deutschen Korpus entscheidend */
  languages: "mehrsprachig" | "englisch";
  /** USD pro 1 Mio. Input-Tokens, Stand Katalogabruf */
  usdPerMtok: number;
  /** Baut aus Rohtext den Text, der tatsächlich eingebettet wird */
  render?: (role: EmbeddingRole, text: string) => string;
  note?: string;
};

/**
 * Aufgabenbeschreibung für Modelle, die eine Instruktion erwarten (Qwen3).
 * Bewusst domänenspezifisch — eine generische Beschreibung kostet Trefferqualität.
 */
export const TASK =
  "Gegeben die Suchanfrage eines Baumarkt-Kunden, finde das passende Produkt";

const MODELS: ModelSpec[] = [
  {
    id: "qwen/qwen3-embedding-8b",
    alias: "qwen3-8b",
    languages: "mehrsprachig",
    usdPerMtok: 0.01,
    render: (role, text) =>
      role === "query" ? `Instruct: ${TASK}\nQuery: ${text}` : text,
    note: "Instruktions-Präfix nur auf der Query-Seite.",
  },
  {
    id: "qwen/qwen3-embedding-4b",
    alias: "qwen3-4b",
    languages: "mehrsprachig",
    usdPerMtok: 0.02,
    render: (role, text) =>
      role === "query" ? `Instruct: ${TASK}\nQuery: ${text}` : text,
    note: "Kleinere Schwester von qwen3-8b, hier teurer gelistet.",
  },
  {
    id: "intfloat/multilingual-e5-large",
    alias: "e5-multi",
    languages: "mehrsprachig",
    usdPerMtok: 0.01,
    render: (role, text) =>
      role === "query" ? `query: ${text}` : `passage: ${text}`,
    note: "E5 verlangt die Präfixe query:/passage: — ohne sie bricht die Qualität ein. Nur 512 Token Kontext.",
  },
  {
    id: "baai/bge-m3",
    alias: "bge-m3",
    languages: "mehrsprachig",
    usdPerMtok: 0.01,
    note: "Mehrsprachig, kein Präfix nötig, 8k Kontext.",
  },
  {
    id: "google/gemini-embedding-2",
    alias: "gemini-2",
    languages: "mehrsprachig",
    usdPerMtok: 0.2,
    note: "Teuerstes im Feld. Gemini kennt task_type — über die OpenAI-kompatible Route nicht setzbar.",
  },
  {
    id: "openai/text-embedding-3-large",
    alias: "oai-3-large",
    languages: "mehrsprachig",
    usdPerMtok: 0.13,
    note: "3072 Dimensionen — materialize_model() legt dafür einen halfvec-Index an.",
  },
  {
    id: "openai/text-embedding-3-small",
    alias: "oai-3-small",
    languages: "mehrsprachig",
    usdPerMtok: 0.02,
  },
  {
    id: "voyageai/voyage-4",
    alias: "voyage-4",
    languages: "mehrsprachig",
    usdPerMtok: 0.06,
    note: "Voyage kennt input_type (query/document) — über die OpenAI-kompatible Route nicht setzbar.",
  },
  {
    id: "mistralai/mistral-embed-2312",
    alias: "mistral",
    languages: "mehrsprachig",
    usdPerMtok: 0.1,
  },
  {
    id: "baai/bge-large-en-v1.5",
    alias: "bge-en",
    languages: "englisch",
    usdPerMtok: 0.01,
    render: (role, text) =>
      role === "query"
        ? `Represent this sentence for searching relevant passages: ${text}`
        : text,
    note: "Englisch-only. Als Negativ-Referenz nützlich: zeigt, wie stark Sprachabdeckung zählt.",
  },
];

const byKey = new Map<string, ModelSpec>();
for (const m of MODELS) {
  byKey.set(m.alias, m);
  byKey.set(m.id, m);
}

export function allModels(): ModelSpec[] {
  return MODELS;
}

/**
 * Das eine Modell, mit dem gearbeitet wird. Kommt aus EMBEDDING_MODEL in .env,
 * damit Indexierung und Suche nicht auseinanderlaufen können — ein Korpus, der
 * mit Modell A eingebettet wurde, ist mit einer Anfrage aus Modell B nicht
 * durchsuchbar. --model übersteuert für einen einzelnen Aufruf.
 */
export function defaultModel(): ModelSpec {
  const configured = process.env.EMBEDDING_MODEL?.trim();
  return resolveModel(configured && configured.length > 0 ? configured : "qwen3-8b");
}

/** Nimmt Alias oder volle OpenRouter-ID. */
export function resolveModel(key: string): ModelSpec {
  const found = byKey.get(key);
  if (found) return found;
  throw new Error(
    `Unbekanntes Modell: ${key}\nBekannt: ${MODELS.map((m) => m.alias).join(", ")}\n` +
      `Beliebige OpenRouter-ID geht auch, muss dann aber in scripts/lib/models.ts eingetragen werden.`,
  );
}

/** Baut den Text, der wirklich an die API geht. */
export function renderFor(
  model: ModelSpec,
  role: EmbeddingRole,
  text: string,
): string {
  return model.render ? model.render(role, text) : text;
}
