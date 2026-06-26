-- ============================================================
-- Copy this ENTIRE file and paste into Supabase SQL Editor.
-- Run as one block.
-- ============================================================

-- Step 1: GIN index
CREATE INDEX IF NOT EXISTS idx_adm_cases_search_vector
  ON public.administrative_cases USING GIN (search_vector);

-- Step 2: Drop old version if exists, then create RPC function
DROP FUNCTION IF EXISTS search_administrative_cases(TEXT, INT);

CREATE FUNCTION search_administrative_cases(
  query_text   TEXT,
  limit_count  INT DEFAULT 100
)
RETURNS TABLE (
  id               TEXT,
  case_number      TEXT,
  decision_date    TEXT,
  dispute_subject  TEXT,
  result           TEXT,
  appeal_type      TEXT,
  fullcase_url     TEXT,
  download_url     TEXT,
  full_text        TEXT,
  court_branch     TEXT,
  ts_rank          REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q tsquery;
BEGIN
  IF query_text IS NULL OR trim(query_text) = '' THEN
    RETURN;
  END IF;

  BEGIN
    q := to_tsquery('simple', query_text);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'FTS parse error: %', query_text;
    RETURN;
  END;

  IF q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id::TEXT,
    a.case_number::TEXT,
    a.decision_date::TEXT,
    a.dispute_subject::TEXT,
    a.result::TEXT,
    a.appeal_type::TEXT,
    a.fullcase_url::TEXT,
    a.download_url::TEXT,
    left(a.full_text, 3000)::TEXT,
    a.court_branch::TEXT,
    ts_rank_cd(a.search_vector, q)::REAL
  FROM public.administrative_cases a
  WHERE a.search_vector @@ q
  ORDER BY ts_rank_cd(a.search_vector, q) DESC
  LIMIT limit_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_administrative_cases(TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION search_administrative_cases(TEXT, INT) TO anon;


-- Verify: run this separately after the above succeeds:
-- SELECT id, dispute_subject, ts_rank
-- FROM search_administrative_cases('თანამემა:*', 5);
