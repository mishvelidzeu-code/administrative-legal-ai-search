import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildAdministrativeRpcParams,
  buildCivilRpcParams,
  buildCriminalRpcParams,
  clampLimit,
  normalizeCategory,
  pickProfile,
  type LegalProfile,
  type SearchPayload,
} from "../shared/legal-search/fts.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


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
