-- სისხლის სამართლის საქმეების hybrid search RPC
-- გაუშვი Supabase > SQL Editor-ში

-- GIN index search_vector-ზე (თუ უკვე არ არის)
CREATE INDEX IF NOT EXISTS criminal_cases_search_vector_idx
  ON criminal_cases USING GIN (search_vector);

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
AS $$
DECLARE
  v_tsquery tsquery;
  v_kw      text;
BEGIN
  -- Build tsquery from all keywords
  v_tsquery := NULL;
  FOREACH v_kw IN ARRAY (p_strict_keywords || p_broad_keywords) LOOP
    CONTINUE WHEN v_kw IS NULL OR length(trim(v_kw)) <= 2;
    BEGIN
      IF v_tsquery IS NULL THEN
        v_tsquery := plainto_tsquery('simple', v_kw);
      ELSE
        v_tsquery := v_tsquery || plainto_tsquery('simple', v_kw);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  -- Fallback: p_dispute_subject / p_legal_institution as query
  IF v_tsquery IS NULL THEN
    IF p_dispute_subject IS NOT NULL AND length(trim(p_dispute_subject)) > 2 THEN
      v_tsquery := plainto_tsquery('simple', p_dispute_subject);
    ELSIF p_legal_institution IS NOT NULL AND length(trim(p_legal_institution)) > 2 THEN
      v_tsquery := plainto_tsquery('simple', p_legal_institution);
    ELSE
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      c.id,
      c.case_number,
      c.decision_date::text  AS decision_date,
      c.result,
      c.appeal_type,
      c.full_text,
      c.court_branch,
      c.fullcase_url,
      c.download_url,
      COALESCE(ts_rank(c.search_vector, v_tsquery), 0)::float4 AS base_rank
    FROM criminal_cases c
    WHERE
      c.search_vector @@ v_tsquery
      AND NOT (
        cardinality(p_exclude_terms) > 0
        AND EXISTS (
          SELECT 1 FROM unnest(p_exclude_terms) ex(term)
          WHERE length(trim(ex.term)) > 2
            AND c.full_text ILIKE '%' || ex.term || '%'
        )
      )
  ),
  scored AS (
    SELECT
      ca.*,
      -- strict keyword hits in full_text
      (
        SELECT COUNT(*)::float4
        FROM unnest(p_strict_keywords) sk(kw)
        WHERE length(trim(sk.kw)) > 2
          AND ca.full_text ILIKE '%' || sk.kw || '%'
      ) AS strict_hits,
      -- must_match satisfaction ratio
      CASE
        WHEN cardinality(p_must_match_terms) = 0 THEN 1.0::float4
        ELSE (
          SELECT COUNT(*)::float4
          FROM unnest(p_must_match_terms) m(term)
          WHERE length(trim(m.term)) > 2
            AND ca.full_text ILIKE '%' || m.term || '%'
        ) / GREATEST(cardinality(p_must_match_terms)::float4, 1)
      END AS must_ratio,
      -- dispute_subject / legal context match bonus (searched in full_text)
      CASE
        WHEN p_dispute_subject IS NOT NULL
          AND length(trim(p_dispute_subject)) > 2
          AND ca.full_text ILIKE '%' || p_dispute_subject || '%'
        THEN 2.0 ELSE 0.0
      END::float4 AS subject_bonus,
      CASE
        WHEN p_legal_institution IS NOT NULL
          AND length(trim(p_legal_institution)) > 2
          AND ca.full_text ILIKE '%' || p_legal_institution || '%'
        THEN 1.5 ELSE 0.0
      END::float4 AS institution_bonus
    FROM candidates ca
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
    s.base_rank AS ts_rank,
    (s.base_rank * 10.0
      + s.strict_hits    * 3.0
      + s.must_ratio     * 5.0
      + s.subject_bonus
      + s.institution_bonus
    )::float4 AS final_score,
    'fts_criminal_hybrid'::text AS search_mode
  FROM scored s
  WHERE cardinality(p_must_match_terms) = 0 OR s.must_ratio >= 0.5
  ORDER BY final_score DESC
  LIMIT p_limit;
END;
$$;
