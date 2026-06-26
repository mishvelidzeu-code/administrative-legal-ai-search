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

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI API error:", openaiRes.status, errText);
      if (openaiRes.status === 401) return jsonResp({ error: "OpenAI API key არასწორია." }, 502);
      if (openaiRes.status === 429) return jsonResp({ error: "AI სერვისზე მოთხოვნების ლიმიტი ამოიწურა. სცადეთ მოგვიანებით." }, 429);
      return jsonResp({ error: "AI სერვისი ამჟამად მიუწვდომელია. სცადეთ მოგვიანებით." }, 502);
    }

    const openaiData = await openaiRes.json();
    const content: string = openaiData.choices?.[0]?.message?.content ?? "";

    if (!content) return jsonResp({ error: "AI-მ ცარიელი პასუხი დააბრუნა." }, 502);

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("JSON parse error, content:", content.slice(0, 200));
      return jsonResp({ error: "AI-ს პასუხი ვერ დამუშავდა (JSON შეცდომა)." }, 502);
    }

    return jsonResp(parsed);

  } catch (err) {
    console.error("Edge function unhandled error:", err);
    return jsonResp({ error: "სერვერზე შეცდომა დაფიქსირდა. სცადეთ მოგვიანებით." }, 500);
  }
});
