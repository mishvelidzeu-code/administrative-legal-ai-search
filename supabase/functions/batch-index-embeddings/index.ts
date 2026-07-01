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

// Chunk parameters — ~1000 tokens ≈ 4000 chars; 500-char overlap avoids
// cutting sentences at boundaries and ensures the verdict section is captured.
const CHUNK_MAX_CHARS = 4000;
const CHUNK_OVERLAP   = 500;
const EMBEDDING_INPUT_BATCH_SIZE = 16;
const EMBEDDING_BATCH_DELAY_MS = 1200;

type CaseForEmbedding = {
  source_table:      string;
  source_id:         number;
  category:          string;
  case_number:       string | null;
  dispute_subject:   string | null;
  legal_institution: string | null;
  result:            string | null;
  full_text:         string | null;
};

type EmbeddingChunk = {
  source_table:      string;
  source_id:         number;
  category:          string;
  case_number:       string | null;
  chunk_index:       number;
  search_text:       string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits text into overlapping chunks so that the verdict/resolution section
 * at the end of a court decision is always covered by at least one chunk.
 */
function chunkText(text: string, maxChars = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += maxChars - overlap;
  }

  return chunks;
}

function buildMetaPrefix(item: CaseForEmbedding): string {
  const parts = [
    item.case_number       && `საქმე: ${item.case_number}`,
    item.dispute_subject   && `დავის საგანი: ${item.dispute_subject}`,
    item.legal_institution && `სამართლებრივი ინსტიტუტი: ${item.legal_institution}`,
    item.result            && `შედეგი: ${item.result}`,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" | ") + "\n\n" : "";
}

/**
 * Produces one EmbeddingChunk per text segment. Each chunk carries the full
 * case metadata prefix so every vector has unambiguous legal context.
 */
function buildChunksForCase(item: CaseForEmbedding): EmbeddingChunk[] {
  const metaPrefix  = buildMetaPrefix(item);
  const fullText    = item.full_text ?? "";

  // Reserve space for metadata inside each chunk's 6000-char budget.
  const textMaxChars = Math.max(CHUNK_MAX_CHARS - metaPrefix.length, 1000);
  const textChunks   = chunkText(fullText, textMaxChars, CHUNK_OVERLAP);

  // Case with no full_text: emit one metadata-only chunk so it's still indexed.
  if (textChunks.length === 0) {
    return [{
      source_table: item.source_table,
      source_id:    item.source_id,
      category:     item.category,
      case_number:  item.case_number,
      chunk_index:  0,
      search_text:  metaPrefix.trim().slice(0, 6000),
    }];
  }

  return textChunks.map((textChunk, index) => ({
    source_table: item.source_table,
    source_id:    item.source_id,
    category:     item.category,
    case_number:  item.case_number,
    chunk_index:  index,
    search_text:  (metaPrefix + textChunk).slice(0, 6000),
  }));
}

async function createEmbeddings(openaiKey: string, inputs: string[]): Promise<number[][]> {
  const retryDelaysMs = [0, 2000, 5000, 10000];

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

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

    if (resp.ok) {
      const data = await resp.json();
      const embeddings = Array.isArray(data?.data) ? data.data : [];

      return embeddings
        .sort((a, b) => Number(a.index) - Number(b.index))
        .map((item) => item.embedding);
    }

    const text = await resp.text().catch(() => "");
    const canRetry = resp.status === 429 || resp.status >= 500;
    if (!canRetry || attempt === retryDelaysMs.length - 1) {
      throw new Error(`OpenAI embeddings ${resp.status}: ${text.slice(0, 500)}`);
    }
  }

  throw new Error("OpenAI embeddings failed.");
}

async function createEmbeddingsBatched(openaiKey: string, inputs: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let start = 0; start < inputs.length; start += EMBEDDING_INPUT_BATCH_SIZE) {
    const batch = inputs.slice(start, start + EMBEDDING_INPUT_BATCH_SIZE);
    embeddings.push(...await createEmbeddings(openaiKey, batch));
    if (start + EMBEDDING_INPUT_BATCH_SIZE < inputs.length) {
      await sleep(EMBEDDING_BATCH_DELAY_MS);
    }
  }

  return embeddings;
}

