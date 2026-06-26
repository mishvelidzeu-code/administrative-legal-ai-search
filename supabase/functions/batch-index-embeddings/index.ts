import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_TABLES = new Set([
  "administrative_cases",
  "criminal_cases",
  "civil_cases",
]);

const TABLES = [
  "administrative_cases",
  "criminal_cases",
  "civil_cases",
];

type EmbeddingCandidate = {
  source_table: string;
  source_id: number;
  category: string;
  case_number: string | null;
  search_text: string;
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function clampBatchSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 25;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

async function createEmbeddings(openaiKey: string, inputs: string[]) {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: inputs,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  const embeddings = Array.isArray(data?.data) ? data.data : [];

  return embeddings
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((item) => item.embedding);
}

async function processTable(
  supabase: ReturnType<typeof createClient>,
  openaiKey: string,
  table: string,
  batchSize: number,
) {
  const errors: Array<{ id?: number; error: string }> = [];

  const { data, error } = await supabase.rpc("get_cases_for_embedding", {
    p_source_table: table,
    p_limit: batchSize,
  });

  if (error) {
    return {
      table,
      processed: 0,
      failed: 0,
      remaining_batch_candidates: 0,
      errors: [{ error: `Fetch: ${error.message}` }],
    };
  }

  const cases = (Array.isArray(data) ? data : []) as EmbeddingCandidate[];

  if (cases.length === 0) {
    return {
      table,
      processed: 0,
      failed: 0,
      remaining_batch_candidates: 0,
      done: true,
    };
  }

  let embeddings: number[][];
  try {
    embeddings = await createEmbeddings(
      openaiKey,
      cases.map((item) => item.search_text.slice(0, 6000)),
    );
  } catch (err) {
    return {
      table,
      processed: 0,
      failed: cases.length,
      remaining_batch_candidates: cases.length,
      errors: [{ error: String(err).slice(0, 700) }],
    };
  }

  let processed = 0;
  let failed = 0;

  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    const embedding = embeddings[index];

    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      failed++;
      errors.push({ id: item.source_id, error: "Embedding missing or wrong dimension." });
      continue;
    }

    const { error: upsertError } = await supabase
      .from("case_search_embeddings")
      .upsert({
        source_table: item.source_table,
        source_id: item.source_id,
        category: item.category,
        case_number: item.case_number,
        search_text: item.search_text,
        embedding,
        model_version: "text-embedding-3-small",
      }, {
        onConflict: "source_table,source_id",
      });

    if (upsertError) {
      failed++;
      errors.push({ id: item.source_id, error: `Upsert: ${upsertError.message}` });
      continue;
    }

    processed++;
  }

  return {
    table,
    processed,
    failed,
    batch_size: cases.length,
    remaining_batch_candidates: Math.max(cases.length - processed, 0),
    errors: errors.length > 0 ? errors : undefined,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResp({ error: "Only POST supported." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !serviceKey) {
      return jsonResp({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set." }, 500);
    }
    if (!openaiKey) {
      return jsonResp({ error: "OPENAI_API_KEY not set." }, 500);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResp({ error: "Invalid JSON body." }, 400);
    }

    const requestedTable = String(body.table ?? "civil_cases");
    const batchSize = clampBatchSize(body.batch_size);

    if (requestedTable !== "all" && !VALID_TABLES.has(requestedTable)) {
      return jsonResp({
        error: `Unknown table "${requestedTable}". Valid: administrative_cases, criminal_cases, civil_cases, all`,
      }, 400);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const tables = requestedTable === "all" ? TABLES : [requestedTable];
    const results = [];

    for (const table of tables) {
      results.push(await processTable(supabase, openaiKey, table, batchSize));
    }

    const processed = results.reduce((sum, item) => sum + Number(item.processed || 0), 0);
    const failed = results.reduce((sum, item) => sum + Number(item.failed || 0), 0);

    return jsonResp({
      processed,
      failed,
      model_version: "text-embedding-3-small",
      results,
    });
  } catch (err) {
    console.error("batch-index-embeddings unhandled error:", err);
    return jsonResp({ error: String(err) }, 500);
  }
});
