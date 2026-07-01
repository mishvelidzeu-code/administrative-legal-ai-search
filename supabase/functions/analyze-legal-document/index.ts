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

interface RequestPayload {
  category?: string;
  defense?: string;
  prosecution?: string;
  desiredOutcome?: string;
  lawArticle?: string;
  userInstruction?: string;
  documentText?: string;
}

const PRIMARY_MODEL = "gpt-4o-mini";
const FALLBACK_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 30000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function buildUserPrompt(d: RequestPayload): string {
  const lines: string[] = [];

  if (d.category)        lines.push(`კატეგორია: ${d.category}`);
  if (d.lawArticle)      lines.push(`მუხლი/თავი: ${d.lawArticle}`);
  if (d.defense)         lines.push(`დაცვის პოზიცია: ${d.defense}`);
  if (d.prosecution)     lines.push(`ბრალდების/მეორე მხარის პოზიცია: ${d.prosecution}`);
  if (d.desiredOutcome)  lines.push(`სასურველი შედეგი: ${d.desiredOutcome}`);
  if (d.userInstruction) lines.push(`\nდამატებითი ინსტრუქცია: ${d.userInstruction}`);
  if (d.documentText)    lines.push(`\nდოკუმენტის ტექსტი (პირველი 4000 სიმბოლო):\n${d.documentText.slice(0, 4000)}`);

  lines.push(`
გააანალიზე ეს ქართული სამართლებრივი საქმე. ყველა ტექსტური ველი ქართულ ენაზე უნდა იყოს.

━━━ CRITICAL RULE — სამართლებრივი ინსტიტუტების გამიჯვნა ━━━

სამართლებრივი ინსტიტუტები ერთმანეთისგან მკვეთრად განსხვავდება. exclude_terms-ი ᲧᲝᲕᲔᲚᲗᲕᲘᲡ უნდა შეიცავდეს სხვა ინსტიტუტების საკვანძო ტერმინებს:

• თუ საქმე ეხება „თანამემამულის სტატუსს":
  exclude_terms: ["ლტოლვილი", "საერთაშორისო დაცვა", "თავშესაფარი", "დამატებითი დაცვა", "მიგრაცია", "შსს მიგრაციის"]

• თუ საქმე ეხება „ლტოლვილის სტატუსს" ან „საერთაშორისო დაცვას":
  exclude_terms: ["თანამემამული", "მოქალაქეობა", "ბინადრობის ნებართვა", "სახელმწიფო სერვისების"]

• თუ საქმე ეხება „ბინადრობის ნებართვას":
  exclude_terms: ["ლტოლვილი", "თანამემამული", "საერთაშორისო დაცვა", "თავშესაფარი"]

• თუ საქმე ეხება „მოქალაქეობას":
  exclude_terms: ["ლტოლვილი", "ბინადრობა", "საერთაშორისო დაცვა", "თანამემამული"]

strict_keywords — ეს ინსტიტუტის ზუსტი, მხოლოდ ამ ინსტიტუტისთვის დამახასიათებელი ტერმინები.
must_match_terms — ფრაზები, რომლებიც ᲜᲔᲑᲘᲡᲛᲘᲔᲠ შესაბამის პრეცედენტში უნდა ჩანდეს.
broad_keywords — ზოგადი სამართლებრივი სფეროს ტერმინები (ფართო ძებნისთვის).

━━━ CRIMINAL CASE SPECIFICITY RULE ━━━

სისხლის სამართლის საქმეებში legal_institution არასდროს იყოს "სისხლის სამართალი" — ეს ძალიან ზოგადია.
legal_institution უნდა იყოს კონკრეტული დანაშაულის ტიპი:

• ოჯახური ძალადობა / ოჯახის წევრის მიმართ ძალადობა:
  legal_institution: "ოჯახური ძალადობა"
  strict_keywords: ["ოჯახური ძალადობა", "ოჯახის წევრი", "126¹"]
  broad_keywords: ["ძალადობა", "ოჯახი", "მუქარა"]
  crime_type: "ოჯახური ძალადობა"

• სიცოცხლის მოსპობის მუქარა / 151-ე მუხლი:
  legal_institution: "სიცოცხლის მოსპობის მუქარა"
  strict_keywords: ["სიცოცხლის მოსპობის მუქარა", "151"]
  broad_keywords: ["მუქარა", "სიცოცხლე"]

• მკვლელობა / 108-ე ან 109-ე მუხლი:
  legal_institution: "მკვლელობა"
  strict_keywords: ["მკვლელობა", "108", "109"]

• ნარკოტიკული დანაშაული / 260-ე, 273-ე მუხლი:
  legal_institution: "ნარკოტიკული დანაშაული"
  strict_keywords: ["ნარკოტიკული", "260", "273"]

• ქურდობა / ძარცვა / 177-ე, 178-ე მუხლი:
  legal_institution: "ქურდობა" ან "ძარცვა"
  strict_keywords: ["ქურდობა", "177"] ან ["ძარცვა", "178"]

• თაღლითობა / 180-ე მუხლი:
  legal_institution: "თაღლითობა"
  strict_keywords: ["თაღლითობა", "180"]

• მრავალი ბრალდება: ჩამოთვალე ყველა ძირითადი მუხლი strict_keywords-ში.
• criminal_article ველში ჩასვი კოდის ნომრები: ["126¹", "151"] ან ["108"] და ა.შ.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ ADMINISTRATIVE CASE SPECIFICITY RULE ━━━

ადმინისტრაციულ საქმეებში legal_institution არასდროს იყოს მხოლოდ ზოგადი:
"ადმინისტრაციული სამართალი", "ადმინისტრაციული აქტი", "აქტის ბათილად ცნობა".

თუ ტექსტში ჩანს კონკრეტული სფერო, legal_institution და strict_keywords უნდა იყოს კონკრეტული:
• მუნიციპალური ინსპექცია / თბილისის მერია / სამშენებლო სამართალდარღვევა:
  legal_institution: "სამშენებლო სამართალდარღვევა"
  dispute_subject: "მუნიციპალური ინსპექციის აქტების ბათილად ცნობა"
  strict_keywords: ["სამშენებლო სამართალდარღვევა", "მუნიციპალური ინსპექცია", "მშენებლობის ნებართვის გარეშე", "შემოწმების აქტი", "მითითება"]

• საგადასახადო დავა:
  legal_institution: "საგადასახადო დავა"

• სოციალური დახმარება / პენსია:
  legal_institution: "სოციალური დახმარება" ან "პენსია"

თუ კონკრეტული სფერო ჩანს, must_match_terms-ში ჩასვი 1-2 ყველაზე სპეციფიკური ფრაზა და არა ზოგადი "ადმინისტრაციული აქტი".
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ FACTUAL SIMILARITY RULE ━━━

ძიებისთვის ყველაზე მნიშვნელოვანია ფაქტობრივი ბირთვი: ქმედება, დაზარალებული/მხარეები, მოთხოვნა, სადავო აქტი, მტკიცებულებები, კონკრეტული სამართლებრივი ნორმა და სასამართლოს საბოლოო შედეგი.

არ ჩათვალო მსგავსებად მხოლოდ პროცედურული შაბლონი, როგორიცაა:
"საკასაციო საჩივრის დასაშვებობა", "საკასაციო საჩივარი დაუშვებელია", "303-ე მუხლი", "განჩინება საბოლოოა".

desired_similarity, summary_for_search, strict_keywords და must_match_terms უნდა აღწერდეს ფაქტობრივად მსგავს საქმეებს და არა მხოლოდ უზენაესი სასამართლოს სტანდარტულ დასაშვებობის ფორმულირებებს.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

დააბრუნე JSON ობიექტი ზუსტად შემდეგი ველებით:
{
  "case_type": "საქმის ტიპი (ადმინისტრაციული / სამოქალაქო / სისხლის)",
  "court_branch": "სასამართლო პალატის სახელი",
  "facts": "ძირითადი ფაქტების სინთეზი (2-3 წინადადება)",
  "legal_articles": ["კანონის მუხლი 1"],
  "party_positions": {
    "defense": "დაცვის მხარის პოზიცია",
    "prosecution_or_opposing_party": "ბრალდების / მეორე მხარის პოზიცია",
    "court": "სასამართლოს მოსალოდნელი პოზიცია"
  },
  "legal_issue": "ძირითადი სამართლებრივი საკითხი (1 წინადადება)",
  "desired_similarity": "რა მსგავსება უნდა მოიძებნოს",
  "desired_difference": "რა განსხვავება არ სჭირდება",
  "search_query": "ოპტიმიზებული საძიებო ტექსტი",
  "keywords": ["სიტყვა1", "სიტყვა2"],
  "summary_for_search": "სრული შეჯამება AI ძიებისთვის (3-4 წინადადება)",
  "dispute_subject": "კონკრეტული დავის საგანი — მაგ: \"თანამემამულის სტატუსის მინიჭება\"",
  "administrative_body": "მოპასუხე ადმინისტრაციული ორგანო — მაგ: \"სახელმწიფო სერვისების განვითარების სააგენტო\"",
  "legal_institution": "სამართლებრივი ინსტიტუტი — მაგ: \"თანამემამულის სტატუსი\"",
  "requested_action": "მოსარჩელის კონკრეტული მოთხოვნა",
  "special_law": "სპეციალური კანონი ან ნორმა (ცარიელი თუ არ ჩანს)",
  "procedural_stage": "პროცედურული ეტაპი: არსებითი დავა / საკასაციო / კერძო საჩივარი / უზრუნველყოფა",
  "main_legal_issue": "მთავარი სამართლებრივი პრობლემა",
  "must_match_terms": ["ფრაზა1", "ფრაზა2"],
  "exclude_terms": ["სხვა ინსტიტუტის ტერმინი1", "სხვა ინსტიტუტის ტერმინი2"],
  "broad_keywords": ["ზოგადი სიტყვა1", "ზოგადი სიტყვა2"],
  "strict_keywords": ["ზუსტი ტერმინი1", "ზუსტი ტერმინი2"]
}`);

  return lines.join("\n");
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function buildFastLegalProfile(payload: RequestPayload) {
  const rawText = [
    payload.category,
    payload.defense,
    payload.prosecution,
    payload.desiredOutcome,
    payload.lawArticle,
    payload.userInstruction,
    payload.documentText,
  ].filter(Boolean).join(" ");
  const text = rawText.toLowerCase();
  const category = payload.category || (
    includesAny(text, ["126", "151", "სსკ", "ბრალდებულ", "დაზარალებულ", "ოჯახური ძალად"])
      ? "სისხლი"
      : includesAny(text, ["ადმინისტრაციულ", "აქტის ბათილად", "სსიპ", "მერია"])
        ? "ადმინისტრაციული"
        : "სამოქალაქო"
  );

  const legalArticles = Array.from(new Set(rawText.match(/[0-9]{2,3}(?:[¹²³])?/g) ?? [])).slice(0, 8);
  const strictKeywords: string[] = [];
  const broadKeywords: string[] = [];
  const mustMatchTerms: string[] = [];
  const excludeTerms: string[] = [];
  let legalInstitution = "";
  let disputeSubject = "";
  let crimeType = "";
  let criminalArticle = "";

  if (includesAny(text, ["ოჯახური ძალად", "ოჯახის წევრ", "126¹", "1261"])) {
    legalInstitution = "ოჯახური ძალადობა";
    disputeSubject = "ოჯახში ძალადობასთან დაკავშირებული სისხლის სამართლის საქმე";
    crimeType = "ოჯახური ძალადობა";
    criminalArticle = "126¹";
    strictKeywords.push("ოჯახური ძალადობა", "ოჯახის წევრი", "126¹");
    broadKeywords.push("ძალადობა", "მუქარა", "დაზარალებული");
    mustMatchTerms.push("ოჯახური ძალადობა");
  }

  if (includesAny(text, ["მუქარა", "სიცოცხლის მოსპობის", "151"])) {
    if (!legalInstitution) legalInstitution = "სიცოცხლის მოსპობის მუქარა";
    if (!crimeType) crimeType = "მუქარა";
    if (!criminalArticle) criminalArticle = "151";
    strictKeywords.push("მუქარა", "სიცოცხლის მოსპობის მუქარა", "151");
    mustMatchTerms.push("მუქარა");
  }

  if (!legalInstitution && includesAny(text, ["ნარკოტიკ", "კანაფ", "260", "273"])) {
    legalInstitution = "ნარკოტიკული დანაშაული";
    crimeType = "ნარკოტიკული დანაშაული";
    strictKeywords.push("ნარკოტიკული", "კანაფი", "260", "273");
    broadKeywords.push("ნარკოტიკული საშუალება");
  } else if (includesAny(text, ["ნარკოტიკ", "კანაფ", "260", "273"])) {
    broadKeywords.push("ნარკოტიკული", "კანაფი");
  }

  if (includesAny(text, ["შემაკავებელი ორდერ", "ორდერის დარღვ"])) {
    strictKeywords.push("შემაკავებელი ორდერი", "ორდერის დარღვევა");
    mustMatchTerms.push("შემაკავებელი ორდერი");
  }

  if (includesAny(text, ["თანამემამულ", "ლტოლვილ", "საერთაშორისო დაცვ", "ბინადრობის"])) {
    if (text.includes("თანამემამულ")) {
      legalInstitution = "თანამემამულის სტატუსი";
      disputeSubject = "თანამემამულის სტატუსის მინიჭება";
      strictKeywords.push("თანამემამულის სტატუსი", "თანამემამული");
      excludeTerms.push("ლტოლვილი", "საერთაშორისო დაცვა", "თავშესაფარი");
    } else if (text.includes("ლტოლვილ") || text.includes("საერთაშორისო დაცვ")) {
      legalInstitution = "საერთაშორისო დაცვა";
      disputeSubject = "ლტოლვილის ან დამატებითი დაცვის სტატუსი";
      strictKeywords.push("ლტოლვილი", "საერთაშორისო დაცვა", "დამატებითი დაცვა");
      excludeTerms.push("თანამემამული", "მოქალაქეობა", "ბინადრობის ნებართვა");
    }
  }

  if (!legalInstitution) legalInstitution = String(category) === "სისხლი" ? "სისხლის სამართლის კონკრეტული დავა" : "";
  if (!disputeSubject) disputeSubject = legalInstitution || "სამართლებრივი დავა";

  const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean))).slice(0, 12);
  const facts = rawText.replace(/\s+/g, " ").slice(0, 900);

  return {
    case_type: category,
    court_branch: "",
    facts,
    legal_articles: unique([...legalArticles, criminalArticle]),
    party_positions: {
      defense: payload.defense || "",
      prosecution_or_opposing_party: payload.prosecution || "",
      court: payload.desiredOutcome || "",
    },
    legal_issue: disputeSubject,
    desired_similarity: `${legalInstitution}; ${unique(mustMatchTerms).join(", ")}`,
    desired_difference: "მხოლოდ პროცედურული საკასაციო დასაშვებობის შაბლონი არ არის საკმარისი მსგავსებისთვის",
    search_query: unique([legalInstitution, disputeSubject, crimeType, criminalArticle, ...strictKeywords, ...mustMatchTerms]).join(" "),
    keywords: unique([...strictKeywords, ...broadKeywords, ...legalArticles]),
    summary_for_search: facts,
    dispute_subject: disputeSubject,
    administrative_body: "",
    legal_institution: legalInstitution,
    requested_action: payload.desiredOutcome || "",
    special_law: "",
    procedural_stage: includesAny(text, ["საკასაციო", "დაუშვებელ"]) ? "საკასაციო" : "",
    main_legal_issue: disputeSubject,
    must_match_terms: unique(mustMatchTerms),
    exclude_terms: unique(excludeTerms),
    broad_keywords: unique(broadKeywords),
    strict_keywords: unique(strictKeywords),
    crime_type: crimeType,
    criminal_article: criminalArticle,
    model_used: "local-fast-legal-profile",
  };
}

