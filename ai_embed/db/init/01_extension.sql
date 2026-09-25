-- pgvector aktivieren. Läuft nur beim allerersten Start des Containers
-- (leeres Datenverzeichnis) automatisch.
CREATE EXTENSION IF NOT EXISTS vector;

-- Nützlich für Textsuche-Vergleiche (BM25-artig via ts_rank) und
-- Trigram-Fallback beim Debuggen.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
