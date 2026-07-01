-- Migration: Chunked embeddings support for precedenti.ge
--
-- Problem: case_embedding_search_text() truncated full_text to first 3000 chars,
-- causing the verdict/resolution section (at end of document) to be absent from
-- embeddings, making verdict-based queries miss relevant cases.
--
-- Solution: TypeScript-side chunking (4000 chars + 500 overlap) with metadata
-- prefix per chunk. 1 case now produces N embeddings.
--
-- Changes:
--   1. Add chunk_index column (existing rows get 0 — backward compatible)
--   2. Replace UNIQUE(source_table, source_id) with UNIQUE(source_table, source_id, chunk_index)
--   3. Rewrite get_cases_for_embedding to return raw fields (TypeScript does chunking)
--   4. Rewrite search_cases_vector to deduplicate chunks before joining source tables

-- ─── 1. Schema changes ───────────────────────────────────────────────────────

ALTER TABLE public.case_search_embeddings
  ADD COLUMN IF NOT EXISTS chunk_index integer NOT NULL DEFAULT 0;

ALTER TABLE public.case_search_embeddings
  DROP CONSTRAINT IF EXISTS case_search_embeddings_source_table_source_id_key;

ALTER TABLE public.case_search_embeddings
  ADD CONSTRAINT case_search_embeddings_unique_chunk
  UNIQUE (source_table, source_id, chunk_index);

-- ─── 2. Vector index ─────────────────────────────────────────────────────────
-- Rebuilt after chunking because row count increases ~5x.
-- After full re-indexing is complete, run:
--   DROP INDEX case_search_embeddings_embedding_idx;
--   CREATE INDEX ... WITH (lists = <sqrt(total_rows)>);

DROP INDEX IF EXISTS public.case_search_embeddings_embedding_idx;

CREATE INDEX IF NOT EXISTS case_search_embeddings_embedding_idx
  ON public.case_search_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─── 3. get_cases_for_embedding — returns raw fields ─────────────────────────
-- TypeScript now builds chunks and prefixes metadata; SQL no longer calls
-- case_embedding_search_text(). The function still skips cases that have ANY
-- existing embedding row (incremental processing unchanged).

DROP FUNCTION IF EXISTS public.get_cases_for_embedding(text, int);