async function callOpenAiJson(apiKey: string, model: string, payload: RequestPayload) {
  const openaiRes = await withTimeout(fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a legal AI assistant specialized in Georgian law (საქართველოს სამართალი). " +
            "You extract structured legal information for court precedent search. " +
            "You are STRICT about distinguishing between different legal institutions — " +
            "e.g. 'თანამემამულის სტატუსი' is completely different from 'ლტოლვილის სტატუსი'. " +
            "Always populate exclude_terms with terms from OTHER, similar-sounding institutions " +
            "to prevent false matches. " +
            "All text field values must be in the Georgian language. " +
            "Return ONLY a valid JSON object with no additional text.",
        },
        {
          role: "user",
          content: buildUserPrompt(payload),
        },
      ],
      temperature: 0.1,
      max_tokens: 2500,
    }),
  }), OPENAI_TIMEOUT_MS, `OpenAI ${model}`);

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    throw new Error(`OpenAI ${model} ${openaiRes.status}: ${errText.slice(0, 500)}`);
  }

  const openaiData = await openaiRes.json();
  const content: string = openaiData.choices?.[0]?.message?.content ?? "";

  if (!content) throw new Error(`OpenAI ${model} returned empty content.`);

  return content;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return jsonResp({ error: "OpenAI API key კონფიგურირებული არ არის სერვერზე." }, 500);
    }

    let payload: RequestPayload;
    try {
      payload = await req.json();
    } catch {
      return jsonResp({ error: "მოთხოვნის ფორმატი არასწორია." }, 400);
    }

    if (payload.documentText || payload.prosecution || payload.defense || payload.userInstruction) {
      return jsonResp(buildFastLegalProfile(payload));
    }

    let content: string;
    let modelUsed = PRIMARY_MODEL;
    try {
      content = await callOpenAiJson(apiKey, PRIMARY_MODEL, payload);
    } catch (primaryErr) {
      console.error("Primary OpenAI model failed:", String(primaryErr));
      if (FALLBACK_MODEL === PRIMARY_MODEL) {
        return jsonResp({
          error: "AI სერვისი ამჟამად მიუწვდომელია. სცადეთ მოგვიანებით.",
          details: String(primaryErr).slice(0, 500),
        }, 502);
      }
      modelUsed = FALLBACK_MODEL;
      try {
        content = await callOpenAiJson(apiKey, FALLBACK_MODEL, payload);
      } catch (fallbackErr) {
        console.error("Fallback OpenAI model failed:", String(fallbackErr));
        return jsonResp({
          error: "AI სერვისი ამჟამად მიუწვდომელია. სცადეთ მოგვიანებით.",
          details: String(fallbackErr).slice(0, 500),
        }, 502);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("JSON parse error, content:", content.slice(0, 200));
      return jsonResp({ error: "AI-ს პასუხი ვერ დამუშავდა (JSON შეცდომა)." }, 502);
    }

    return jsonResp({
      ...(parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}),
      model_used: modelUsed,
    });

  } catch (err) {
    console.error("Edge function unhandled error:", err);
    return jsonResp({ error: "სერვერზე შეცდომა დაფიქსირდა. სცადეთ მოგვიანებით." }, 500);
  }
});
