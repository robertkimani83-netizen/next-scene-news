// Finds a free-to-use, legally reusable photo that actually matches a story's
// content - not just the first result from one source.
//
// Flow: run escalating SEARCH ROUNDS (exact named person first, then
// institution/place/event context, then broad fallback terms) against
// Wikimedia Commons, Openverse, Pexels and Unsplash -> text-score every
// candidate against the entities (context verification) -> for any
// candidate that clears the text bar, send the actual image pixels to
// Gemini vision for a strict PASS/REJECT + confidence check (visual
// verification) -> a candidate only wins if BOTH checks pass, with a
// higher confidence bar (90%) required when the claim is "this is a photo
// of a specific named person" than for institution/place/event claims
// (80%) -> the first round that produces a verified winner stops the
// search; if every round is exhausted with nothing verified, fall through
// to a branded VOX254 poster showing the story's own headline. Never
// returns null - the caller always gets *something* to display, but a
// wrong photo (wrong person, an animal standing in for a person, a
// protest sign, a stale archive photo) is never allowed to win out over
// an honest branded fallback just because it existed.
//
// All four sources are free and keyless or free-tier: Wikimedia Commons and
// Openverse need no API key at all; Pexels/Unsplash use the existing keys.
// Vision verification reuses the existing GEMINI_API_KEY (free tier).

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
  source: string; // "Wikimedia Commons" | "Openverse" | "Pexels" | "Unsplash" | "Original"
  license: string | null;
  credit: string;
  searchQuery: string;
  relevanceScore: number;
  isFallback: boolean;
  fallbackCategory: PhotoCategory | null;
  // Set only for real photos that passed Gemini vision verification -
  // absent/undefined for older stored articles from before this existed,
  // and for the branded fallback poster (nothing to verify there).
  visionConfidence?: number;
  visionReason?: string;
}

interface Candidate {
  url: string;
  photographer: string;
  photographerUrl: string;
  source: string;
  license: string | null;
  title: string; // used for scoring - image title/description/tags joined
  searchQuery: string;
}

interface ScoreResult {
  score: number;
  hasSpecificMatch: boolean;
}

// Minimum score a candidate must clear to be used as the real article photo.
// Below this, or without a specific entity match, we fall through to the
// branded poster instead of using a weak/coincidental hit.
const MIN_RELEVANCE_SCORE = 30;

const MAX_CANDIDATES_PER_SOURCE = 5;

// ---------------------------------------------------------------------------
// Search rounds - escalating from "exact named person" to broad fallback.
// Each round only runs if the previous one produced no verified winner, so
// a well-covered story (a well-known politician) resolves fast on round 1
// without ever spending a broader/vision budget on later rounds.
// ---------------------------------------------------------------------------

export interface SearchRound {
  label: string;
  queries: string[];
  // Confidence Gemini vision must reach for a candidate in this round to
  // win. Higher for "this is a photo of a specific named person" claims
  // than for institution/place/event claims, since vision can misjudge an
  // unfamiliar face far more easily than it can spot "this is a building".
  requiredConfidence: number;
  personName: string | null;
}

export function buildSearchRounds(
  entities: ArticleEntities | null,
  fallbackTerms: string
): SearchRound[] {
  const rounds: SearchRound[] = [];
  const country = entities?.country || "Kenya";
  const person = entities?.people?.[0] || null;

  if (person) {
    rounds.push({
      label: "named person",
      queries: Array.from(
        new Set([`${person} ${country}`, `${person} speech`, `${person} press conference`])
      ),
      requiredConfidence: 90,
      personName: person,
    });
  }

  const contextQueries: string[] = [];
  if (entities?.institutions?.length) {
    const inst = entities.institutions[0];
    contextQueries.push(`${inst} ${country}`);
    contextQueries.push(`${inst} building`);
  }
  const place = entities?.places?.[0];
  const placeIsJustCountry =
    !!place && place.toLowerCase() === country.toLowerCase();
  if (place && !placeIsJustCountry) {
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
    });
  }

  if (fallbackTerms) {
    rounds.push({
      label: "broad fallback terms",
      queries: [fallbackTerms],
      requiredConfidence: 80,
      personName: null,
    });
  }

  return rounds;
}

