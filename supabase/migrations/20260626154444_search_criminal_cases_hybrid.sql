-- სისხლის სამართლის საქმეების hybrid search RPC
-- გაუშვი Supabase > SQL Editor-ში (ძველ ვერსიას გადაწერს)

-- GIN index search_vector-ზე (safe თუ უკვე არსებობს)
CREATE INDEX IF NOT EXISTS criminal_cases_search_vector_idx
  ON criminal_cases USING GIN (search_vector);

-- DROP ვდებთ რათა ძველი ვარიანტი წაიშალოს სანამ ხელახლა შეიქმნება
DROP FUNCTION IF EXISTS search_criminal_cases_hybrid(text[],text[],text,text,text[],text[],text[],int);

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
  v_query_text text;
  v_tsquery    tsquery;
BEGIN
  -- ყველა keyword-ი ერთ სტრიქონში
  v_query_text := array_to_string(
    ARRAY(
      SELECT kw FROM unnest(p_strict_keywords || p_broad_keywords) AS kw
      WHERE kw IS NOT NULL AND length(trim(kw)) > 2
    ),
    ' '
  );

  -- Fallback: dispute_subject ან legal_institution
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

  RETURN QUERY
  SELECT
    c.id                                             AS id,
    c.case_number::text                              AS case_number,
    c.decision_date::text                            AS decision_date,
    c.result::text                                   AS result,
    c.appeal_type::text                              AS appeal_type,
    c.full_text::text                                AS full_text,
    c.court_branch::text                             AS court_branch,
    c.fullcase_url::text                             AS fullcase_url,
    c.download_url::text                             AS download_url,
    COALESCE(ts_rank(c.search_vector, v_tsquery), 0)::float4   AS ts_rank,
    COALESCE(ts_rank(c.search_vector, v_tsquery), 0)::float4   AS final_score,
    'fts_criminal_hybrid'::text                      AS search_mode
  FROM criminal_cases c
  WHERE
    c.search_vector @@ v_tsquery
    AND (
      cardinality(p_exclude_terms) = 0
      OR NOT EXISTS (
        SELECT 1 FROM unnest(p_exclude_terms) ex
        WHERE length(trim(ex)) > 2 AND c.full_text ILIKE '%' || ex || '%'
      )
    )
  ORDER BY ts_rank(c.search_vector, v_tsquery) DESC
  LIMIT p_limit;
END;
$$;
