-- ---------------------------------------------------------------------------
-- Testbett für den Vergleich mehrerer Embedding-Modelle.
--
-- Kernidee: die Vektorspalte ist bewusst OHNE feste Dimension deklariert,
-- damit Modelle mit 384 / 768 / 1024 / 1536 / 3072 Dimensionen nebeneinander
-- in derselben Tabelle liegen können. Preis dafür: pgvector kann auf einer
-- dimensionslosen Spalte keinen ANN-Index (HNSW/IVFFlat) anlegen — Suche läuft
-- als exakter Seq-Scan. Für Modellvergleiche ist das sogar erwünscht (echtes
-- Top-k, kein Recall-Verlust durch Approximation) und bis in den Bereich
-- einiger zehntausend Zeilen schnell genug.
--
-- Wenn du Index-Performance messen willst: materialize_model('<modell>')
-- erzeugt daraus eine typisierte Tabelle mit HNSW-Index (siehe unten).
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
    id          bigserial PRIMARY KEY,
    -- freie Kennung aus der Quelle (Dateiname, URL, Chunk-ID …)
    external_id text UNIQUE,
    content     text        NOT NULL,
    meta        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_meta_idx    ON documents USING gin (meta);
CREATE INDEX documents_content_trgm ON documents USING gin (content gin_trgm_ops);

COMMENT ON TABLE documents IS 'Der Testkorpus: ein Chunk pro Zeile.';


CREATE TABLE embeddings (
    id         bigserial PRIMARY KEY,
    doc_id     bigint      NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    -- Modellkennung, frei wählbar, z.B. 'nomic-embed-text' oder 'voyage-3'
    model      text        NOT NULL,
    dim        int         NOT NULL,
    embedding  vector      NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT embeddings_doc_model_uniq UNIQUE (doc_id, model),
    -- schützt davor, dass ein falsch dimensionierter Vektor unbemerkt
    -- unter einer Modellkennung landet
    CONSTRAINT embeddings_dim_matches CHECK (vector_dims(embedding) = dim)
);

CREATE INDEX embeddings_model_idx ON embeddings (model);

COMMENT ON COLUMN embeddings.embedding IS
    'Absichtlich vector ohne Dimension — erlaubt gemischte Modelle, verhindert ANN-Index.';


-- Überblick: welche Modelle liegen mit wie vielen Vektoren in der DB?
CREATE VIEW model_stats AS
SELECT model,
       dim,
       count(*)        AS vectors,
       min(created_at) AS first_seen,
       max(created_at) AS last_seen
FROM embeddings
GROUP BY model, dim
ORDER BY model;


-- ---------------------------------------------------------------------------
-- Top-k-Suche für ein Modell. Cosine-Distanz (<=>), also 0 = identisch.
--
--   SELECT * FROM search('[0.1,0.2,...]'::vector, 'nomic-embed-text', 5);
-- ---------------------------------------------------------------------------
CREATE FUNCTION search(p_query vector, p_model text, p_k int DEFAULT 10)
RETURNS TABLE (doc_id bigint, external_id text, content text, distance float8)
LANGUAGE sql STABLE AS $$
    SELECT d.id,
           d.external_id,
           d.content,
           (e.embedding <=> p_query)::float8
    FROM embeddings e
    JOIN documents d ON d.id = e.doc_id
    WHERE e.model = p_model
    ORDER BY e.embedding <=> p_query
    LIMIT p_k;
$$;


