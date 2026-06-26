import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type LegalProfile = {
  // shared
  legal_institution?: unknown;
  dispute_subject?: unknown;
  legal_articles?: unknown;
  must_match_terms?: unknown;
  exclude_terms?: unknown;
  strict_keywords?: unknown;
  broad_keywords?: unknown;
  keywords?: unknown;
  search_query?: unknown;
  // administrative-specific
  special_law?: unknown;
  administrative_body?: unknown;
  // civil-specific (GPT may populate these in future)
  contract_type?: unknown;
  property_type?: unknown;
  family_relation?: unknown;
  inheritance?: unknown;
  obligation?: unknown;
  ownership?: unknown;
  mortgage?: unknown;
  damages?: unknown;
  company_dispute?: unknown;
  labor_dispute?: unknown;
  bankruptcy?: unknown;
};

type SearchPayload = {
  category?: unknown;
  aiResult?: LegalProfile;
  legalProfile?: LegalProfile;
  uploadedDocumentText?: unknown;
  limit?: unknown;
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function asTextArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of raw) {
    const text = asText(item)
      .replace(/[^\u10A0-\u10FFa-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length <= 2) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(text);
  }

  return out;
}

function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.trunc(parsed), 1), 30);
}

function normalizeCategory(value: unknown): string {
  const category = asText(value);
  if (category === "ადმინისტრაციული" || category === "administrative") return "ადმინისტრაციული";
  if (category === "სამოქალაქო" || category === "civil") return "სამოქალაქო";
  if (category === "სისხლი" || category === "სისხლის" || category === "criminal") return "სისხლი";
  return category;
}

function pickProfile(payload: SearchPayload): LegalProfile {
  return payload.aiResult && typeof payload.aiResult === "object"
    ? payload.aiResult
    : payload.legalProfile && typeof payload.legalProfile === "object"
      ? payload.legalProfile
      : {};
}

function isGenericAdministrativeProfile(profile: LegalProfile): boolean {
  const text = [
    asText(profile.legal_institution),
    asText(profile.dispute_subject),
    ...asTextArray(profile.strict_keywords),
    ...asTextArray(profile.must_match_terms),
  ].join(" ").toLowerCase();

  if (!text) return false;

  return [
    "ადმინისტრაციული სამართალი",
    "ადმინისტრაციული აქტი",
    "ადმინისტრაციული აქტების ბათილად",
    "ადმინისტრაციულ სამართლებრივი აქტის ბათილად",
    "ინდივიდუალური ადმინისტრაციულ სამართლებრივი აქტის ბათილად",
  ].some(term => text.includes(term));
}

function extractDocumentSearchTerms(documentText: unknown): string[] {
  const text = asText(documentText).toLowerCase();
  if (!text) return [];

  const candidates = [
    "სამშენებლო სამართალდარღვევა",
    "სამშენებლო სამართალდარღვევის საქმეზე",
    "მშენებლობის ნებართვის გარეშე",
    "მუნიციპალური ინსპექცია",
    "თბილისის მუნიციპალიტეტის მუნიციპალური ინსპექცია",
    "თბილისის მუნიციპალიტეტის მერია",
    "შემოწმების აქტი",
    "მითითება",
    "დადგენილება სამშენებლო სამართალდარღვევის საქმეზე",
    "არქიტექტურისა და ქალაქმშენებლობის",
    "დაშენებითი სამუშაოები",
    "ფალიაშვილის",
    "საცხოვრებელი კორპუსი",
  ];

  return candidates.filter(term => text.includes(term.toLowerCase())).slice(0, 8);
}

