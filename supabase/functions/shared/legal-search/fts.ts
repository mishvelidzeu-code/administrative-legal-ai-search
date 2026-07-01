export type LegalProfile = {
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
  summary_for_search?: unknown;
  desired_similarity?: unknown;
  legal_issue?: unknown;
  main_legal_issue?: unknown;
  requested_action?: unknown;
  result?: unknown;
  outcome_type?: unknown;
  appeal_type?: unknown;
  court_branch?: unknown;
  // administrative-specific
  special_law?: unknown;
  administrative_body?: unknown;
  // criminal-specific
  crime_type?: unknown;
  criminal_article?: unknown;
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

export type SearchPayload = {
  category?: unknown;
  sourceTable?: unknown;
  table?: unknown;
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

export function asText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function asTextArray(value: unknown): string[] {
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

export function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.trunc(parsed), 1), 30);
}

export function normalizeCategory(value: unknown): string {
  const category = asText(value);
  if (category === "administrative_cases") return normalizeCategory("administrative");
  if (category === "civil_cases") return normalizeCategory("civil");
  if (category === "criminal_cases") return normalizeCategory("criminal");
  if (category === "ადმინისტრაციული" || category === "administrative") return "ადმინისტრაციული";
  if (category === "სამოქალაქო" || category === "civil") return "სამოქალაქო";
  if (category === "სისხლი" || category === "სისხლის" || category === "criminal") return "სისხლი";
  return category;
}

export function pickProfile(payload: SearchPayload): LegalProfile {
  return payload.aiResult && typeof payload.aiResult === "object"
    ? payload.aiResult
    : payload.legalProfile && typeof payload.legalProfile === "object"
      ? payload.legalProfile
      : {};
}

export function isGenericAdministrativeProfile(profile: LegalProfile): boolean {
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

export function extractDocumentSearchTerms(documentText: unknown): string[] {
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

export function buildCriminalRpcParams(profile: LegalProfile, limit: number) {
  const genericInstitutions = new Set([
    "სისხლი",
    "სისხლის",
    "სისხლის სამართალი",
    "სისხლის სამართლის საქმე",
  ]);

  const legalInstitution = asText(profile.legal_institution);
  const specificInstitution = genericInstitutions.has(legalInstitution.toLowerCase())
    ? ""
    : legalInstitution;

  const articleTerms = [
    ...asTextArray(profile.legal_articles),
    ...asTextArray(profile.criminal_article),
  ].flatMap((article) => article.match(/[0-9¹²³]{2,6}/g) ?? [])
    .slice(0, 10);

  const crimeType = asText(profile.crime_type);

  const strict = asTextArray([
    ...asTextArray(profile.strict_keywords),
    ...asTextArray(profile.must_match_terms),
    specificInstitution,
    crimeType,
    ...asTextArray(profile.criminal_article),
    ...articleTerms,
  ]).slice(0, 14);

  const broad = asTextArray([
    ...asTextArray(profile.broad_keywords),
    ...asTextArray(profile.keywords),
    asText(profile.search_query),
    asText(profile.dispute_subject),
  ]).slice(0, 12);

  return {
    p_strict_keywords:   strict,
    p_broad_keywords:    broad,
    p_dispute_subject:   asText(profile.dispute_subject) || null,
    p_legal_institution: specificInstitution || null,
    p_must_match_terms:  asTextArray(profile.must_match_terms).slice(0, 8),
    p_exclude_terms:     asTextArray(profile.exclude_terms).slice(0, 10),
    p_legal_articles:    asTextArray([...asTextArray(profile.legal_articles), ...asTextArray(profile.criminal_article), ...articleTerms]).slice(0, 12),
    p_limit:             limit,
  };
}
export function buildCivilRpcParams(profile: LegalProfile, limit: number) {
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

export function buildAdministrativeRpcParams(profile: LegalProfile, limit: number, documentText: unknown) {
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
