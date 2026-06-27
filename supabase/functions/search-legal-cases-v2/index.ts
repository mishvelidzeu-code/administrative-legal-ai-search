import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  asText,
  asTextArray,
  buildAdministrativeRpcParams,
  buildCivilRpcParams,
  buildCriminalRpcParams,
  clampLimit,
  normalizeCategory,
  pickProfile,
  type LegalProfile,
  type SearchPayload as SharedSearchPayload,
} from "../shared/legal-search/fts.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SearchPayload = SharedSearchPayload & {
  query?: unknown;
  search_query?: unknown;
  useSearchV2?: unknown;
  force_v2?: unknown;
};

type SearchRow = Record<string, unknown> & {
  id?: unknown;
  source_table?: unknown;
  category?: unknown;
  final_score?: unknown;
  ts_rank?: unknown;
  semantic_score?: unknown;
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function isEnabled(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

function normalizeCategoryForV2(value: unknown) {
  const category = normalizeCategory(value);
  if (category === "ადმინისტრაციული") {
    return { label: "ადმინისტრაციული", key: "administrative", table: "administrative_cases" };
  }
  if (category === "სამოქალაქო") {
    return { label: "სამოქალაქო", key: "civil", table: "civil_cases" };
  }
  if (category === "სისხლი") {
    return { label: "სისხლი", key: "criminal", table: "criminal_cases" };
  }
  return { label: category, key: category, table: "" };
}

function buildQueryText(payload: SearchPayload, profile: LegalProfile): string {
  const terms = [
    asText(payload.query),
    asText(payload.search_query),
    asText(profile.search_query),
    asText(profile.legal_institution),
    asText(profile.dispute_subject),
    asText(profile.result),
    asText(profile.outcome_type),
    asText(profile.appeal_type),
    asText(profile.court_branch),
    asText(profile.contract_type),
    asText(profile.property_type),
    asText(profile.crime_type),
    asText(profile.criminal_article),
    asText(profile.administrative_body),
    asText(profile.special_law),
    ...asTextArray(profile.legal_articles),
    ...asTextArray(profile.must_match_terms),
    ...asTextArray(profile.strict_keywords),
    ...asTextArray(profile.broad_keywords),
    ...asTextArray(profile.keywords),
    asText(payload.uploadedDocumentText).slice(0, 1200),
  ];

  return asTextArray(terms).join(" ").slice(0, 6000);
}

async function createQueryEmbedding(openaiKey: string, queryText: string): Promise<number[]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: queryText,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 1536) {
    throw new Error("OpenAI embedding missing or wrong dimension.");
  }

  return embedding;
}