function buildCriminalRpcParams(profile: LegalProfile, limit: number) {
  const strict = asTextArray([
    ...asTextArray(profile.strict_keywords),
    ...asTextArray(profile.must_match_terms),
    asText(profile.legal_institution),
    asText(profile.dispute_subject),
    ...asTextArray(profile.legal_articles),
  ]).slice(0, 12);

  const broad = asTextArray([
    ...asTextArray(profile.broad_keywords),
    ...asTextArray(profile.keywords),
    asText(profile.search_query),
  ]).slice(0, 10);

  return {
    p_strict_keywords:   strict,
    p_broad_keywords:    broad,
    p_dispute_subject:   asText(profile.dispute_subject)   || null,
    p_legal_institution: asText(profile.legal_institution) || null,
    p_must_match_terms:  asTextArray(profile.must_match_terms).slice(0, 8),
    p_exclude_terms:     asTextArray(profile.exclude_terms).slice(0, 10),
    p_legal_articles:    asTextArray(profile.legal_articles).slice(0, 10),
    p_limit:             limit,
  };
}

function buildCivilRpcParams(profile: LegalProfile, limit: number) {
  // Civil-specific fields contribute to keyword pools.
  // Currently GPT doesn't extract these yet — structured here for future extension.
  const civilStrict = asTextArray([
    asText(profile.contract_type),
    asText(profile.property_type),
    asText(profile.obligation),
    asText(profile.ownership),
    asText(profile.mortgage),
  ]);

  const civilBroad = asTextArray([
    asText(profile.family_relation),
    asText(profile.inheritance),
    asText(profile.damages),
    asText(profile.company_dispute),
    asText(profile.labor_dispute),
    asText(profile.bankruptcy),
  ]);

  const strict = asTextArray([
    ...asTextArray(profile.strict_keywords),
    ...asTextArray(profile.must_match_terms),
    asText(profile.legal_institution),
    asText(profile.dispute_subject),
    ...asTextArray(profile.legal_articles),
    ...civilStrict,
  ]).slice(0, 12);

  const broad = asTextArray([
    ...asTextArray(profile.broad_keywords),
    ...asTextArray(profile.keywords),
    asText(profile.search_query),
    ...civilBroad,
  ]).slice(0, 10);

  return {
    p_strict_keywords:   strict,
    p_broad_keywords:    broad,
    p_dispute_subject:   asText(profile.dispute_subject)   || null,
    p_legal_institution: asText(profile.legal_institution) || null,
    p_must_match_terms:  asTextArray(profile.must_match_terms).slice(0, 8),
    p_exclude_terms:     asTextArray(profile.exclude_terms).slice(0, 10),
    p_legal_articles:    asTextArray(profile.legal_articles).slice(0, 10),
    p_limit:             limit,
  };
}

