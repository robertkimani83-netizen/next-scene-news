// VOX254 PHOTO DISCOVERY ENGINE
//
// Finds a free-to-use, legally reusable photo that actually matches a story.
//
// Flow:
//
// AI article analysis
//        ↓
// specific people / places / institutions / event
//        ↓
// multiple photo-search queries
//        ↓
// Wikimedia / Openverse / Pexels / Unsplash
//        ↓
// text/context ranking
//        ↓
// Gemini visual verification
//        ↓
// PERSON + EVENT + LOCATION verification
//        ↓
// highest-ranked verified candidate
//        ↓
// branded VOX254 fallback if nothing trustworthy exists
//
// IMPORTANT:
// A photograph of the correct person is NOT automatically considered a
// photograph of the correct event.
//
// Example:
//
// Article: "Ruto meets regional leaders at State House"
// Candidate: Ruto speaking at State House in 2024
//
// PERSON MATCH: high
// EVENT MATCH: weak
//
// The candidate should be rejected when the story requires the current event.

export interface ArticleEntities {
  people: string[];
  places: string[];
  institutions: string[];
  event: string;
  country?: string;
}

export type PhotoCategory =
  | "politics"
  | "business"
  | "sports"
  | "crime"
  | "kenya"
  | "news";

export interface MatchedPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
  source: string;
  license: string | null;
  credit: string;
  searchQuery: string;
  relevanceScore: number;
  isFallback: boolean;
  fallbackCategory: PhotoCategory | null;
  visionConfidence?: number;
  visionReason?: string;
}

interface Candidate {
  url: string;
  photographer: string;
  photographerUrl: string;
  source: string;
  license: string | null;
  title: string;
  searchQuery: string;
}

interface ScoreResult {
  score: number;
  hasSpecificMatch: boolean;
  eventMatch: boolean;
  personMatch: boolean;
  locationMatch: boolean;
  institutionMatch: boolean;
}

interface RankedCandidate {
  candidate: Candidate;
  score: ScoreResult;
}

const MIN_RELEVANCE_SCORE = 30;

const MAX_CANDIDATES_PER_SOURCE = 5;

// Number of candidates that receive the expensive Gemini image check
// during each search round.
const MAX_CANDIDATES_TO_VERIFY_PER_ROUND = 5;

// ---------------------------------------------------------------------------
// SEARCH ROUNDS
// ---------------------------------------------------------------------------

export interface SearchRound {
  label: string;
  queries: string[];
  requiredConfidence: number;
  personName: string | null;
  requiresCurrentEvent: boolean;
}

