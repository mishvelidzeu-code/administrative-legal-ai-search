import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ════════════════════════════════════════════════════════════════════════
// GPT Prompts — კატეგორიის მიხედვით დამოუკიდებელი
// ════════════════════════════════════════════════════════════════════════

const ADMINISTRATIVE_PROMPT = `შენ ხარ ქართული ადმინისტრაციული სამართლის ექსპერტი.
გაანალიზე გადაწყვეტილება და ამოიღე სტრუქტურირებული ინფორმაცია.

გადაწყვეტილება:
{TEXT}

წესები:
- legal_institution: კონკრეტული ინსტიტუტი, არა "ადმინისტრაციული სამართალი" — მაგ: "სამშენებლო სამართალდარღვევა", "საგადასახადო სანქცია"
- outcome_type: მხოლოდ granted|denied|partial|remanded|unknown
- procedural_stage: მხოლოდ საკასაციო|სააპელაციო|კერძო საჩივარი|არსებითი განხილვა|unknown
- confidence: 0.0-1.0, რამდენად დარწმუნებული ხარ ამოღებულ ინფორმაციაში
- null გამოიყენე თუ ინფორმაცია გაუგებარია ან ტექსტში არ არის

დააბრუნე ᲛᲮᲝᲚᲝᲓ JSON:
{
  "legal_institution": null,
  "dispute_subject": null,
  "legal_issue": null,
  "fact_pattern": null,
  "legal_articles": [],
  "keywords": [],
  "outcome_type": "unknown",
  "procedural_stage": "unknown",
  "deciding_factor": null,
  "court_position": null,
  "case_summary": null,
  "administrative_body": null,
  "administrative_act_type": null,
  "fine_type": null,
  "procedure_violation": null,
  "confidence": 0.0
}`;

const CRIMINAL_PROMPT = `შენ ხარ ქართული სისხლის სამართლის ექსპერტი.
გაანალიზე გადაწყვეტილება და ამოიღე სტრუქტურირებული ინფორმაცია.

გადაწყვეტილება:
{TEXT}

წესები:
- legal_institution: სისხლის სამართლის კონკრეტული ინსტიტუტი — მაგ: "მტკიცებულებათა დასაშვებობა", "სასჯელის ინდივიდუალიზაცია", "განზრახვა"
- crime_type: მაგ: "მკვლელობა", "ქურდობა", "თაღლითობა", "კორუფცია", "ნარკოტიკი"
- criminal_article: მხოლოდ ნომერი, მაგ: "108", "177"
- intent_type: მხოლოდ პირდაპირი|არაპირდაპირი|გაუფრთხილებლობა|null
- outcome_type: მხოლოდ granted|denied|partial|remanded|unknown
- procedural_stage: მხოლოდ საკასაციო|სააპელაციო|კერძო საჩივარი|არსებითი განხილვა|unknown
- confidence: 0.0-1.0
- null გამოიყენე თუ ინფორმაცია გაუგებარია

დააბრუნე ᲛᲮᲝᲚᲝᲓ JSON:
{
  "legal_institution": null,
  "dispute_subject": null,
  "legal_issue": null,
  "fact_pattern": null,
  "legal_articles": [],
  "keywords": [],
  "outcome_type": "unknown",
  "procedural_stage": "unknown",
  "deciding_factor": null,
  "court_position": null,
  "case_summary": null,
  "crime_type": null,
  "criminal_article": null,
  "criminal_part": null,
  "intent_type": null,
  "evidence_type": null,
  "sentence_type": null,
  "qualification_issue": null,
  "confidence": 0.0
}`;