async function processTable(
  supabase: ReturnType<typeof createClient>,
  openaiKey: string,
  table: string,
  batchSize: number,
) {
  const errors: Array<{ id?: number; chunk_index?: number; error: string }> = [];

  const { data, error } = await supabase.rpc("get_cases_for_embedding", {
    p_source_table: table,
    p_limit: batchSize,
  });

  if (error) {
    return {
      table,
      processed:    0,
      failed:       0,
      errors: [{ error: `Fetch: ${error.message}` }],
    };
  }

  const cases = (Array.isArray(data) ? data : []) as CaseForEmbedding[];

  if (cases.length === 0) {
    return { table, processed: 0, failed: 0, done: true };
  }

  // Flatten all chunks from all cases in this batch into one array.
  const allChunks: EmbeddingChunk[] = [];
  for (const item of cases) {
    allChunks.push(...buildChunksForCase(item));
  }

  // Single OpenAI call for all chunks (typically 25 cases × ~5 chunks = ~125).
  let embeddings: number[][];
  try {
    embeddings = await createEmbeddingsBatched(
      openaiKey,
      allChunks.map((chunk) => chunk.search_text),
    );
  } catch (err) {
    return {
      table,
      processed: 0,
      failed:    cases.length,
      errors: [{ error: String(err).slice(0, 700) }],
    };
  }

  // Build upsert rows — skip any chunk whose embedding came back malformed.
  const upsertRows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < allChunks.length; i++) {
    const chunk     = allChunks[i];
    const embedding = embeddings[i];

    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      errors.push({
        id:          chunk.source_id,
        chunk_index: chunk.chunk_index,
        error:       "Embedding missing or wrong dimension.",
      });
      continue;
    }

    upsertRows.push({
      source_table:  chunk.source_table,
      source_id:     chunk.source_id,
      category:      chunk.category,
      case_number:   chunk.case_number,
      chunk_index:   chunk.chunk_index,
      search_text:   chunk.search_text,
      embedding,
      model_version: "text-embedding-3-small",
    });
  }

  let processed = 0;
  let failed    = allChunks.length - upsertRows.length; // malformed embeddings

  if (upsertRows.length > 0) {
    const { error: upsertError } = await supabase
      .from("case_search_embeddings")
      .upsert(upsertRows, { onConflict: "source_table,source_id,chunk_index" });

    if (upsertError) {
      failed += upsertRows.length;
      errors.push({ error: `Batch upsert: ${upsertError.message}` });
    } else {
      processed = upsertRows.length;
    }
  }

  return {
    table,
    processed,
    failed,
    cases_in_batch:  cases.length,
    chunks_in_batch: allChunks.length,
    done: cases.length < batchSize,
    errors: errors.length > 0 ? errors : undefined,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResp({ error: "Only POST supported." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey   = Deno.env.get("OPENAI_API_KEY");

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
    const batchSize      = clampBatchSize(body.batch_size);

    if (requestedTable !== "all" && !VALID_TABLES.has(requestedTable)) {
      return jsonResp({
        error: `Unknown table "${requestedTable}". Valid: administrative_cases, criminal_cases, civil_cases, all`,
      }, 400);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const tables  = requestedTable === "all" ? TABLES : [requestedTable];
    const results = [];

    for (const table of tables) {
      results.push(await processTable(supabase, openaiKey, table, batchSize));
    }

    const processed = results.reduce((sum, r) => sum + Number(r.processed || 0), 0);
    const failed    = results.reduce((sum, r) => sum + Number(r.failed    || 0), 0);

    return jsonResp({ processed, failed, model_version: "text-embedding-3-small", results });
  } catch (err) {
    console.error("batch-index-embeddings unhandled error:", err);
    return jsonResp({ error: String(err) }, 500);
  }
});