export function buildSearchRounds(
  entities: ArticleEntities | null,
  fallbackTerms: string,
  photoSearchQueries: string[] = [],
  photoNeedsCurrentEvent = false
): SearchRound[] {
  const rounds: SearchRound[] = [];
  const country = entities?.country || "Kenya";
  const person = entities?.people?.[0] || null;

  // ---------------------------------------------------------
  // ROUND 1 — AI-GENERATED EXACT EVENT SEARCHES
  // ---------------------------------------------------------
  //
  // These are now the most important queries because ai.ts has
  // already analyzed the article.
  //
  // Example:
  //
  // "William Ruto State House meeting"
  // "William Ruto leaders Nairobi meeting"
  // "William Ruto trade talks Kenya"
  //
  if (photoSearchQueries.length) {
    rounds.push({
      label: "AI exact event searches",
      queries: Array.from(
        new Set(
          photoSearchQueries
            .map((q) => q.trim())
            .filter(Boolean)
        )
      ),
      requiredConfidence: person ? 90 : 80,
      personName: person,
      requiresCurrentEvent: photoNeedsCurrentEvent,
    });
  }

  // ---------------------------------------------------------
  // ROUND 2 — EXACT PERSON + EVENT
  // ---------------------------------------------------------

  if (person) {
    const personQueries: string[] = [];

    if (entities?.event) {
      personQueries.push(`${person} ${entities.event}`);
      personQueries.push(`${person} ${entities.event} ${country}`);
    }

    if (entities?.places?.[0]) {
      personQueries.push(
        `${person} ${entities.places[0]}`
      );
    }

    if (entities?.institutions?.[0]) {
      personQueries.push(
        `${person} ${entities.institutions[0]}`
      );
    }

    // Keep these as fallback person searches, but only after
    // the more exact AI-generated queries.
    personQueries.push(`${person} ${country}`);
    personQueries.push(`${person} official`);

    rounds.push({
      label: "named person and context",
      queries: Array.from(new Set(personQueries)),
      requiredConfidence: 90,
      personName: person,
      requiresCurrentEvent: photoNeedsCurrentEvent,
    });
  }

  // ---------------------------------------------------------
  // ROUND 3 — INSTITUTION / PLACE / EVENT
  // ---------------------------------------------------------

  const contextQueries: string[] = [];

  if (entities?.institutions?.length) {
    const inst = entities.institutions[0];

    if (entities.event) {
      contextQueries.push(`${inst} ${entities.event}`);
    }

    contextQueries.push(`${inst} ${country}`);
    contextQueries.push(`${inst} building`);
  }

  const place = entities?.places?.[0];

  const placeIsJustCountry =
    !!place &&
    place.toLowerCase() === country.toLowerCase();

  if (place && !placeIsJustCountry) {
    if (entities.event) {
      contextQueries.push(`${place} ${entities.event}`);
    }

    contextQueries.push(`${place} ${country}`);
  }

  if (entities?.event) {
    contextQueries.push(`${entities.event} ${country}`);
  }

  if (contextQueries.length) {
    rounds.push({
      label: "institution/place/event",
      queries: Array.from(new Set(contextQueries)),
      requiredConfidence: 80,
      personName: null,
      requiresCurrentEvent: photoNeedsCurrentEvent,
    });
  }

  // ---------------------------------------------------------
  // ROUND 4 — BROAD FALLBACK
  // ---------------------------------------------------------

  if (fallbackTerms) {
    rounds.push({
      label: "broad fallback terms",
      queries: [fallbackTerms],
      requiredConfidence: person ? 90 : 80,
      personName: person,
      requiresCurrentEvent: photoNeedsCurrentEvent,
    });
  }

  return rounds;
}

// ---------------------------------------------------------------------------
// VISION CONTEXT
// ---------------------------------------------------------------------------

function buildVisionContext(
  entities: ArticleEntities | null,
  fallbackTerms: string
): string {
  const parts = [
    entities?.event,
    entities?.people?.slice(0, 3).join(", "),
    entities?.places?.slice(0, 2).join(", "),
    entities?.institutions?.slice(0, 2).join(", "),
    entities?.country,
  ].filter(Boolean);

  return parts.join(" | ") || fallbackTerms;
}

// ---------------------------------------------------------------------------
// TEXT SCORING
// ---------------------------------------------------------------------------

function textIncludes(
  haystack: string,
  needle: string
): boolean {
  if (!needle) return false;

  return haystack
    .toLowerCase()
    .includes(needle.toLowerCase());
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((word) => word.length > 2);
}

const GENERIC_STOCK_WORDS = [
  "stock photo",
  "generic",
  "istock",
  "shutterstock",
  "royalty free",
];