function buildVisionContext(
  entities: ArticleEntities | null,
  fallbackTerms: string
): string {
  return (
    [entities?.institutions?.[0], entities?.places?.[0], entities?.event]
      .filter(Boolean)
      .join(", ") || fallbackTerms
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function textIncludes(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
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
  const text = candidate.title.toLowerCase();
  let score = 0;
  let hasSpecificMatch = false;

  if (entities?.people?.[0] && textIncludes(text, entities.people[0])) {
    score += 50;
    hasSpecificMatch = true;
  }
  if (entities?.people?.[1] && textIncludes(text, entities.people[1])) {
    score += 35;
    hasSpecificMatch = true;
  }
  if (
    entities?.institutions?.[0] &&
    textIncludes(text, entities.institutions[0])
  ) {
    score += 40;
    hasSpecificMatch = true;
  }

  const place = entities?.places?.[0];
  const country = entities?.country;
  const placeIsJustCountry =
    !!place && !!country && place.toLowerCase() === country.toLowerCase();

  if (place && !placeIsJustCountry && textIncludes(text, place)) {
    score += 30;
    hasSpecificMatch = true;
  }
  if (entities?.event && textIncludes(text, entities.event)) {
    score += 30;
    hasSpecificMatch = true;
  }

  // Country match alone is never a "specific" signal - it's too generic
  // (a vulture photo tagged "Kenya" is not a rice-controversy photo).
  if (country && textIncludes(text, country)) {
    score += 15;
  } else if (textIncludes(text, "kenya")) {
    score += 15;
  }

  const fallbackWords = fallbackTerms
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const matchedWords = fallbackWords.filter((w) => text.includes(w));
  if (matchedWords.length >= 3) {
    score += 15;
    hasSpecificMatch = true;
  }

  if (GENERIC_STOCK_WORDS.some((w) => text.includes(w))) {
    score -= 30;
  }

  return { score, hasSpecificMatch };
}

// ---------------------------------------------------------------------------
// Source: Wikimedia Commons (free, keyless)
// ---------------------------------------------------------------------------

async function searchWikimedia(query: string): Promise<Candidate[]> {
  try {
    const url =
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
      `&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}` +
      `&gsrlimit=${MAX_CANDIDATES_PER_SOURCE}&prop=imageinfo` +
      `&iiprop=url|extmetadata|size&iiurlwidth=1200&format=json&origin=*`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error("Wikimedia lookup failed:", await res.text());
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
      const licenseShort = meta.LicenseShortName?.value || null;
      const artist = (meta.Artist?.value || "Wikimedia Commons").replace(
        /<[^>]+>/g,
        ""
      );
      const description = (meta.ImageDescription?.value || "").replace(
        /<[^>]+>/g,
        ""
      );

      candidates.push({
        url: info.thumburl || info.url,
        photographer: artist || "Wikimedia Commons contributor",
        photographerUrl: info.descriptionurl || url,
        source: "Wikimedia Commons",
        license: licenseShort,
        title: `${page.title} ${description}`,
        searchQuery: query,
      });
    }
    return candidates;
  } catch (err) {
    console.error("Wikimedia request failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source: Openverse (free, keyless)
// ---------------------------------------------------------------------------

async function searchOpenverse(query: string): Promise<Candidate[]> {
  try {
    const url =
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
      `&page_size=${MAX_CANDIDATES_PER_SOURCE}&license_type=commercial,modification`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error("Openverse lookup failed:", await res.text());
      return [];
    }

    const data = await res.json();
    const results = data.results || [];

    return results.map((item: any) => ({
      url: item.url,
      photographer: item.creator || "Openverse contributor",
      photographerUrl: item.creator_url || item.foreign_landing_url || item.url,
      source: "Openverse",
      license: item.license ? item.license.toUpperCase() : null,
      title: `${item.title || ""} ${(item.tags || [])
        .map((t: any) => t.name)
        .join(" ")}`,
      searchQuery: query,
    }));
  } catch (err) {
    console.error("Openverse request failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source: Pexels (free tier, existing key)
// ---------------------------------------------------------------------------

async function searchPexels(query: string): Promise<Candidate[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn("PEXELS_API_KEY not set - skipping Pexels photo search");
    return [];
  }

  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(
        query
      )}&per_page=${MAX_CANDIDATES_PER_SOURCE}&orientation=landscape`,
      { headers: { Authorization: apiKey } }
    );

    if (!res.ok) {
      console.error("Pexels lookup failed:", await res.text());
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
    console.error("Pexels request failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source: Unsplash (free tier, existing key)
// ---------------------------------------------------------------------------

async function searchUnsplash(query: string): Promise<Candidate[]> {
  const apiKey = process.env.UNSPLASH_API_KEY;
  if (!apiKey) {
    console.warn("UNSPLASH_API_KEY not set - skipping Unsplash photo search");
    return [];
  }

  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
        query
      )}&per_page=${MAX_CANDIDATES_PER_SOURCE}&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${apiKey}` } }
    );

    if (!res.ok) {
      console.error("Unsplash lookup failed:", await res.text());
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
      title: `${photo.description || ""} ${photo.alt_description || ""}`,
      searchQuery: query,
    }));
  } catch (err) {
    console.error("Unsplash request failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vision verification - looks at the actual image pixels, not just its tags.
// This is what catches a vulture tagged "Nairobi", a protest sign that
// happens to contain a name, or a decades-old archive photo being used for
// a current story - none of which the text scorer above can see.
// ---------------------------------------------------------------------------

interface VisionResult {
  decision: "PASS" | "REJECT";
  confidence: number;
  reason: string;
}

async function downloadAsBase64(
  url: string
): Promise<{ mimeType: string; data: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    // Cap size so a huge image can't slow the verification call down.
    if (buf.byteLength > 8 * 1024 * 1024) return null;

    return { mimeType: contentType, data: buf.toString("base64") };
  } catch (err) {
    console.error("Image download for vision check failed:", err);
    return null;
  }
}

async function verifyImageWithVision(
  imageUrl: string,
  headline: string,
  mainPerson: string | null,
  context: string
): Promise<VisionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  // Fail closed: with no way to verify, never trust an unverified photo.
  if (!apiKey) {
    return { decision: "REJECT", confidence: 0, reason: "GEMINI_API_KEY not set" };
  }

  const image = await downloadAsBase64(imageUrl);
  if (!image) {
    return { decision: "REJECT", confidence: 0, reason: "Image could not be downloaded" };
  }

  const prompt = `You are a strict photo editor for VOX254, a Kenyan news site. Look at the attached image and decide whether it is an honest, accurate photograph to run alongside this story.

HEADLINE: "${headline}"
${mainPerson ? `NAMED PERSON THE PHOTO MUST SHOW: "${mainPerson}"` : "(no specific named person is required for this photo)"}
CONTEXT: "${context}"

Checks:
1. If a named person is given, does the image actually show a real photograph of a human being consistent with that context (NOT an animal, object, logo, or a different/unclear person)?
2. Is the image primarily a screenshot, meme, protest sign/banner, illustration, or text graphic rather than a real photograph?
3. Does this look like an old black-and-white or archive-style photo being used for a current, present-day story?
4. Does the image misleadingly suggest something the headline does not actually say?

If any check fails, REJECT. Respond with ONLY valid JSON, no markdown fences, no extra text:
{"decision": "PASS" or "REJECT", "confidence": 0-100, "reason": "one short sentence"}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: image.mimeType, data: image.data } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      console.error("Gemini vision request failed:", await res.text());
      return { decision: "REJECT", confidence: 0, reason: "Vision API request failed" };
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);

    const decision = parsed.decision === "PASS" ? "PASS" : "REJECT";
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;
    return { decision, confidence, reason: parsed.reason || "" };
  } catch (err) {
    console.error("Gemini vision verification error:", err);
    return { decision: "REJECT", confidence: 0, reason: "Vision verification error" };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function buildCredit(c: Candidate): string {
  if (c.source === "Wikimedia Commons" || c.source === "Openverse") {
    return `Photo: ${c.photographer} / ${c.source}${
      c.license ? `, ${c.license}` : ""
    }`;
  }
  return `Photo: ${c.photographer} / ${c.source}`;
}

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
      ? { visionConfidence: vision.confidence, visionReason: vision.reason }
      : {}),
  };
}

// Validates a candidate that came from elsewhere (e.g. the article's own
// og:image) through the SAME two-step check as every other candidate:
// text/context scoring first, then Gemini vision on the actual pixels.
// Used by the cron route so a wrong og:image (a logo, an unrelated stock
// photo, a screenshot) can no longer bypass verification just because it
// came from the source article's own page. Returns null if it doesn't
// clear both bars, so the caller falls through to the normal search.
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

  const textResult = scoreCandidate(candidate, entities, fallbackTerms);
  if (textResult.score < MIN_RELEVANCE_SCORE || !textResult.hasSpecificMatch) {
    return null;
  }

  const person = entities?.people?.[0] || null;
  const requiredConfidence = person ? 90 : 80;
  const context = buildVisionContext(entities, fallbackTerms);

  const vision = await verifyImageWithVision(
    url,
    headline || fallbackTerms,
    person,
    context
  );

  if (vision.decision === "PASS" && vision.confidence >= requiredConfidence) {
    return toMatchedPhoto(candidate, textResult.score, vision);
  }
  return null;
}

// Maps a story's category/topic to one of the branded fallback identities.
// Kept intentionally simple (keyword match) since this only decides which
// branded placeholder style to show, not which real photo to use.
export function detectFallbackCategory(
  entities: ArticleEntities | null,
  fallbackTerms: string
): PhotoCategory {
  const text = `${entities?.event || ""} ${fallbackTerms}`.toLowerCase();

  if (/(election|president|parliament|senator|mp |governor|cabinet|policy)/.test(text)) {
    return "politics";
  }
  if (/(economy|market|business|trade|shilling|bank|investment|company)/.test(text)) {
    return "business";
  }
  if (/(football|rugby|athletics|match|tournament|olympic|sport)/.test(text)) {
    return "sports";
  }
  if (/(murder|robbery|arrest|police|crime|court|jail|fraud)/.test(text)) {
    return "crime";
  }
  if (entities?.country === "Kenya" || text.includes("kenya")) {
    return "kenya";
  }
  return "news";
}

// Cap on how many text-scored candidates get an (expensive) vision check
// per round - keeps a single cron run within Vercel's function time budget
// instead of vision-checking every candidate from every source.
const MAX_CANDIDATES_TO_VERIFY_PER_ROUND = 3;

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function brandedFallback(
  entities: ArticleEntities | null,
  fallbackTerms: string
): MatchedPhoto {
  const category = detectFallbackCategory(entities, fallbackTerms);
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

export async function findMatchingPhoto(
  fallbackTerms: string,
  entities: ArticleEntities | null = null,
  headline: string = ""
): Promise<MatchedPhoto> {
  const rounds = buildSearchRounds(entities, fallbackTerms);
  const context = buildVisionContext(entities, fallbackTerms);

  for (const round of rounds) {
    const searchPromises: Promise<Candidate[]>[] = [];
    for (const query of round.queries) {
      searchPromises.push(searchWikimedia(query));
      searchPromises.push(searchOpenverse(query));
      searchPromises.push(searchPexels(query));
      searchPromises.push(searchUnsplash(query));
    }

    const results = await Promise.all(searchPromises);
    const allCandidates = results.flat();
    if (!allCandidates.length) continue;

    // Context verification (text/tags) first - cheap, filters out most of
    // the noise before we ever spend a vision call.
    const qualifying = allCandidates
      .map((c) => {
        const result = scoreCandidate(c, entities, fallbackTerms);
        return { candidate: c, score: result.score, hasSpecificMatch: result.hasSpecificMatch };
      })
      .filter((s) => s.score >= MIN_RELEVANCE_SCORE && s.hasSpecificMatch);

    // Shuffle rather than always taking the single top-scored candidate -
    // search engines tend to return the same top result for the same
    // query, so always verifying the highest score first meant the same
    // person (e.g. a well-covered figure like the president) kept getting
    // the exact same photo on every article. Every candidate here already
    // cleared the same relevance bar, so picking among them at random
    // doesn't lower quality - it just adds visual variety.
    const scored = shuffle(qualifying).slice(0, MAX_CANDIDATES_TO_VERIFY_PER_ROUND);

    // Visual verification - stop at the first shuffled candidate that
    // actually passes instead of checking all of them.
    for (const s of scored) {
      const vision = await verifyImageWithVision(
        s.candidate.url,
        headline || fallbackTerms,
        round.personName,
        context
      );
      if (vision.decision === "PASS" && vision.confidence >= round.requiredConfidence) {
        return toMatchedPhoto(s.candidate, s.score, vision);
      }
    }
    // Nothing in this round passed both checks - escalate to the next,
    // broader round rather than settling for a rejected candidate.
  }

  // Every round exhausted with nothing verified - branded poster instead.
  return brandedFallback(entities, fallbackTerms);
}
