-- ════════════════════════════════════════════════════════════════════════
-- civil_cases hybrid search migration
-- გაუშვი: Supabase Dashboard → SQL Editor
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. search_vector — GENERATED ALWAYS AS column ──────────────────────
-- civil_cases.search_vector არის GENERATED ALWAYS AS სვეტი.
-- PostgreSQL თვითონ ავსებს — UPDATE საჭირო არ არის.

-- ─── 2. GIN index ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS civil_cases_search_vector_idx
  ON civil_cases USING GIN (search_vector);

-- ─── 3. search_civil_cases_hybrid ────────────────────────────────────────
DROP FUNCTION IF EXISTS search_civil_cases_hybrid(text[],text[],text,text,text[],text[],text[],int);

CREATE OR REPLACE FUNCTION search_civil_cases_hybrid(
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
  id              bigint,
  case_number     text,
  decision_date   text,
  dispute_subject text,
  result          text,
  appeal_type     text,
  full_text       text,
  court_branch    text,
  fullcase_url    text,
  download_url    text,
  ts_rank         float4,
  final_score     float4,
  search_mode     text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_query_text text;
  v_tsquery    tsquery;
BEGIN
  -- Build combined keyword string from all keyword arrays
  v_query_text := array_to_string(
    ARRAY(
      SELECT kw
      FROM unnest(
        p_strict_keywords || p_broad_keywords || p_must_match_terms
      ) AS kw
      WHERE kw IS NOT NULL AND length(trim(kw)) > 2
    ),
    ' '
  );

  -- Fallback: dispute_subject, then legal_institution
  IF coalesce(trim(v_query_text), '') = '' THEN
    v_query_text := coalesce(
      CASE WHEN length(trim(coalesce(p_dispute_subject,''))) > 2 THEN p_dispute_subject END,
      CASE WHEN length(trim(coalesce(p_legal_institution,''))) > 2 THEN p_legal_institution END,
      ''
    );
  END IF;

  IF trim(v_query_text) = '' THEN
    RETURN;
  END IF;

  v_tsquery := plainto_tsquery('simple', v_query_text);

  -- CTE: compute fts_rank once, add dispute_subject bonus
  -- civil_cases-ს dispute_subject სვეტი აქვს (criminal-ისგან განსხვავებით)
  -- ამიტომ subject match ავამაღლებთ ranking-ში
  RETURN QUERY
  WITH base AS (
    SELECT
      c.id::bigint                                             AS id,
      c.case_number::text                                      AS case_number,
      c.decision_date::text                                    AS decision_date,
      c.dispute_subject::text                                  AS dispute_subject,
      c.result::text                                           AS result,
      c.appeal_type::text                                      AS appeal_type,
      c.full_text::text                                        AS full_text,
      c.court_branch::text                                     AS court_branch,
      c.fullcase_url::text                                     AS fullcase_url,
      c.download_url::text                                     AS download_url,
      COALESCE(ts_rank(c.search_vector, v_tsquery), 0)::float4 AS fts_rank,
      CASE
        WHEN p_dispute_subject IS NOT NULL
          AND length(trim(p_dispute_subject)) > 2
          AND c.dispute_subject ILIKE '%' || p_dispute_subject || '%'
        THEN 0.25::float4
        ELSE 0::float4
      END                                                      AS subject_bonus
    FROM civil_cases c
    WHERE
      c.search_vector @@ v_tsquery
      AND (
        cardinality(p_exclude_terms) = 0
        OR NOT EXISTS (
          SELECT 1 FROM unnest(p_exclude_terms) ex
          WHERE length(trim(ex)) > 2
            AND c.full_text ILIKE '%' || ex || '%'
        )
      )
  )
  SELECT
    base.id, base.case_number, base.decision_date, base.dispute_subject, base.result,
    base.appeal_type, base.full_text, base.court_branch, base.fullcase_url, base.download_url,
    base.fts_rank                                         AS ts_rank,
    (base.fts_rank * 0.75 + base.subject_bonus)::float4  AS final_score,
    'fts_civil_hybrid'::text                              AS search_mode
  FROM base
  ORDER BY (base.fts_rank * 0.75 + base.subject_bonus) DESC
  LIMIT p_limit;
END;
$$;
