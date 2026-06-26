-- ════════════════════════════════════════════════════════════════════════
-- Phase 1: case_legal_profiles
-- გაუშვი: Supabase Dashboard → SQL Editor
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. processing_status — სამივე source table-ზე ──────────────────────
ALTER TABLE administrative_cases
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending';

ALTER TABLE criminal_cases
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending';

ALTER TABLE civil_cases
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending';

-- Partial indexes — მხოლოდ pending row-ები, batch query-სთვის სწრაფი
CREATE INDEX IF NOT EXISTS admin_cases_pending_idx
  ON administrative_cases (id) WHERE processing_status = 'pending';

CREATE INDEX IF NOT EXISTS crim_cases_pending_idx
  ON criminal_cases (id) WHERE processing_status = 'pending';

CREATE INDEX IF NOT EXISTS civil_cases_pending_idx
  ON civil_cases (id) WHERE processing_status = 'pending';

-- ─── 2. case_legal_profiles ──────────────────────────────────────────────
-- DROP: safe — ამ ეტაპზე real data არ არის ჯერ (Phase 1 migration)
DROP TABLE IF EXISTS case_legal_profiles;

CREATE TABLE case_legal_profiles (
  id              bigserial PRIMARY KEY,

  -- source reference
  source_table    text    NOT NULL,   -- 'administrative_cases'|'criminal_cases'|'civil_cases'
  source_id       bigint  NOT NULL,
  category        text    NOT NULL,   -- 'administrative'|'criminal'|'civil'
  case_number     text,
  decision_date   text,

  -- ── shared fields ───────────────────────────────────────────────────────
  legal_institution   text,
  dispute_subject     text,
  legal_issue         text,
  fact_pattern        text,
  legal_articles      text[]  DEFAULT '{}',
  keywords            text[]  DEFAULT '{}',
  outcome_type        text,   -- 'granted'|'denied'|'partial'|'remanded'|'unknown'
  procedural_stage    text,   -- 'საკასაციო'|'სააპელაციო'|'კერძო საჩივარი'|'არსებითი განხილვა'|'unknown'
  deciding_factor     text,
  court_position      text,
  case_summary        text,

  -- ── administrative-specific ─────────────────────────────────────────────
  administrative_body     text,
  administrative_act_type text,
  fine_type               text,
  procedure_violation     text,

  -- ── criminal-specific ───────────────────────────────────────────────────
  crime_type          text,
  criminal_article    text,
  criminal_part       text,
  intent_type         text,
  evidence_type       text,
  sentence_type       text,
  qualification_issue text,

  -- ── civil-specific ──────────────────────────────────────────────────────
  contract_type       text,
  property_type       text,
  family_relation     text,
  inheritance_issue   text,
  obligation_type     text,
  ownership_issue     text,
  damages_type        text,
  company_dispute     text,
  labor_dispute       text,
  bankruptcy_issue    text,

  -- ── metadata ────────────────────────────────────────────────────────────
  confidence      float4,
  processed_at    timestamptz DEFAULT now(),
  model_version   text        DEFAULT 'gpt-4o-mini',

  UNIQUE (source_table, source_id)
);

-- ─── 3. indexes ──────────────────────────────────────────────────────────
CREATE INDEX clp_source_idx
  ON case_legal_profiles (source_table, source_id);

CREATE INDEX clp_category_idx
  ON case_legal_profiles (category);

CREATE INDEX clp_institution_idx
  ON case_legal_profiles (legal_institution);

CREATE INDEX clp_outcome_idx
  ON case_legal_profiles (outcome_type);

CREATE INDEX clp_stage_idx
  ON case_legal_profiles (procedural_stage);

CREATE INDEX clp_articles_idx
  ON case_legal_profiles USING GIN (legal_articles);

CREATE INDEX clp_keywords_idx
  ON case_legal_profiles USING GIN (keywords);

-- ─── 4. verification ─────────────────────────────────────────────────────
-- გაუშვი migration-ის შემდეგ:
--
-- SELECT table_name, column_name
-- FROM information_schema.columns
-- WHERE table_name = 'case_legal_profiles'
-- ORDER BY ordinal_position;
--
-- SELECT COUNT(*) FROM administrative_cases WHERE processing_status = 'pending';
-- SELECT COUNT(*) FROM criminal_cases        WHERE processing_status = 'pending';
-- SELECT COUNT(*) FROM civil_cases           WHERE processing_status = 'pending';