export function scoreCandidate(
  candidate: Candidate,
  entities: ArticleEntities | null,
  fallbackTerms: string
): ScoreResult {
  const text = normalizeText(candidate.title);

  let score = 0;
  let hasSpecificMatch = false;

  let personMatch = false;
  let eventMatch = false;
  let locationMatch = false;
  let institutionMatch = false;

  // ---------------------------------------------------------
  // MAIN PERSON
  // ---------------------------------------------------------

  if (entities?.people?.[0]) {
    const person = entities.people[0];

    if (textIncludes(text, person)) {
      score += 45;
      personMatch = true;
      hasSpecificMatch = true;
    }
  }

  // ---------------------------------------------------------
  // OTHER PEOPLE
  // ---------------------------------------------------------

  if (entities?.people?.slice(1).length) {
    for (const person of entities.people.slice(1, 3)) {
      if (textIncludes(text, person)) {
        score += 20;
        hasSpecificMatch = true;
      }
    }
  }

  // ---------------------------------------------------------
  // EXACT EVENT
  // ---------------------------------------------------------

  if (entities?.event) {
    const eventText = normalizeText(entities.event);
    const eventWords = words(eventText);

    if (textIncludes(text, eventText)) {
      score += 40;
      eventMatch = true;
      hasSpecificMatch = true;
    } else {
      const matchedEventWords = eventWords.filter((word) =>
        text.includes(word)
      );

      if (matchedEventWords.length >= 2) {
        score += 25;
        eventMatch = true;
        hasSpecificMatch = true;
      } else if (matchedEventWords.length === 1) {
        score += 8;
      }
    }
  }

  // ---------------------------------------------------------
  // INSTITUTION
  // ---------------------------------------------------------

  if (entities?.institutions?.length) {
    for (const institution of entities.institutions.slice(0, 2)) {
      if (textIncludes(text, institution)) {
        score += 30;
        institutionMatch = true;
        hasSpecificMatch = true;
        break;
      }
    }
  }

  // ---------------------------------------------------------
  // PLACE
  // ---------------------------------------------------------

  const place = entities?.places?.[0];
  const country = entities?.country;

  const placeIsJustCountry =
    !!place &&
    !!country &&
    place.toLowerCase() === country.toLowerCase();

  if (
    place &&
    !placeIsJustCountry &&
    textIncludes(text, place)
  ) {
    score += 30;
    locationMatch = true;
    hasSpecificMatch = true;
  }

  // ---------------------------------------------------------
  // COUNTRY
  // ---------------------------------------------------------

  if (
    country &&
    textIncludes(text, country)
  ) {
    score += 10;
  } else if (textIncludes(text, "kenya")) {
    score += 10;
  }

  // ---------------------------------------------------------
  // FALLBACK SEARCH TERMS
  // ---------------------------------------------------------

  const fallbackWords = words(fallbackTerms);

  const matchedFallbackWords = fallbackWords.filter(
    (word) => text.includes(word)
  );

  if (matchedFallbackWords.length >= 3) {
    score += 15;
    hasSpecificMatch = true;
  } else if (matchedFallbackWords.length === 2) {
    score += 8;
  }

  // ---------------------------------------------------------
  // GENERIC STOCK PENALTY
  // ---------------------------------------------------------

  if (
    GENERIC_STOCK_WORDS.some((word) =>
      text.includes(word)
    )
  ) {
    score -= 30;
  }

  return {
    score,
    hasSpecificMatch,
    eventMatch,
    personMatch,
    locationMatch,
    institutionMatch,
  };
}

// ---------------------------------------------------------------------------
// SOURCE: WIKIMEDIA COMMONS
// ---------------------------------------------------------------------------

async function searchWikimedia(
  query: string
): Promise<Candidate[]> {
  try {
    const url =
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
      `&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}` +
      `&gsrlimit=${MAX_CANDIDATES_PER_SOURCE}&prop=imageinfo` +
      `&iiprop=url|extmetadata|size&iiurlwidth=1200&format=json&origin=*`;

    const res = await fetch(url);

    if (!res.ok) {
      console.error(
        "Wikimedia lookup failed:",
        await res.text()
      );
      return [];
    }

    const data = await res.json();
    const pages = data.query?.pages;

    if (!pages) return [];

    const candidates: Candidate[] = [];

    for (const key of Object.keys(pages)) {
      const page = pages[key];
      const info = page.imageinfo?.[0];

      if (!info) continue;

      const width = info.width || 0;
      const height = info.height || 0;

      if (width < 400 || height < 300) continue;

      const meta = info.extmetadata || {};

      const licenseShort =
        meta.LicenseShortName?.value || null;

      const artist = (
        meta.Artist?.value ||
        "Wikimedia Commons"
      ).replace(/<[^>]+>/g, "");

      const description = (
        meta.ImageDescription?.value || ""
      ).replace(/<[^>]+>/g, "");

      candidates.push({
        url: info.thumburl || info.url,
        photographer:
          artist || "Wikimedia Commons contributor",
        photographerUrl:
          info.descriptionurl || url,
        source: "Wikimedia Commons",
        license: licenseShort,
        title: `${page.title} ${description}`,
        searchQuery: query,
      });
    }

    return candidates;
  } catch (err) {
    console.error(
      "Wikimedia request failed:",
      err
    );

    return [];
  }
}