const CIVIL_PROMPT = `შენ ხარ ქართული სამოქალაქო სამართლის ექსპერტი.
გაანალიზე გადაწყვეტილება და ამოიღე სტრუქტურირებული ინფორმაცია.

გადაწყვეტილება:
{TEXT}

წესები:
- legal_institution: სამოქალაქო სამართლის კონკრეტული ინსტიტუტი — მაგ: "სახელშეკრულებო სამართალი", "ნივთობრივი სამართალი", "სამემკვიდრეო სამართალი"
- contract_type: მაგ: "ნასყიდობა", "იჯარა", "სესხი", "მომსახურება" — null თუ ხელშეკრულება არ არის სადავო
- property_type: "უძრავი ქონება"|"მოძრავი ქონება"|"წილი"|სხვა — null თუ ქონება არ არის სადავო
- outcome_type: მხოლოდ granted|denied|partial|remanded|unknown
- procedural_stage: მხოლოდ საკასაციო|სააპელაციო|კერძო საჩივარი|არსებითი განხილვა|unknown
- confidence: 0.0-1.0
- null გამოიყენე თუ ინფორმაცია გაუგებარია ან არ ეხება

დააბრუნე ᲛᲮᲝᲚᲝᲓ JSON:
{
  "legal_institution": null,
  "dispute_subject": null,
  "legal_issue": null,
  "fact_pattern": null,
  "legal_articles": [],
  "keywords": [],
  "outcome_type": "unknown",
  "procedural_stage": "unknown",
  "deciding_factor": null,
  "court_position": null,
  "case_summary": null,
  "contract_type": null,
  "property_type": null,
  "family_relation": null,
  "inheritance_issue": null,
  "obligation_type": null,
  "ownership_issue": null,
  "damages_type": null,
  "company_dispute": null,
  "labor_dispute": null,
  "bankruptcy_issue": null,
  "confidence": 0.0
}`;

// ════════════════════════════════════════════════════════════════════════
// Routing tables
// ════════════════════════════════════════════════════════════════════════

const TABLE_TO_CATEGORY: Record<string, string> = {
  administrative_cases: "administrative",
  criminal_cases:       "criminal",
  civil_cases:          "civil",
};

const CATEGORY_TO_PROMPT: Record<string, string> = {
  administrative: ADMINISTRATIVE_PROMPT,
  criminal:       CRIMINAL_PROMPT,
  civil:          CIVIL_PROMPT,
};

// ════════════════════════════════════════════════════════════════════════
// Profile builder — GPT output → DB row
// ════════════════════════════════════════════════════════════════════════

function buildProfileRow(
  sourceTable: string,
  category: string,
  c: { id: number; case_number: string | null; decision_date: string | null },
  p: Record<string, unknown>,
) {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === "string") as string[] : [];

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  return {
    source_table:   sourceTable,
    source_id:      c.id,
    category,
    case_number:    c.case_number  ?? null,
    decision_date:  c.decision_date ? String(c.decision_date) : null,

    // shared
    legal_institution:  str(p.legal_institution),
    dispute_subject:    str(p.dispute_subject),
    legal_issue:        str(p.legal_issue),
    fact_pattern:       str(p.fact_pattern),
    legal_articles:     arr(p.legal_articles),
    keywords:           arr(p.keywords),
    outcome_type:       str(p.outcome_type),
    procedural_stage:   str(p.procedural_stage),
    deciding_factor:    str(p.deciding_factor),
    court_position:     str(p.court_position),
    case_summary:       str(p.case_summary),
    confidence:         typeof p.confidence === "number" ? p.confidence : null,
    processed_at:       new Date().toISOString(),
    model_version:      "gpt-5.4-mini",

    // administrative
    administrative_body:     str(p.administrative_body),
    administrative_act_type: str(p.administrative_act_type),
    fine_type:               str(p.fine_type),
    procedure_violation:     str(p.procedure_violation),

    // criminal
    crime_type:          str(p.crime_type),
    criminal_article:    str(p.criminal_article),
    criminal_part:       str(p.criminal_part),
    intent_type:         str(p.intent_type),
    evidence_type:       str(p.evidence_type),
    sentence_type:       str(p.sentence_type),
    qualification_issue: str(p.qualification_issue),

    // civil
    contract_type:      str(p.contract_type),
    property_type:      str(p.property_type),
    family_relation:    str(p.family_relation),
    inheritance_issue:  str(p.inheritance_issue),
    obligation_type:    str(p.obligation_type),
    ownership_issue:    str(p.ownership_issue),
    damages_type:       str(p.damages_type),
    company_dispute:    str(p.company_dispute),
    labor_dispute:      str(p.labor_dispute),
    bankruptcy_issue:   str(p.bankruptcy_issue),
  };
}

