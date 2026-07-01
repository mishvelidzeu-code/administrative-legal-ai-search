-- Search-only embeddings layer for precedenti.ge.
-- Keeps v1 FTS search untouched.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.case_search_embeddings (
  id            bigserial PRIMARY KEY,
  source_table  text NOT NULL CHECK (source_table IN ('administrative_cases', 'criminal_cases', 'civil_cases')),
  source_id     bigint NOT NULL,
  category      text NOT NULL CHECK (category IN ('administrative', 'criminal', 'civil')),
  case_number   text,
  search_text   text NOT NULL,
  embedding     vector(1536) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  model_version text NOT NULL DEFAULT 'text-embedding-3-small',

  UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS case_search_embeddings_source_idx
  ON public.case_search_embeddings (source_table, source_id);

CREATE INDEX IF NOT EXISTS case_search_embeddings_category_idx
  ON public.case_search_embeddings (category);

CREATE INDEX IF NOT EXISTS case_search_embeddings_created_at_idx
  ON public.case_search_embeddings (created_at DESC);

CREATE INDEX IF NOT EXISTS case_search_embeddings_embedding_idx
  ON public.case_search_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

ALTER TABLE public.case_search_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read case search embeddings" ON public.case_search_embeddings;
CREATE POLICY "Public can read case search embeddings"
  ON public.case_search_embeddings
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.normalize_case_search_category(p_source_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_source_table
    WHEN 'administrative_cases' THEN 'administrative'
    WHEN 'criminal_cases' THEN 'criminal'
    WHEN 'civil_cases' THEN 'civil'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.case_embedding_search_text(p_case jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(
    regexp_replace(
      concat_ws(
        E'\n',
        NULLIF('საქმის ნომერი: ' || COALESCE(p_case->>'case_number', ''), 'საქმის ნომერი: '),
        NULLIF('დავის საგანი: ' || COALESCE(p_case->>'dispute_subject', ''), 'დავის საგანი: '),
        NULLIF('სამართლებრივი ინსტიტუტი: ' || COALESCE(p_case->>'legal_institution', ''), 'სამართლებრივი ინსტიტუტი: '),
        NULLIF('შედეგი: ' || COALESCE(p_case->>'result', ''), 'შედეგი: '),
        NULLIF('საჩივრის ტიპი: ' || COALESCE(p_case->>'appeal_type', ''), 'საჩივრის ტიპი: '),
        NULLIF('პალატა: ' || COALESCE(p_case->>'court_branch', ''), 'პალატა: '),
        left(COALESCE(p_case->>'full_text', ''), 3000)
      ),
      '\s+',
      ' ',
      'g'
    ),
    6000
  );
$$;

DROP FUNCTION IF EXISTS public.get_cases_for_embedding(text, int);

CREATE OR REPLACE FUNCTION public.get_cases_for_embedding(
  p_source_table text,
  p_limit int DEFAULT 25
)
RETURNS TABLE (
  source_table text,
  source_id bigint,
  category text,
  case_number text,
  search_text text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category text;
  v_limit int;
BEGIN
  v_category := public.normalize_case_search_category(p_source_table);

  IF v_category IS NULL THEN
    RAISE EXCEPTION 'Unknown source table: %. Valid: administrative_cases, criminal_cases, civil_cases', p_source_table;
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

  RETURN QUERY EXECUTE format(
    $sql$
      WITH candidates AS (
        SELECT
          %L::text AS source_table,
          c.id::bigint AS source_id,
          %L::text AS category,
          (to_jsonb(c)->>'case_number')::text AS case_number,
          public.case_embedding_search_text(to_jsonb(c)) AS search_text
        FROM public.%I c
        WHERE
          COALESCE(to_jsonb(c)->>'full_text', '') <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM public.case_search_embeddings e
            WHERE e.source_table = %L
              AND e.source_id = c.id
          )
        ORDER BY c.id
        LIMIT %s
      )
      SELECT *
      FROM candidates
      WHERE length(trim(search_text)) > 20
    $sql$,
    p_source_table,
    v_category,
    p_source_table,
    p_source_table,
    v_limit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cases_for_embedding(text, int)
  TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.search_cases_vector(vector(1536), text, int);

CREATE OR REPLACE FUNCTION public.search_cases_vector(
  query_embedding vector(1536),
  p_category text DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id text,
  source_table text,
  category text,
  case_number text,
  decision_date text,
  dispute_subject text,
  result text,
  appeal_type text,
  full_text text,
  court_branch text,
  fullcase_url text,
  download_url text,
  semantic_score real,
  search_mode text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_category text;
BEGIN
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_category := NULLIF(trim(COALESCE(p_category, '')), '');

  RETURN QUERY
  WITH ranked AS (
    SELECT
      e.source_table,
      e.source_id,
      e.category,
      (1 - (e.embedding <=> query_embedding))::real AS semantic_score
    FROM public.case_search_embeddings e
    WHERE v_category IS NULL OR e.category = v_category
    ORDER BY e.embedding <=> query_embedding
    LIMIT v_limit
  ),
  unified AS (
    SELECT
      a.id::text AS id,
      r.source_table,
      r.category,
      a.case_number::text AS case_number,
      a.decision_date::text AS decision_date,
      a.dispute_subject::text AS dispute_subject,
      a.result::text AS result,
      a.appeal_type::text AS appeal_type,
      left(a.full_text, 3000)::text AS full_text,
      a.court_branch::text AS court_branch,
      a.fullcase_url::text AS fullcase_url,
      a.download_url::text AS download_url,
      r.semantic_score
    FROM ranked r
    JOIN public.administrative_cases a ON r.source_table = 'administrative_cases' AND a.id = r.source_id

    UNION ALL

    SELECT
      c.id::text AS id,
      r.source_table,
      r.category,
      c.case_number::text AS case_number,
      c.decision_date::text AS decision_date,
      NULL::text AS dispute_subject,
      c.result::text AS result,
      c.appeal_type::text AS appeal_type,
      left(c.full_text, 3000)::text AS full_text,
      c.court_branch::text AS court_branch,
      c.fullcase_url::text AS fullcase_url,
      c.download_url::text AS download_url,
      r.semantic_score
    FROM ranked r
    JOIN public.criminal_cases c ON r.source_table = 'criminal_cases' AND c.id = r.source_id

    UNION ALL

    SELECT
      cv.id::text AS id,
      r.source_table,
      r.category,
      cv.case_number::text AS case_number,
      cv.decision_date::text AS decision_date,
      cv.dispute_subject::text AS dispute_subject,
      cv.result::text AS result,
      cv.appeal_type::text AS appeal_type,
      left(cv.full_text, 3000)::text AS full_text,
      cv.court_branch::text AS court_branch,
      cv.fullcase_url::text AS fullcase_url,
      cv.download_url::text AS download_url,
      r.semantic_score
    FROM ranked r
    JOIN public.civil_cases cv ON r.source_table = 'civil_cases' AND cv.id = r.source_id
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
    'vector_search'::text AS search_mode
  FROM unified
  ORDER BY unified.semantic_score DESC
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_cases_vector(vector(1536), text, int)
  TO anon, authenticated, service_role;
