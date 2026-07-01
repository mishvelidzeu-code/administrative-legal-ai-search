-- Fix: get_cases_for_embedding — legal_institution column does not exist
-- on any of the three case tables; it lives only in case_legal_profiles.
-- All three branches now return NULL::text for legal_institution.

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
    RAISE EXCEPTION 'Unknown source table: %', p_source_table;
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
      NULL::text,
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
      NULL::text,
      NULL::text,
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
      NULL::text,
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