// ════════════════════════════════════════════════════════════════════════
// Main handler
// ════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResp({ error: "Only POST supported." }, 405);

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResp({ error: "Invalid JSON body." }, 400);
    }

    const sourceTable = String(body.table ?? "");
    const batchSize   = Math.min(Math.max(Number(body.batch_size) || 50, 1), 100);

    const category = TABLE_TO_CATEGORY[sourceTable];
    if (!category) {
      return jsonResp({
        error: `Unknown table "${sourceTable}". Valid: administrative_cases, criminal_cases, civil_cases`,
      }, 400);
    }

    const promptTemplate = CATEGORY_TO_PROMPT[category];

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey   = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !serviceKey) {
      return jsonResp({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set." }, 500);
    }
    if (!openaiKey) {
      return jsonResp({ error: "OPENAI_API_KEY not set." }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // ── Fetch pending cases ───────────────────────────────────────────────
    const { data: cases, error: fetchError } = await supabase
      .from(sourceTable)
      .select("id, case_number, decision_date, full_text")
      .eq("processing_status", "pending")
      .not("full_text", "is", null)
      .limit(batchSize);

    if (fetchError) {
      return jsonResp({ error: `Fetch error: ${fetchError.message}` }, 500);
    }

    if (!cases || cases.length === 0) {
      // Count total pending for status report
      const { count } = await supabase
        .from(sourceTable)
        .select("id", { count: "exact", head: true })
        .eq("processing_status", "pending");

      return jsonResp({ done: true, processed: 0, failed: 0, remaining: count ?? 0 });
    }

    // ── Process each case ─────────────────────────────────────────────────
    let processed = 0;
    let failed    = 0;
    const errors: Array<{ id: number; error: string }> = [];

    for (const c of cases) {
      try {
        const text = String(c.full_text ?? "").slice(0, 5000);
        const prompt = promptTemplate.replace("{TEXT}", text);

        // ── GPT call ───────────────────────────────────────────────────────
        const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model:           "gpt-5.4-mini",
            temperature:     0.1,
            max_tokens:      1000,
            response_format: { type: "json_object" },
            messages: [
              { role: "user", content: prompt },
            ],
          }),
        });

        if (!gptResp.ok) {
          const errText = await gptResp.text().catch(() => "");
          errors.push({ id: c.id, error: `GPT ${gptResp.status}: ${errText.slice(0, 120)}` });
          failed++;
          continue;
        }

        const gptData = await gptResp.json();
        const rawContent: string = gptData?.choices?.[0]?.message?.content ?? "";

        let profile: Record<string, unknown>;
        try {
          profile = JSON.parse(rawContent);
        } catch {
          errors.push({ id: c.id, error: `JSON parse failed: ${rawContent.slice(0, 80)}` });
          failed++;
          continue;
        }

        // ── Upsert profile ─────────────────────────────────────────────────
        const row = buildProfileRow(sourceTable, category, c, profile);

        const { error: upsertError } = await supabase
          .from("case_legal_profiles")
          .upsert(row, { onConflict: "source_table,source_id" });

        if (upsertError) {
          errors.push({ id: c.id, error: `Upsert: ${upsertError.message}` });
          failed++;
          continue;
        }

        // ── Mark profiled ──────────────────────────────────────────────────
        const { error: updateError } = await supabase
          .from(sourceTable)
          .update({ processing_status: "profiled" })
          .eq("id", c.id);

        if (updateError) {
          // profile saved, just status update failed — not critical
          errors.push({ id: c.id, error: `Status update: ${updateError.message}` });
        }

        processed++;
      } catch (err) {
        errors.push({ id: c.id, error: String(err).slice(0, 200) });
        failed++;
      }
    }

    // ── Count remaining ───────────────────────────────────────────────────
    const { count: remaining } = await supabase
      .from(sourceTable)
      .select("id", { count: "exact", head: true })
      .eq("processing_status", "pending")
      .not("full_text", "is", null);

    return jsonResp({
      table:          sourceTable,
      category,
      processed,
      failed,
      batch_size:     cases.length,
      remaining:      remaining ?? 0,
      errors:         errors.length > 0 ? errors : undefined,
    });

  } catch (err) {
    console.error("batch-index-profiles unhandled error:", err);
    return jsonResp({ error: String(err) }, 500);
  }
});