-- ---------------------------------------------------------------------------
-- Dasselbe Ranking für ALLE Modelle nebeneinander — das eigentliche
-- Vergleichswerkzeug. Erwartet pro Modell den passenden Query-Vektor als
-- jsonb-Map {"modell": [0.1, 0.2, ...], ...}, weil jedes Modell die Anfrage
-- selbst einbetten muss.
--
--   SELECT * FROM compare_models('{"nomic-embed-text": [...], "bge-m3": [...]}', 5);
-- ---------------------------------------------------------------------------
CREATE FUNCTION compare_models(p_queries jsonb, p_k int DEFAULT 10)
RETURNS TABLE (model text, rank int, doc_id bigint, content text, distance float8)
LANGUAGE sql STABLE AS $$
    SELECT q.model,
           r.rank::int,
           r.doc_id,
           r.content,
           r.distance
    FROM jsonb_each(p_queries) AS q(model, vec)
    CROSS JOIN LATERAL (
        SELECT row_number() OVER (ORDER BY e.embedding <=> (q.vec #>> '{}')::vector) AS rank,
               d.id  AS doc_id,
               d.content,
               (e.embedding <=> (q.vec #>> '{}')::vector)::float8 AS distance
        FROM embeddings e
        JOIN documents d ON d.id = e.doc_id
        WHERE e.model = q.model
        ORDER BY e.embedding <=> (q.vec #>> '{}')::vector
        LIMIT p_k
    ) r
    ORDER BY q.model, r.rank;
$$;


-- ---------------------------------------------------------------------------
-- Zieht die Vektoren eines Modells in eine typisierte Tabelle emb_<modell>
-- mit vector(dim) und legt einen HNSW-Index an. Erst damit wird ANN-Suche
-- und Index-Benchmarking möglich.
--
--   SELECT materialize_model('nomic-embed-text');
--   SELECT * FROM emb_nomic_embed_text ORDER BY embedding <=> $1 LIMIT 10;
--
-- Dimensionsgrenzen von pgvector: vector-Index bis 2000 Dim. Darüber
-- (z.B. text-embedding-3-large mit 3072) wird der Index auf halfvec
-- gelegt — halbe Präzision, Recall-Verlust praktisch vernachlässigbar.
-- ---------------------------------------------------------------------------
CREATE FUNCTION materialize_model(p_model text, p_m int DEFAULT 16, p_ef int DEFAULT 64)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_dims  int;
    v_dim   int;
    v_rows  bigint;
    v_table text;
BEGIN
    SELECT count(DISTINCT dim), min(dim), count(*)
      INTO v_dims, v_dim, v_rows
    FROM embeddings WHERE model = p_model;

    IF v_dims = 0 THEN
        RAISE EXCEPTION 'Kein Embedding für Modell % vorhanden', p_model;
    ELSIF v_dims > 1 THEN
        RAISE EXCEPTION 'Modell % hat uneinheitliche Dimensionen (%) — erst bereinigen',
              p_model, v_dims;
    END IF;

    v_table := 'emb_' || regexp_replace(lower(p_model), '[^a-z0-9]+', '_', 'g');

    EXECUTE format('DROP TABLE IF EXISTS %I', v_table);
    EXECUTE format(
        'CREATE TABLE %I (
             doc_id    bigint PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
             embedding vector(%s) NOT NULL)',
        v_table, v_dim);
    EXECUTE format(
        'INSERT INTO %I (doc_id, embedding)
         SELECT doc_id, embedding::vector(%s) FROM embeddings WHERE model = %L',
        v_table, v_dim, p_model);

    IF v_dim <= 2000 THEN
        EXECUTE format(
            'CREATE INDEX %I ON %I USING hnsw (embedding vector_cosine_ops)
             WITH (m = %s, ef_construction = %s)',
            v_table || '_hnsw', v_table, p_m, p_ef);
    ELSE
        EXECUTE format(
            'CREATE INDEX %I ON %I USING hnsw ((embedding::halfvec(%s)) halfvec_cosine_ops)
             WITH (m = %s, ef_construction = %s)',
            v_table || '_hnsw', v_table, v_dim, p_m, p_ef);
    END IF;

    EXECUTE format('ANALYZE %I', v_table);

    RETURN format('%s: %s Vektoren, dim=%s, HNSW-Index angelegt%s',
                  v_table, v_rows, v_dim,
                  CASE WHEN v_dim > 2000 THEN ' (auf halfvec, da dim > 2000)' ELSE '' END);
END;
$$;