function sourceKey(row: SearchRow, sourceTable: string): string {
  return `${asText(row.source_table) || sourceTable}:${String(row.id ?? "")}`;
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function metadataBonus(row: SearchRow, profile: LegalProfile, queryText: string): number {
  const needles = asTextArray([
    asText(profile.legal_institution),
    asText(profile.dispute_subject),
    asText(profile.result),
    asText(profile.outcome_type),
    asText(profile.appeal_type),
    asText(profile.court_branch),
    ...asTextArray(profile.must_match_terms),
    ...asTextArray(profile.strict_keywords),
    ...asTextArray(profile.keywords),
    ...queryText.split(/\s+/).slice(0, 8),
  ]).map((item) => item.toLowerCase());

  if (needles.length === 0) return 0;

  const haystack = [
    row.case_number,
    row.dispute_subject,
    row.result,
    row.appeal_type,
    row.court_branch,
    row.legal_institution,
    row.administrative_body,
    row.special_law,
  ].map(asText).join(" ").toLowerCase();

  if (!haystack) return 0;

  const matches = needles.filter((needle) => haystack.includes(needle)).length;
  return Math.min(matches / Math.min(needles.length, 5), 1);
}

function mergeResults(
  ftsRows: SearchRow[],
  vectorRows: SearchRow[],
  sourceTable: string,
  profile: LegalProfile,
  queryText: string,
  limit: number,
) {
  const merged = new Map<string, SearchRow & {
    fts_score_raw?: number;
    fts_score?: number;
    semantic_score?: number;
    metadata_bonus?: number;
  }>();

  const maxFts = ftsRows.reduce(
    (max, row) => Math.max(max, numeric(row.final_score) || numeric(row.ts_rank)),
    0,
  );

  for (const row of ftsRows) {
    const key = sourceKey(row, sourceTable);
    const raw = numeric(row.final_score) || numeric(row.ts_rank);
    merged.set(key, {
      ...row,
      source_table: sourceTable,
      fts_score_raw: raw,
      fts_score: maxFts > 0 ? raw / maxFts : 0,
      semantic_score: 0,
    });
  }

  for (const row of vectorRows) {
    const key = sourceKey(row, sourceTable);
    const existing = merged.get(key);
    const semantic = Math.max(0, Math.min(numeric(row.semantic_score), 1));

    if (existing) {
      existing.semantic_score = Math.max(existing.semantic_score || 0, semantic);
      for (const [field, value] of Object.entries(row)) {
        if (existing[field] === undefined || existing[field] === null || existing[field] === "") {
          existing[field] = value;
        }
      }
    } else {
      merged.set(key, {
        ...row,
        fts_score_raw: 0,
        fts_score: 0,
        semantic_score: semantic,
      });
    }
  }

  const rows = Array.from(merged.values()).map((row) => {
    const bonus = metadataBonus(row, profile, queryText);
    const ftsScore = row.fts_score || 0;
    const semanticScore = row.semantic_score || 0;
    const finalScore = (ftsScore * 0.50) + (semanticScore * 0.40) + (bonus * 0.10);

    return {
      ...row,
      ts_rank: row.ts_rank ?? row.fts_score_raw ?? null,
      final_score: finalScore,
      hybrid_score: finalScore,
      fts_score: ftsScore,
      semantic_score: semanticScore,
      metadata_bonus: bonus,
      search_mode: "hybrid_fts_vector_metadata",
    };
  }).sort((a, b) => numeric(b.final_score) - numeric(a.final_score));

  const topRows = rows.slice(0, limit);
  const maxFinal = topRows.reduce((max, row) => Math.max(max, numeric(row.final_score)), 0);

  return topRows.map((row, index) => ({
    id: row.id,
    case_number: row.case_number,
    decision_date: row.decision_date,
    dispute_subject: row.dispute_subject,
    result: row.result,
    appeal_type: row.appeal_type,
    full_text: row.full_text,
    court_branch: row.court_branch,
    fullcase_url: row.fullcase_url,
    download_url: row.download_url,
    legal_institution: row.legal_institution,
    administrative_body: row.administrative_body,
    special_law: row.special_law,
    ts_rank: row.ts_rank,
    final_score: row.final_score,
    hybrid_score: row.hybrid_score,
    fts_score: row.fts_score,
    semantic_score: row.semantic_score,
    metadata_bonus: row.metadata_bonus,
    score: maxFinal > 0 ? Math.max(1, Math.round((numeric(row.final_score) / maxFinal) * 100)) : null,
    search_mode: row.search_mode,
    rank_position: index + 1,
  }));
}

async function proxyV1(req: Request, supabaseUrl: string, supabaseKey: string, bodyText: string) {
  const authorization = req.headers.get("Authorization") || `Bearer ${supabaseKey}`;
  const apikey = req.headers.get("apikey") || supabaseKey;

  const resp = await fetch(`${supabaseUrl}/functions/v1/search-legal-cases`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      apikey,
      "Content-Type": "application/json",
    },
    body: bodyText,
  });

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { ...CORS_HEADERS, "Content-Type": resp.headers.get("Content-Type") || "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResp({ error: "Only POST supported." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const supabaseKey = serviceKey || anonKey;

  if (!supabaseUrl || !supabaseKey) {
    return jsonResp({ error: "Supabase environment variables are not configured." }, 500);
  }

  const bodyText = await req.text();
  let payload: SearchPayload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return jsonResp({ error: "Invalid JSON body." }, 400);
  }

  const envEnabled = isEnabled(Deno.env.get("USE_SEARCH_V2"));
  const requestEnabled = isEnabled(payload.useSearchV2) || isEnabled(payload.force_v2);

  if (!envEnabled && !requestEnabled) {
    return proxyV1(req, supabaseUrl, supabaseKey, bodyText);
  }

  if (!openaiKey) {
    return proxyV1(req, supabaseUrl, supabaseKey, bodyText);
  }

  try {
    const category = normalizeCategoryForV2(payload.sourceTable || payload.table || payload.category);
    const limit = clampLimit(payload.limit);
    const profile = pickProfile(payload);
    const queryText = buildQueryText(payload, profile);

    if (!category.table) {
      return jsonResp({
        results: [],
        count: 0,
        searchMode: "unsupported_category",
        message: "Unsupported search category.",
      });
    }

    if (!queryText) {
      return jsonResp({
        results: [],
        count: 0,
        searchMode: "empty_legal_profile",
        message: "Search query is empty.",
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    const ftsLimit = Math.min(limit * 3, 100);
    const vectorLimit = Math.min(limit * 3, 100);

    let rpcName = "search_administrative_cases_hybrid";
    let rpcParams: Record<string, unknown> = buildAdministrativeRpcParams(
      profile,
      ftsLimit,
      payload.uploadedDocumentText,
    );

    if (category.key === "civil") {
      rpcName = "search_civil_cases_hybrid";
      rpcParams = buildCivilRpcParams(profile, ftsLimit);
    } else if (category.key === "criminal") {
      rpcName = "search_criminal_cases_hybrid";
      rpcParams = buildCriminalRpcParams(profile, ftsLimit);
    }

    // FTS fallback: when profile has no keywords but queryText exists, use it
    {
      const strict = rpcParams.p_strict_keywords as string[];
      const broad = rpcParams.p_broad_keywords as string[];
      const ftsEmpty =
        strict.length === 0 &&
        broad.length === 0 &&
        !rpcParams.p_dispute_subject &&
        !rpcParams.p_legal_institution;

      if (ftsEmpty && queryText) {
        const words = asTextArray(queryText.split(/\s+/)).slice(0, 8);
        rpcParams = { ...rpcParams, p_broad_keywords: words };
      }
    }

    const embedding = await createQueryEmbedding(openaiKey, queryText);

    const [ftsResult, vectorResult] = await Promise.all([
      supabase.rpc(rpcName, rpcParams),
      supabase.rpc("search_cases_vector", {
        query_embedding: embedding,
        p_category: category.key,
        p_limit: vectorLimit,
      }),
    ]);

    if (ftsResult.error && vectorResult.error) {
      return jsonResp({
        results: [],
        count: 0,
        searchMode: "search_unavailable",
        message: "ძებნის სერვისი დროებით მიუწვდომელია.",
        debug: {
          v2: true,
          fts_error: ftsResult.error.message,
          vector_error: vectorResult.error.message,
          rpc_name: rpcName,
        },
      });
    }

    const ftsRows = ftsResult.error ? [] : (Array.isArray(ftsResult.data) ? ftsResult.data : []);
    const vectorRows = vectorResult.error ? [] : (Array.isArray(vectorResult.data) ? vectorResult.data : []);

    const results = mergeResults(
      ftsRows as SearchRow[],
      vectorRows as SearchRow[],
      category.table,
      profile,
      queryText,
      limit,
    );

    return jsonResp({
      results,
      count: results.length,
      searchMode: results[0]?.search_mode || "hybrid_fts_vector_metadata",
      message: results.length > 0 ? null : "No matching cases found.",
      debug: {
        v2: true,
        fts_count: ftsRows.length,
        vector_count: vectorRows.length,
        rpc_name: rpcName,
        rpc_payload: rpcParams,
        fts_row_count: ftsRows.length,
        fts_error: ftsResult.error?.message,
        vector_error: vectorResult.error?.message,
      },
    });
  } catch (err) {
    console.error("search-legal-cases-v2 unhandled error:", err);
    return jsonResp({
      error: "search-legal-cases-v2 failed",
      details: String(err),
    }, 500);
  }
});
