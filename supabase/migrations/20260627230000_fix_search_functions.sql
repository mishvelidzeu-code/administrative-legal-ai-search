-- Fix 1: search_criminal_cases_hybrid — remove ILIKE from WHERE (caused full table scan timeout)
-- Fix 2: search_cases_vector — rewrite as LANGUAGE sql to fix "source_table ambiguous" bug

-- =====================================================================
-- FIX 1: criminal hybrid — GIN index only in WHERE, no ILIKE scan
-- =====================================================================
DROP FUNCTION IF EXISTS search_criminal_cases_hybrid(text[], text[], text, text, text[], text[], text[], int);

CREATE OR REPLACE FUNCTION search_criminal_cases_hybrid(
  p_strict_keywords   text[]  DEFAULT '{}',
  p_broad_keywords    text[]  DEFAULT '{}',
  p_dispute_subject   text    DEFAULT NULL,
  p_legal_institution text    DEFAULT NULL,
  p_must_match_terms  text[]  DEFAULT '{}',
  p_exclude_terms     text[]  DEFAULT '{}',
  p_legal_articles    text[]  DEFAULT '{}',
  p_limit             int     DEFAULT 10
)
RETURNS TABLE (
  id            bigint,
  case_number   text,
  decision_date text,
  result        text,
  appeal_type   text,
  full_text     text,
  court_branch  text,
  fullcase_url  text,
  download_url  text,
  ts_rank       float4,
  final_score   float4,
  search_mode   text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int;
BEGIN
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  RETURN QUERY
  WITH raw_terms AS (
    SELECT unnest(
      COALESCE(p_strict_keywords, '{}') ||
      COALESCE(p_must_match_terms, '{}') ||
      COALESCE(p_legal_articles, '{}') ||
      COALESCE(p_broad_keywords, '{}') ||
      ARRAY[
        COALESCE(p_dispute_subject, ''),
        COALESCE(p_legal_institution, '')
      ]
    ) AS term
  ),
  terms AS (
    SELECT DISTINCT trim(term) AS term
    FROM raw_terms
    WHERE length(trim(term)) > 2
      AND lower(trim(term)) NOT IN (
        'სისხლი', 'სისხლის', 'სისხლის სამართალი',
        'სისხლის სამართლის საქმე', 'საქართველოს სისხლის სამართლის კოდექსი'
      )
  ),
  article_terms AS (
    SELECT DISTINCT m[1] AS term
    FROM raw_terms,
      regexp_matches(term, '[0-9]{2,4}', 'g') AS m
  ),
  all_terms AS (
    SELECT term FROM terms
    UNION
    SELECT term FROM article_terms WHERE length(term) > 1
  ),
  scored AS (
    SELECT
      c.id,
      c.case_number::text,
      c.decision_date::text,
      c.result::text,
      c.appeal_type::text,
      c.full_text::text,
      c.court_branch::text,
      c.fullcase_url::text,
      c.download_url::text,
      COALESCE(
        SUM(ts_rank(c.search_vector, plainto_tsquery('simple', t.term))),
        0
      )::float4 AS score
    FROM public.criminal_cases c
    CROSS JOIN all_terms t
    WHERE c.search_vector @@ plainto_tsquery('simple', t.term)
      AND (
        cardinality(COALESCE(p_exclude_terms, '{}')) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM unnest(p_exclude_terms) ex
          WHERE length(trim(ex)) > 2
            AND c.search_vector @@ plainto_tsquery('simple', trim(ex))
        )
      )
    GROUP BY
      c.id, c.case_number, c.decision_date, c.result,
      c.appeal_type, c.full_text, c.court_branch, c.fullcase_url, c.download_url
  )
  SELECT
    s.id,
    s.case_number,
    s.decision_date,
    s.result,
    s.appeal_type,
    s.full_text,
    s.court_branch,
    s.fullcase_url,
    s.download_url,
    s.score AS ts_rank,
    s.score AS final_score,
    'fts_criminal'::text AS search_mode
  FROM scored s
  WHERE s.score > 0
  ORDER BY s.score DESC, s.decision_date DESC NULLS LAST
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_criminal_cases_hybrid(text[], text[], text, text, text[], text[], text[], int)
  TO anon, authenticated, service_role;


-- =====================================================================
-- FIX 2: search_cases_vector — rewrite as LANGUAGE sql (no plpgsql
--         variable scope, eliminates "source_table ambiguous" error)
-- =====================================================================
DROP FUNCTION IF EXISTS public.search_cases_vector(vector(1536), text, int);

CREATE OR REPLACE FUNCTION public.search_cases_vector(
  query_embedding vector(1536),
  p_category      text DEFAULT NULL,
  p_limit         int  DEFAULT 20
)
RETURNS TABLE (
  id             text,
  source_table   text,
  category       text,
  case_number    text,
  decision_date  text,
  dispute_subject text,
  result         text,
  appeal_type    text,
  full_text      text,
  court_branch   text,
  fullcase_url   text,
  download_url   text,
  semantic_score real,
  search_mode    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      e.source_table  AS e_source_table,
      e.source_id,
      e.category      AS e_category,
      (1 - (e.embedding <=> query_embedding))::real AS semantic_score
    FROM public.case_search_embeddings e
    WHERE NULLIF(trim(COALESCE(p_category, '')), '') IS NULL
       OR e.category = NULLIF(trim(COALESCE(p_category, '')), '')
    ORDER BY e.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
  ),
  unified AS (
    SELECT
      a.id::text                      AS id,
      r.e_source_table                AS source_table,
      r.e_category                    AS category,
      a.case_number::text             AS case_number,
      a.decision_date::text           AS decision_date,
      a.dispute_subject::text         AS dispute_subject,
      a.result::text                  AS result,
      a.appeal_type::text             AS appeal_type,
      left(a.full_text, 3000)::text   AS full_text,
      a.court_branch::text            AS court_branch,
      a.fullcase_url::text            AS fullcase_url,
      a.download_url::text            AS download_url,
      r.semantic_score
    FROM ranked r
    JOIN public.administrative_cases a
      ON r.e_source_table = 'administrative_cases' AND a.id = r.source_id

    UNION ALL

    SELECT
      c.id::text, r.e_source_table, r.e_category,
      c.case_number::text, c.decision_date::text,
      NULL::text,
      c.result::text, c.appeal_type::text,
      left(c.full_text, 3000)::text,
      c.court_branch::text, c.fullcase_url::text, c.download_url::text,
      r.semantic_score
    FROM ranked r
    JOIN public.criminal_cases c
      ON r.e_source_table = 'criminal_cases' AND c.id = r.source_id

    UNION ALL

    SELECT
      cv.id::text, r.e_source_table, r.e_category,
      cv.case_number::text, cv.decision_date::text,
      cv.dispute_subject::text,
      cv.result::text, cv.appeal_type::text,
      left(cv.full_text, 3000)::text,
      cv.court_branch::text, cv.fullcase_url::text, cv.download_url::text,
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
    'vector_search'::text AS search_mode
  FROM unified
  ORDER BY unified.semantic_score DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

GRANT EXECUTE ON FUNCTION public.search_cases_vector(vector(1536), text, int)
  TO anon, authenticated, service_role;