// ---------------------------------------------------------------------------
// SOURCE: OPENVERSE
// ---------------------------------------------------------------------------

async function searchOpenverse(
  query: string
): Promise<Candidate[]> {
  try {
    const url =
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
      `&page_size=${MAX_CANDIDATES_PER_SOURCE}` +
      `&license_type=commercial,modification`;

    const res = await fetch(url);

    if (!res.ok) {
      console.error(
        "Openverse lookup failed:",
        await res.text()
      );
      return [];
    }

    const data = await res.json();
    const results = data.results || [];

    return results.map((item: any) => ({
      url: item.url,
      photographer:
        item.creator || "Openverse contributor",
      photographerUrl:
        item.creator_url ||
        item.foreign_landing_url ||
        item.url,
      source: "Openverse",
      license: item.license
        ? item.license.toUpperCase()
        : null,
      title: `${item.title || ""} ${(item.tags || [])
        .map((tag: any) => tag.name)
        .join(" ")}`,
      searchQuery: query,
    }));
  } catch (err) {
    console.error(
      "Openverse request failed:",
      err
    );

    return [];
  }
}

// ---------------------------------------------------------------------------
// SOURCE: PEXELS
// ---------------------------------------------------------------------------

async function searchPexels(
  query: string
): Promise<Candidate[]> {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey) {
    console.warn(
      "PEXELS_API_KEY not set - skipping Pexels"
    );
    return [];
  }

  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(
        query
      )}&per_page=${MAX_CANDIDATES_PER_SOURCE}&orientation=landscape`,
      {
        headers: {
          Authorization: apiKey,
        },
      }
    );

    if (!res.ok) {
      console.error(
        "Pexels lookup failed:",
        await res.text()
      );
      return [];
    }

    const data = await res.json();
    const photos = data.photos || [];

    return photos.map((photo: any) => ({
      url: photo.src.large,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      source: "Pexels",
      license: "Pexels License",
      title: photo.alt || "",
      searchQuery: query,
    }));
  } catch (err) {
    console.error(
      "Pexels request failed:",
      err
    );

    return [];
  }
}

// ---------------------------------------------------------------------------
// SOURCE: UNSPLASH
// ---------------------------------------------------------------------------

async function searchUnsplash(
  query: string
): Promise<Candidate[]> {
  const apiKey = process.env.UNSPLASH_API_KEY;

  if (!apiKey) {
    console.warn(
      "UNSPLASH_API_KEY not set - skipping Unsplash"
    );
    return [];
  }

  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
        query
      )}&per_page=${MAX_CANDIDATES_PER_SOURCE}&orientation=landscape`,
      {
        headers: {
          Authorization: `Client-ID ${apiKey}`,
        },
      }
    );

    if (!res.ok) {
      console.error(
        "Unsplash lookup failed:",
        await res.text()
      );
      return [];
    }

    const data = await res.json();
    const results = data.results || [];

    return results.map((photo: any) => ({
      url: photo.urls.regular,
      photographer: photo.user.name,
      photographerUrl: photo.user.links.html,
      source: "Unsplash",
      license: "Unsplash License",
      title: `${photo.description || ""} ${
        photo.alt_description || ""
      }`,
      searchQuery: query,
    }));
  } catch (err) {
    console.error(
      "Unsplash request failed:",
      err
    );

    return [];
  }
}