function buildAdministrativeRpcParams(profile: LegalProfile, limit: number, documentText: unknown) {
  const genericProfile = isGenericAdministrativeProfile(profile);
  const documentTerms = extractDocumentSearchTerms(documentText);

  const strictSeed = genericProfile && documentTerms.length > 0
    ? [
        ...documentTerms,
        ...asTextArray(profile.strict_keywords),
        ...asTextArray(profile.must_match_terms),
      ]
    : [
        ...asTextArray(profile.strict_keywords),
        ...asTextArray(profile.must_match_terms),
        asText(profile.legal_institution),
        asText(profile.dispute_subject),
        asText(profile.administrative_body),
        asText(profile.special_law),
        ...asTextArray(profile.legal_articles),
      ];

  const strict = asTextArray(strictSeed).slice(0, 12);

  const broad = asTextArray([
    ...documentTerms,
    ...asTextArray(profile.broad_keywords),
    ...asTextArray(profile.keywords),
    asText(profile.search_query),
  ]).slice(0, 10);

  return {
    p_legal_institution: genericProfile ? null : (asText(profile.legal_institution) || null),
    p_dispute_subject: genericProfile && documentTerms.length > 0
      ? documentTerms[0]
      : (asText(profile.dispute_subject) || null),
    p_special_law: asText(profile.special_law) || null,
    p_legal_articles: asTextArray(profile.legal_articles).slice(0, 10),
    p_administrative_body: asText(profile.administrative_body) || null,
    p_must_match_terms: genericProfile ? [] : asTextArray(profile.must_match_terms).slice(0, 8),
    p_exclude_terms: asTextArray(profile.exclude_terms).slice(0, 10),
    p_strict_keywords: strict,
    p_broad_keywords: broad,
    p_limit: limit,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResp({ error: "Only POST is supported." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseKey = serviceKey || anonKey;

    if (!supabaseUrl || !supabaseKey) {
      return jsonResp({ error: "Supabase environment variables are not configured." }, 500);
    }

    let payload: SearchPayload;
    try {
      payload = await req.json();
    } catch {
      return jsonResp({ error: "მოთხოვნის ფორმატი არასწორია." }, 400);
    }

    const category = normalizeCategory(payload.category);
    const limit = clampLimit(payload.limit);
    const profile = pickProfile(payload);

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") || `Bearer ${supabaseKey}`,
        },
      },
    });

    // ── სამოქალაქო საქმეები ──────────────────────────────────────────
    if (category === "სამოქალაქო") {
      const civilRpcParams = buildCivilRpcParams(profile, limit);

      if (
        civilRpcParams.p_strict_keywords.length === 0 &&
        civilRpcParams.p_broad_keywords.length === 0 &&
        !civilRpcParams.p_dispute_subject &&
        !civilRpcParams.p_legal_institution
      ) {
        return jsonResp({
          results: [],
          count: 0,
          searchMode: "empty_legal_profile",
          message: "ძებნისთვის საკმარისი ინფორმაცია ვერ მოიძებნა.",
        });
      }

      const { data: civilData, error: civilError } = await supabase.rpc(
        "search_civil_cases_hybrid",
        civilRpcParams,
      );

      if (civilError) {
        console.error("search_civil_cases_hybrid error:", civilError);
        return jsonResp({ error: "სამოქალაქო საქმეების ძებნა ვერ შესრულდა.", details: civilError.message }, 500);
      }

      const civilRows = Array.isArray(civilData) ? civilData : [];
      const civilMaxScore = civilRows.reduce(
        (max, row) => Math.max(max, Number(row.final_score) || 0),
        0,
      );

      const civilResults = civilRows.map((row, index) => {
        const finalScore = Number(row.final_score) || 0;
        return {
          id:              row.id,
          case_number:     row.case_number,
          decision_date:   row.decision_date,
          dispute_subject: row.dispute_subject,
          result:          row.result,
          appeal_type:     row.appeal_type,
          full_text:       row.full_text,
          court_branch:    row.court_branch,
          fullcase_url:    row.fullcase_url,
          download_url:    row.download_url,
          ts_rank:         row.ts_rank,
          final_score:     finalScore,
          score:           civilMaxScore > 0 ? Math.max(1, Math.round((finalScore / civilMaxScore) * 100)) : null,
          search_mode:     row.search_mode || "fts_civil_hybrid",
          rank_position:   index + 1,
        };
      });

      return jsonResp({
        results: civilResults,
        count: civilResults.length,
        searchMode: civilResults[0]?.search_mode || "fts_civil_hybrid",
        message: civilResults.length > 0 ? null : "სამოქალაქო საქმე ვერ მოიძებნა.",
      });
    }

    // ── სისხლის სამართლის საქმეები ──────────────────────────────────
    if (category === "სისხლი") {
      const crimRpcParams = buildCriminalRpcParams(profile, limit);

      if (
        crimRpcParams.p_strict_keywords.length === 0 &&
        crimRpcParams.p_broad_keywords.length === 0 &&
        !crimRpcParams.p_dispute_subject &&
        !crimRpcParams.p_legal_institution
      ) {
        return jsonResp({
          results: [],
          count: 0,
          searchMode: "empty_legal_profile",
          message: "ძებნისთვის საკმარისი ინფორმაცია ვერ მოიძებნა.",
        });
      }

      const { data: crimData, error: crimError } = await supabase.rpc(
        "search_criminal_cases_hybrid",
        crimRpcParams,
      );

      if (crimError) {
        console.error("search_criminal_cases_hybrid error:", crimError);
        return jsonResp({ error: "სისხლის საქმეების ძებნა ვერ შესრულდა.", details: crimError.message }, 500);
      }

      const crimRows = Array.isArray(crimData) ? crimData : [];
      const crimMaxScore = crimRows.reduce(
        (max, row) => Math.max(max, Number(row.final_score) || 0),
        0,
      );

      const crimResults = crimRows.map((row, index) => {
        const finalScore = Number(row.final_score) || 0;
        return {
          id:            row.id,
          case_number:   row.case_number,
          decision_date: row.decision_date,
          result:        row.result,
          appeal_type:   row.appeal_type,
          full_text:     row.full_text,
          court_branch:  row.court_branch,
          fullcase_url:  row.fullcase_url,
          download_url:  row.download_url,
          ts_rank:       row.ts_rank,
          final_score:   finalScore,
          score:         crimMaxScore > 0 ? Math.max(1, Math.round((finalScore / crimMaxScore) * 100)) : null,
          search_mode:   row.search_mode || "fts_criminal_hybrid",
          rank_position: index + 1,
        };
      });

      return jsonResp({
        results: crimResults,
        count: crimResults.length,
        searchMode: crimResults[0]?.search_mode || "fts_criminal_hybrid",
        message: crimResults.length > 0 ? null : "სისხლის სამართლის საქმე ვერ მოიძებნა.",
      });
    }

    // ── ადმინისტრაციული საქმეები ──────────────────────────────────────
    if (category !== "ადმინისტრაციული") {
      return jsonResp({
        results: [],
        count: 0,
        searchMode: "unsupported_category",
        message: "ამ ეტაპზე backend search ჩართულია ადმინისტრაციული, სისხლის და სამოქალაქო კატეგორიისთვის.",
      });
    }

    const rpcParams = buildAdministrativeRpcParams(profile, limit, payload.uploadedDocumentText);

    if (
      !rpcParams.p_legal_institution &&
      !rpcParams.p_dispute_subject &&
      rpcParams.p_strict_keywords.length === 0 &&
      rpcParams.p_broad_keywords.length === 0
    ) {
      return jsonResp({
        results: [],
        count: 0,
        searchMode: "empty_legal_profile",
        message: "ზუსტი სამართლებრივი ინსტიტუტით შედეგი ვერ მოიძებნა.",
        debug: { rpcParams },
      });
    }

    const { data, error } = await supabase.rpc("search_administrative_cases_hybrid", rpcParams);

    if (error) {
      console.error("search_administrative_cases_hybrid error:", error);
      return jsonResp({
        error: "ძებნის სერვისმა შეცდომა დააბრუნა.",
        details: error.message,
      }, 500);
    }

    const rows = Array.isArray(data) ? data : [];
    const maxScore = rows.reduce((max, row) => Math.max(max, Number(row.final_score) || 0), 0);

    const results = rows.map((row, index) => {
      const finalScore = Number(row.final_score) || 0;
      return {
        id: row.id,
        case_number: row.case_number,
        decision_date: row.decision_date,
        dispute_subject: row.dispute_subject,
        result: row.result,
        appeal_type: row.appeal_type,
        fullcase_url: row.fullcase_url,
        download_url: row.download_url,
        full_text: row.full_text,
        court_branch: row.court_branch,
        legal_institution: row.legal_institution,
        administrative_body: row.administrative_body,
        special_law: row.special_law,
        ts_rank: row.ts_rank,
        final_score: finalScore,
        score: maxScore > 0 ? Math.max(1, Math.round((finalScore / maxScore) * 100)) : null,
        search_mode: row.search_mode || "fts_legal_profile",
        rank_position: index + 1,
      };
    });

    return jsonResp({
      results,
      count: results.length,
      searchMode: results[0]?.search_mode || "fts_legal_profile",
      message: results.length > 0
        ? null
        : "ზუსტი სამართლებრივი ინსტიტუტით შედეგი ვერ მოიძებნა.",
    });
  } catch (err) {
    console.error("search-legal-cases unhandled error:", err);
    return jsonResp({ error: "სერვერზე შეცდომა დაფიქსირდა. სცადეთ მოგვიანებით." }, 500);
  }
});