CREATE OR REPLACE FUNCTION public.get_cases_for_embedding(
  p_source_table text,
  p_limit        int DEFAULT 25
)
RETURNS TABLE (
  source_table      text,
  source_id         bigint,
  category          text,
  case_number       text,
  dispute_subject   text,
  legal_institution text,
  result            text,
  full_text         text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category text;
  v_limit    int;
BEGIN
  v_category := public.normalize_case_search_category(p_source_table);

  IF v_category IS NULL THEN
    RAISE EXCEPTION
      'Unknown source table: %. Valid: administrative_cases, criminal_cases, civil_cases',
      p_source_table;
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

  IF p_source_table = 'administrative_cases' THEN
    RETURN QUERY
    SELECT
      'administrative_cases'::text,
      c.id::bigint,
      'administrative'::text,
      c.case_number::text,
      c.dispute_subject::text,
      c.legal_institution::text,
      c.result::text,
      c.full_text::text
    FROM public.administrative_cases c
    WHERE COALESCE(c.full_text, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.case_search_embeddings e
        WHERE e.source_table = 'administrative_cases' AND e.source_id = c.id
      )
    ORDER BY c.id
    LIMIT v_limit;

  ELSIF p_source_table = 'criminal_cases' THEN
    RETURN QUERY
    SELECT
      'criminal_cases'::text,
      c.id::bigint,
      'criminal'::text,
      c.case_number::text,
      NULL::text,   -- criminal_cases has no dispute_subject
      NULL::text,   -- criminal_cases has no legal_institution
      c.result::text,
      c.full_text::text
    FROM public.criminal_cases c
    WHERE COALESCE(c.full_text, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.case_search_embeddings e
        WHERE e.source_table = 'criminal_cases' AND e.source_id = c.id
      )
    ORDER BY c.id
    LIMIT v_limit;

  ELSIF p_source_table = 'civil_cases' THEN
    RETURN QUERY
    SELECT
      'civil_cases'::text,
      c.id::bigint,
      'civil'::text,
      c.case_number::text,
      c.dispute_subject::text,
      c.legal_institution::text,
      c.result::text,
      c.full_text::text
    FROM public.civil_cases c
    WHERE COALESCE(c.full_text, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.case_search_embeddings e
        WHERE e.source_table = 'civil_cases' AND e.source_id = c.id
      )
    ORDER BY c.id
    LIMIT v_limit;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cases_for_embedding(text, int)
  TO anon, authenticated, service_role;

-- ─── 4. search_cases_vector — deduplicate chunks ─────────────────────────────
-- With N chunks per case the old query returned duplicate source_ids.
-- nearest_chunks oversamples (limit * 8), then ROW_NUMBER() keeps only the
-- best-scoring chunk per case before joining source tables.

DROP FUNCTION IF EXISTS public.search_cases_vector(vector(1536), text, int);

CREATE OR REPLACE FUNCTION public.search_cases_vector(
  query_embedding vector(1536),
  p_category      text DEFAULT NULL,
  p_limit         int  DEFAULT 20
)
RETURNS TABLE (
  id              text,
  source_table    text,
  category        text,
  case_number     text,
  decision_date   text,
  dispute_subject text,
  result          text,
  appeal_type     text,
  full_text       text,
  court_branch    text,
  fullcase_url    text,
  download_url    text,
  semantic_score  real,
  search_mode     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit    int;
  v_category text;
BEGIN
  v_limit    := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_category := NULLIF(trim(COALESCE(p_category, '')), '');

  RETURN QUERY
  WITH nearest_chunks AS (
    -- Oversample: with ~5 chunks/case we need 8x to fill v_limit unique cases.
    -- ivfflat scans lists proportionally — this is intentional.
    SELECT
      e.source_table,
      e.source_id,
      e.category,
      (1 - (e.embedding <=> query_embedding))::real AS semantic_score,
      ROW_NUMBER() OVER (
        PARTITION BY e.source_table, e.source_id
        ORDER BY e.embedding <=> query_embedding  -- lowest distance = best chunk
      ) AS rn
    FROM public.case_search_embeddings e
    WHERE v_category IS NULL OR e.category = v_category
    ORDER BY e.embedding <=> query_embedding
    LIMIT v_limit * 8
  ),
  ranked AS (
    -- One row per case: the chunk with highest semantic similarity
    SELECT source_table, source_id, category, semantic_score
    FROM nearest_chunks
    WHERE rn = 1
    ORDER BY semantic_score DESC
    LIMIT v_limit
  ),
  unified AS (
    SELECT
      a.id::text,
      r.source_table,
      r.category,
      a.case_number::text,
      a.decision_date::text,
      a.dispute_subject::text,
      a.result::text,
      a.appeal_type::text,
      left(a.full_text, 3000)::text,
      a.court_branch::text,
      a.fullcase_url::text,
      a.download_url::text,
      r.semantic_score
    FROM ranked r
    JOIN public.administrative_cases a
      ON r.source_table = 'administrative_cases' AND a.id = r.source_id

    UNION ALL

    SELECT
      c.id::text,
      r.source_table,
      r.category,
      c.case_number::text,
      c.decision_date::text,
      NULL::text,
      c.result::text,
      c.appeal_type::text,
      left(c.full_text, 3000)::text,
      c.court_branch::text,
      c.fullcase_url::text,
      c.download_url::text,
      r.semantic_score
    FROM ranked r
    JOIN public.criminal_cases c
      ON r.source_table = 'criminal_cases' AND c.id = r.source_id

    UNION ALL

    SELECT
      cv.id::text,
      r.source_table,
      r.category,
      cv.case_number::text,
      cv.decision_date::text,
      cv.dispute_subject::text,
      cv.result::text,
      cv.appeal_type::text,
      left(cv.full_text, 3000)::text,
      cv.court_branch::text,
      cv.fullcase_url::text,
      cv.download_url::text,
      r.semantic_score
    FROM ranked r
    JOIN public.civil_cases cv
      ON r.source_table = 'civil_cases' AND cv.id = r.source_id
  )
  SELECT
    unified.id,
    unified.source_table,
    unified.category,
    unified.case_number,
    unified.decision_date,
    unified.dispute_subject,
    unified.result,
    unified.appeal_type,
    unified.full_text,
    unified.court_branch,
    unified.fullcase_url,
    unified.download_url,
    unified.semantic_score,
    'vector_search'::text
  FROM unified
  ORDER BY unified.semantic_score DESC
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_cases_vector(vector(1536), text, int)
  TO anon, authenticated, service_role;
