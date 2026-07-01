-- Restore chunk-aware vector search.
-- The previous fix rewrote the function as LANGUAGE sql, but removed the
-- chunk deduplication/oversampling needed after one case started producing
-- multiple embedding chunks.

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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) AS v_limit,
      NULLIF(trim(COALESCE(p_category, '')), '') AS v_category
  ),
  nearest_chunks AS (
    SELECT
      e.source_table AS e_source_table,
      e.source_id,
      e.category AS e_category,
      (1 - (e.embedding <=> query_embedding))::real AS semantic_score,
      ROW_NUMBER() OVER (
        PARTITION BY e.source_table, e.source_id
        ORDER BY e.embedding <=> query_embedding
      ) AS rn
    FROM public.case_search_embeddings e
    CROSS JOIN params p
    WHERE p.v_category IS NULL OR e.category = p.v_category
    ORDER BY e.embedding <=> query_embedding
    LIMIT (SELECT v_limit * 8 FROM params)
  ),
  ranked AS (
    SELECT
      e_source_table,
      source_id,
      e_category,
      semantic_score
    FROM nearest_chunks
    WHERE rn = 1
      AND semantic_score >= 0.30
    ORDER BY semantic_score DESC
    LIMIT (SELECT v_limit FROM params)
  ),
  unified AS (
    SELECT
      a.id::text AS id,
      r.e_source_table AS source_table,
      r.e_category AS category,
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
    JOIN public.administrative_cases a
      ON r.e_source_table = 'administrative_cases' AND a.id = r.source_id

    UNION ALL

    SELECT
      c.id::text,
      r.e_source_table,
      r.e_category,
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
      ON r.e_source_table = 'criminal_cases' AND c.id = r.source_id

    UNION ALL

    SELECT
      cv.id::text,
      r.e_source_table,
      r.e_category,
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
      ON r.e_source_table = 'civil_cases' AND cv.id = r.source_id
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
    'vector_search_chunked'::text AS search_mode
  FROM unified
  ORDER BY unified.semantic_score DESC
  LIMIT (SELECT v_limit FROM params);
$$;

GRANT EXECUTE ON FUNCTION public.search_cases_vector(vector(1536), text, int)
  TO anon, authenticated, service_role;
