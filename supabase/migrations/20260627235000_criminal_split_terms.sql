-- Fix: split p_dispute_subject and p_legal_institution into individual words.
-- Previously the full phrase was one term, requiring ALL words in exact form (no stemming).
-- Now each word is a separate term → OR-style scoring, partial matches work.

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
    -- keywords as individual entries
    SELECT unnest(
      COALESCE(p_strict_keywords, '{}') ||
      COALESCE(p_must_match_terms, '{}') ||
      COALESCE(p_legal_articles, '{}') ||
      COALESCE(p_broad_keywords, '{}')
    ) AS term
    UNION ALL
    -- split dispute_subject and legal_institution into individual words
    SELECT unnest(string_to_array(COALESCE(p_dispute_subject, ''), ' '))
    UNION ALL
    SELECT unnest(string_to_array(COALESCE(p_legal_institution, ''), ' '))
  ),
  terms AS (
    SELECT DISTINCT trim(term) AS term
    FROM raw_terms
    WHERE length(trim(term)) > 2
      AND lower(trim(term)) NOT IN (
        'სისხლი', 'სისხლის', 'სისხლის სამართალი',
        'სისხლის სამართლის საქმე', 'საქართველოს სისხლის სამართლის კოდექსი',
        'სამართალი', 'საქმე', 'საქართველოს', 'საქართველო',
        'შესახებ', 'რომელიც', 'რომელი', 'რომლის', 'რომლებმა',
        'მიერ', 'მიმართ', 'მისი', 'მისთვის', 'მათ', 'მათი',
        'ასევე', 'კერძოდ', 'ზოგადად', 'საერთო', 'ყველა',
        'this', 'that', 'with', 'from', 'have', 'for', 'are', 'was'
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
