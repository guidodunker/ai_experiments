import pg from "pg";

/**
 * Pool und Verbindungsstring werden faul aufgebaut. Der Vite-Dev-Server lädt
 * .env erst in configureServer — würde der Pool beim Import entstehen, stünde
 * DATABASE_URL zu dem Zeitpunkt noch nicht.
 */
let pool: pg.Pool | null = null;

function connectionString(): string {
  return (
    process.env.DATABASE_URL ?? "postgresql://embed:embed@localhost:5436/embed"
  );
}

export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: connectionString(), max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const open = pool;
  pool = null;
  await open.end();
}

/** pgvector liest Vektoren als Textliteral. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function assertSchema(): Promise<void> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT to_regclass('public.documents') IS NOT NULL
        AND to_regclass('public.embeddings') IS NOT NULL AS ok`,
  );
  if (!rows[0]?.ok) {
    throw new Error(
      `Tabellen documents/embeddings fehlen in ${describeTarget()}.\n` +
        `Läuft der Container? docker compose up -d`,
    );
  }
}

export function describeTarget(): string {
  return connectionString().replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}