// ---------------------------------------------------------------------------
// IMAGE DOWNLOAD FOR GEMINI
// ---------------------------------------------------------------------------

async function downloadAsBase64(
  url: string
): Promise<{
  mimeType: string;
  data: string;
} | null> {
  try {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      6000
    );

    const res = await fetch(url, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return null;

    const contentType =
      res.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {
      return null;
    }

    const buf = Buffer.from(
      await res.arrayBuffer()
    );

    if (buf.byteLength > 8 * 1024 * 1024) {
      return null;
    }

    return {
      mimeType: contentType,
      data: buf.toString("base64"),
    };
  } catch (err) {
    console.error(
      "Image download for vision check failed:",
      err
    );

    return null;
  }
}

// ---------------------------------------------------------------------------
// GEMINI VISION
// ---------------------------------------------------------------------------

interface VisionResult {
  decision: "PASS" | "REJECT";
  confidence: number;

  // Separate scores make debugging the photo engine much easier.
  personMatch: number;
  eventMatch: number;
  locationMatch: number;
  photoTypeMatch: number;

  reason: string;
}

async function verifyImageWithVision(
  imageUrl: string,
  headline: string,
  mainPerson: string | null,
  context: string,
  requiresCurrentEvent = false
): Promise<VisionResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      decision: "REJECT",
      confidence: 0,
      personMatch: 0,
      eventMatch: 0,
      locationMatch: 0,
      photoTypeMatch: 0,
      reason: "GEMINI_API_KEY not set",
    };
  }

  const image = await downloadAsBase64(imageUrl);

  if (!image) {
    return {
      decision: "REJECT",
      confidence: 0,
      personMatch: 0,
      eventMatch: 0,
      locationMatch: 0,
      photoTypeMatch: 0,
      reason: "Image could not be downloaded",
    };
  }

  const prompt = `
You are a STRICT photo editor for VOX254, a Kenyan news organization.

Your job is NOT to decide whether the image is merely related to the topic.

Your job is to decide whether this photograph is accurate enough to publish with THIS SPECIFIC NEWS STORY.

ARTICLE HEADLINE:
"${headline}"

MAIN PERSON:
${mainPerson ? `"${mainPerson}"` : "No specific named person required."}

STORY CONTEXT:
"${context}"

CURRENT-EVENT REQUIREMENT:
${requiresCurrentEvent ? "YES - the photograph should depict the specific event/current situation described by the story." : "NO - a relevant contextual photograph may be acceptable."}

Evaluate these separately:

1. PERSON MATCH
If a named person is required, does the photograph actually show that person?
Do NOT assume that every photograph of a politician is the named person.

2. EVENT MATCH
Does the photograph appear to depict the specific event or incident described by the story?
A generic archive photograph of the same person is NOT an event match.

3. LOCATION MATCH
Does the visible location/environment fit the stated story context?

4. PHOTO TYPE
Is this a genuine photograph suitable for a news article?
Reject:
- memes
- screenshots
- illustrations
- logos
- posters
- text graphics
- protest signs as the main image
- obviously unrelated stock imagery
- animals or objects when a named person is required

5. CURRENTNESS
If CURRENT-EVENT REQUIREMENT is YES, be especially suspicious of generic archive photographs.
Do not claim an image is today's event merely because it contains the same person.

IMPORTANT:
You cannot establish an exact date from pixels alone.
If the photograph itself does not provide evidence of the event, do not invent certainty.

PASS only when the image is genuinely suitable.
When uncertain, REJECT.

Return ONLY JSON:

{
  "decision": "PASS" or "REJECT",
  "confidence": 0-100,
  "personMatch": 0-100,
  "eventMatch": 0-100,
  "locationMatch": 0-100,
  "photoTypeMatch": 0-100,
  "reason": "one short factual sentence"
}
`;

  try {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      9000
    );

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inline_data: {
                    mime_type: image.mimeType,
                    data: image.data,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
      }
    );

    clearTimeout(timer);

    if (!res.ok) {
      console.error(
        "Gemini vision request failed:",
        await res.text()
      );

      return {
        decision: "REJECT",
        confidence: 0,
        personMatch: 0,
        eventMatch: 0,
        locationMatch: 0,
        photoTypeMatch: 0,
        reason: "Vision API request failed",
      };
    }

    const data = await res.json();

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ??
      "{}";

    const parsed = JSON.parse(text);

    const decision =
      parsed.decision === "PASS"
        ? "PASS"
        : "REJECT";

    const confidence =
      typeof parsed.confidence === "number"
        ? parsed.confidence
        : 0;

    const personMatch =
      typeof parsed.personMatch === "number"
        ? parsed.personMatch
        : 0;

    const eventMatch =
      typeof parsed.eventMatch === "number"
        ? parsed.eventMatch
        : 0;

    const locationMatch =
      typeof parsed.locationMatch === "number"
        ? parsed.locationMatch
        : 0;

    const photoTypeMatch =
      typeof parsed.photoTypeMatch === "number"
        ? parsed.photoTypeMatch
        : 0;

    return {
      decision,
      confidence,
      personMatch,
      eventMatch,
      locationMatch,
      photoTypeMatch,
      reason: parsed.reason || "",
    };
  } catch (err) {
    console.error(
      "Gemini vision verification error:",
      err
    );

    return {
      decision: "REJECT",
      confidence: 0,
      personMatch: 0,
      eventMatch: 0,
      locationMatch: 0,
      photoTypeMatch: 0,
      reason: "Vision verification error",
    };
  }
}

