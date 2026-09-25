import { allModels, defaultModel, resolveModel } from "./models.ts";
import type { ModelSpec } from "./models.ts";

export type Flags = {
  values: Map<string, string[]>;
  positional: string[];
};

export function parseArgs(argv: string[]): Flags {
  const values = new Map<string, string[]>();
  const positional: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? "true" : body.slice(eq + 1);
    const bucket = values.get(key);
    if (bucket) bucket.push(value);
    else values.set(key, [value]);
  }

  return { values, positional };
}

export function flag(flags: Flags, name: string): boolean {
  return flags.values.has(name);
}

export function str(
  flags: Flags,
  name: string,
  fallback: string,
): string {
  return flags.values.get(name)?.at(-1) ?? fallback;
}

export function num(flags: Flags, name: string, fallback: number): number {
  const raw = flags.values.get(name)?.at(-1);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} erwartet eine positive Zahl, bekam "${raw}"`);
  }
  return parsed;
}

/**
 * Ohne Angabe wird genau EIN Modell verwendet: das aus EMBEDDING_MODEL.
 * --model nimmt Aliase oder OpenRouter-IDs, mehrfach oder als Kommaliste;
 * --all nimmt die ganze Registry. Beides ist der ausdrückliche Weg in einen
 * Mehrmodell-Vergleich, nicht der Normalfall.
 */
export function selectModels(flags: Flags): ModelSpec[] {
  if (flag(flags, "all")) return allModels();

  const raw = (flags.values.get("model") ?? []).flatMap((v) =>
    v.split(",").map((s) => s.trim()).filter(Boolean),
  );

  if (raw.length === 0) return [defaultModel()];

  const keys = raw;
  const seen = new Set<string>();
  const models: ModelSpec[] = [];
  for (const key of keys) {
    const model = resolveModel(key);
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

export function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}