// ---------------------------------------------------------------------------
// CREDIT
// ---------------------------------------------------------------------------

function buildCredit(
  c: Candidate
): string {
  if (
    c.source === "Wikimedia Commons" ||
    c.source === "Openverse"
  ) {
    return `Photo: ${c.photographer} / ${c.source}${
      c.license ? `, ${c.license}` : ""
    }`;
  }

  return `Photo: ${c.photographer} / ${c.source}`;
}

// ---------------------------------------------------------------------------
// CONVERT VERIFIED CANDIDATE
// ---------------------------------------------------------------------------

function toMatchedPhoto(
  c: Candidate,
  score: number,
  vision?: VisionResult
): MatchedPhoto {
  return {
    url: c.url,
    photographer: c.photographer,
    photographerUrl: c.photographerUrl,
    source: c.source,
    license: c.license,
    credit: buildCredit(c),
    searchQuery: c.searchQuery,
    relevanceScore: score,
    isFallback: false,
    fallbackCategory: null,

    ...(vision
      ? {
          visionConfidence:
            vision.confidence,
          visionReason:
            `${vision.reason} ` +
            `Person ${vision.personMatch}%, ` +
            `event ${vision.eventMatch}%, ` +
            `location ${vision.locationMatch}%.`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// EXTERNAL ARTICLE OG IMAGE VERIFICATION
// ---------------------------------------------------------------------------

export async function verifyExternalCandidate(
  url: string,
  title: string,
  sourceName: string,
  sourceUrl: string,
  entities: ArticleEntities | null,
  fallbackTerms: string,
  headline: string
): Promise<MatchedPhoto | null> {
  const candidate: Candidate = {
    url,
    photographer: sourceName,
    photographerUrl: sourceUrl,
    source: "Original",
    license: null,
    title,
    searchQuery: fallbackTerms,
  };

  const textResult = scoreCandidate(
    candidate,
    entities,
    fallbackTerms
  );

  if (
    textResult.score < MIN_RELEVANCE_SCORE ||
    !textResult.hasSpecificMatch
  ) {
    return null;
  }

  const person =
    entities?.people?.[0] || null;

  const requiredConfidence =
    person ? 90 : 80;

  const requiresCurrentEvent =
    Boolean(entities?.event);

  const context = buildVisionContext(
    entities,
    fallbackTerms
  );

  const vision =
    await verifyImageWithVision(
      url,
      headline || fallbackTerms,
      person,
      context,
      requiresCurrentEvent
    );

  if (
    vision.decision === "PASS" &&
    vision.confidence >= requiredConfidence
  ) {
    return toMatchedPhoto(
      candidate,
      textResult.score,
      vision
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// FALLBACK CATEGORY
// ---------------------------------------------------------------------------

export function detectFallbackCategory(
  entities: ArticleEntities | null,
  fallbackTerms: string
): PhotoCategory {
  const text =
    `${entities?.event || ""} ${fallbackTerms}`
      .toLowerCase();

  if (
    /(election|president|parliament|senator|mp |governor|cabinet|policy)/
      .test(text)
  ) {
    return "politics";
  }

  if (
    /(economy|market|business|trade|shilling|bank|investment|company)/
      .test(text)
  ) {
    return "business";
  }

  if (
    /(football|rugby|athletics|match|tournament|olympic|sport)/
      .test(text)
  ) {
    return "sports";
  }

  if (
    /(murder|robbery|arrest|police|crime|court|jail|fraud)/
      .test(text)
  ) {
    return "crime";
  }

  if (
    entities?.country === "Kenya" ||
    text.includes("kenya")
  ) {
    return "kenya";
  }

  return "news";
}

// ---------------------------------------------------------------------------
// RANKING
// ---------------------------------------------------------------------------
//
// This replaces the old random shuffle.
//
// The strongest candidate gets checked first.
//
// Ranking priority:
//
// Exact event/context   → strongest
// Main person
// Institution
// Location
// Other people
// Country
//
// Source reliability is used as a tie-breaker only.
// We do NOT allow a source to compensate for a poor story match.

function sourceReliability(
  source: string
): number {
  switch (source) {
    case "Wikimedia Commons":
      return 10;

    case "Openverse":
      return 9;

    case "Pexels":
      return 7;

    case "Unsplash":
      return 7;

    default:
      return 5;
  }
}

function rankCandidate(
  item: RankedCandidate
): number {
  let rank = item.score.score * 10;

  if (item.score.eventMatch) {
    rank += 350;
  }

  if (item.score.personMatch) {
    rank += 250;
  }

  if (item.score.locationMatch) {
    rank += 150;
  }

  if (item.score.institutionMatch) {
    rank += 100;
  }

  rank += sourceReliability(
    item.candidate.source
  );

  return rank;
}

// ---------------------------------------------------------------------------
// FALLBACK POSTER
// ---------------------------------------------------------------------------

function brandedFallback(
  entities: ArticleEntities | null,
  fallbackTerms: string
): MatchedPhoto {
  const category =
    detectFallbackCategory(
      entities,
      fallbackTerms
    );

  return {
    url: "",
    photographer: "VOX254",
    photographerUrl: "",
    source: "VOX254",
    license: null,
    credit: "VOX254",
    searchQuery: fallbackTerms,
    relevanceScore: 0,
    isFallback: true,
    fallbackCategory: category,
  };
}

// ---------------------------------------------------------------------------
// MAIN PHOTO MATCHER
// ---------------------------------------------------------------------------
//
// The fourth parameter is optional so your existing cron code does NOT
// immediately break.
//
// Once we update the cron route, it will pass:
//
// rewritten.photoSearchQueries
//
// and:
//
// rewritten.photoNeedsCurrentEvent
//
// into this function.

export async function findMatchingPhoto(
  fallbackTerms: string,
  entities: ArticleEntities | null = null,
  headline: string = "",
  photoSearchQueries: string[] = [],
  photoNeedsCurrentEvent = false
): Promise<MatchedPhoto> {
  const rounds = buildSearchRounds(
    entities,
    fallbackTerms,
    photoSearchQueries,
    photoNeedsCurrentEvent
  );

  const context = buildVisionContext(
    entities,
    fallbackTerms
  );

  for (const round of rounds) {
    const searchPromises: Promise<Candidate[]>[] = [];

    for (const query of round.queries) {
      searchPromises.push(
        searchWikimedia(query)
      );

      searchPromises.push(
        searchOpenverse(query)
      );

      searchPromises.push(
        searchPexels(query)
      );

      searchPromises.push(
        searchUnsplash(query)
      );
    }

    const results =
      await Promise.all(searchPromises);

    const allCandidates =
      results.flat();

    if (!allCandidates.length) {
      continue;
    }

    // -------------------------------------------------------
    // REMOVE DUPLICATES
    // -------------------------------------------------------

    const uniqueCandidates =
      Array.from(
        new Map(
          allCandidates.map(
            (candidate) => [
              candidate.url,
              candidate,
            ]
          )
        ).values()
      );

    // -------------------------------------------------------
    // TEXT / CONTEXT SCORING
    // -------------------------------------------------------

    const qualifying: RankedCandidate[] =
      uniqueCandidates
        .map((candidate) => {
          const score =
            scoreCandidate(
              candidate,
              entities,
              fallbackTerms
            );

          return {
            candidate,
            score,
          };
        })
        .filter(
          (item) =>
            item.score.score >=
              MIN_RELEVANCE_SCORE &&
            item.score.hasSpecificMatch
        );

    if (!qualifying.length) {
      continue;
    }

    // -------------------------------------------------------
    // INTELLIGENT RANKING
    // -------------------------------------------------------

    qualifying.sort(
      (a, b) =>
        rankCandidate(b) -
        rankCandidate(a)
    );

    const candidatesToVerify =
      qualifying.slice(
        0,
        MAX_CANDIDATES_TO_VERIFY_PER_ROUND
      );

    console.log(
      `[VOX254 PHOTO] Round "${round.label}" ` +
        `found ${qualifying.length} qualifying candidates. ` +
        `Verifying top ${candidatesToVerify.length}.`
    );

    // -------------------------------------------------------
    // GEMINI VISUAL VERIFICATION
    // -------------------------------------------------------

    for (const item of candidatesToVerify) {
      const vision =
        await verifyImageWithVision(
          item.candidate.url,
          headline || fallbackTerms,
          round.personName,
          context,
          round.requiresCurrentEvent
        );

      console.log(
        `[VOX254 PHOTO] ${item.candidate.source} | ` +
          `${item.candidate.searchQuery} | ` +
          `text=${item.score.score} | ` +
          `person=${vision.personMatch} | ` +
          `event=${vision.eventMatch} | ` +
          `location=${vision.locationMatch} | ` +
          `confidence=${vision.confidence} | ` +
          `${vision.decision}`
      );

      if (
        vision.decision !== "PASS" ||
        vision.confidence <
          round.requiredConfidence
      ) {
        continue;
      }

      // -----------------------------------------------------
      // EXTRA EVENT SAFETY CHECK
      // -----------------------------------------------------
      //
      // If the story explicitly requires the current event,
      // do not allow a candidate through merely because the
      // person was recognized.
      //
      if (
        round.requiresCurrentEvent &&
        entities?.event &&
        vision.eventMatch < 70
      ) {
        console.log(
          `[VOX254 PHOTO] Rejected despite overall PASS: ` +
            `event match too weak (${vision.eventMatch}%).`
        );

        continue;
      }

      // -----------------------------------------------------
      // PERSON SAFETY CHECK
      // -----------------------------------------------------

      if (
        round.personName &&
        vision.personMatch < 85
      ) {
        console.log(
          `[VOX254 PHOTO] Rejected: person match too weak ` +
            `(${vision.personMatch}%).`
        );

        continue;
      }

      return toMatchedPhoto(
        item.candidate,
        item.score.score,
        vision
      );
    }

    // No verified winner in this round.
    // Continue to the next search round.
  }

  // ---------------------------------------------------------
  // NOTHING TRUSTWORTHY FOUND
  // ---------------------------------------------------------

  console.log(
    "[VOX254 PHOTO] No verified photograph found. " +
      "Using branded VOX254 fallback."
  );

  return brandedFallback(
    entities,
    fallbackTerms
  );
}
