// Finds a free-to-use, legally reusable photo that actually matches a story's
// content - not just the first result from one source.
//
// Flow: build several targeted search queries from the article's extracted
// entities (person / place / institution / event) -> search Wikimedia
// Commons, Openverse, Pexels and Unsplash in parallel -> score every
// candidate against the entities -> keep the best one if it clears the
// minimum relevance bar -> otherwise fall through to a branded VOX254
// poster showing the story's own headline. Never returns null - the caller
// always gets *something* to display, but low-quality/unrelated photos
// never win out over an honest branded fallback.
//
// All four sources are free and keyless or free-tier: Wikimedia Commons and
// Openverse need no API key at all; Pexels/Unsplash use the existing keys.

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

// Minimum score a candidate must clear to be used as the real article photo.
// Below this we treat it as "not actually a match" and fall through to the
// branded poster instead of using a weak/coincidental hit.
const MIN_RELEVANCE_SCORE = 30;

const MAX_CANDIDATES_PER_SOURCE = 5;

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

export function generateSearchQueries(
  entities: ArticleEntities | null,
  fallbackTerms: string
): string[] {
  const queries: string[] = [];
  const country = entities?.country || "Kenya";

  if (entities?.people?.length) {
    const mainPerson = entities.people[0];
    queries.push(`${mainPerson} ${country}`);
    queries.push(`${mainPerson} speech`);
  }

  if (entities?.institutions?.length) {
    const inst = entities.institutions[0];
    queries.push(`${inst} ${country}`);
    queries.push(`${inst} building`);
  }

  if (entities?.places?.length) {
    const place = entities.places[0];
    queries.push(`${place} ${country}`);
  }

  if (entities?.event) {
    queries.push(`${entities.event} ${country}`);
  }

  if (fallbackTerms) {
    queries.push(fallbackTerms);
  }

  return Array.from(new Set(queries)).slice(0, 4);
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
): number {
  const text = candidate.title.toLowerCase();
  let score = 0;

  if (entities?.people?.[0] && textIncludes(text, entities.people[0])) {
    score += 50;
  }
  if (entities?.people?.[1] && textIncludes(text, entities.people[1])) {
    score += 35;
  }
  if (
    entities?.institutions?.[0] &&
    textIncludes(text, entities.institutions[0])
  ) {
    score += 40;
  }
  if (entities?.places?.[0] && textIncludes(text, entities.places[0])) {
    score += 30;
  }
  if (entities?.event && textIncludes(text, entities.event)) {
    score += 30;
  }
  if (entities?.country && textIncludes(text, entities.country)) {
    score += 15;
  } else if (textIncludes(text, "kenya")) {
    score += 15;
  }

  const fallbackWords = fallbackTerms
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const matchedWords = fallbackWords.filter((w) => text.includes(w));
  if (matchedWords.length >= 2) score += 20;

  if (GENERIC_STOCK_WORDS.some((w) => text.includes(w))) {
    score -= 30;
  }

  return score;
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

function toMatchedPhoto(c: Candidate, score: number): MatchedPhoto {
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
  };
}

// Validates a candidate that came from elsewhere (e.g. the article's own
// og:image) using the same scoring system as everything else, instead of
// trusting it blindly. Used by the cron route so a wrong og:image (a logo,
// an unrelated stock photo) can no longer bypass scoring entirely.
export function scoreExternalCandidate(
  url: string,
  title: string,
  sourceName: string,
  sourceUrl: string,
  entities: ArticleEntities | null,
  fallbackTerms: string
): MatchedPhoto {
  const candidate: Candidate = {
    url,
    photographer: sourceName,
    photographerUrl: sourceUrl,
    source: "Original",
    license: null,
    title,
    searchQuery: fallbackTerms,
  };
  const score = scoreCandidate(candidate, entities, fallbackTerms);
  return toMatchedPhoto(candidate, score);
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

export async function findMatchingPhoto(
  fallbackTerms: string,
  entities: ArticleEntities | null = null
): Promise<MatchedPhoto> {
  const queries = generateSearchQueries(entities, fallbackTerms);

  const searchPromises: Promise<Candidate[]>[] = [];
  for (const query of queries) {
    searchPromises.push(searchWikimedia(query));
    searchPromises.push(searchOpenverse(query));
    searchPromises.push(searchPexels(query));
    searchPromises.push(searchUnsplash(query));
  }

  const results = await Promise.all(searchPromises);
  const allCandidates = results.flat();

  if (allCandidates.length > 0) {
    const scored = allCandidates.map((c) => ({
      candidate: c,
      score: scoreCandidate(c, entities, fallbackTerms),
    }));
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score >= MIN_RELEVANCE_SCORE) {
      return toMatchedPhoto(best.candidate, best.score);
    }
    // Below the bar - a weak, coincidental match (e.g. only matched on
    // "Kenya") is worse than an honest branded poster, so fall through
    // to the placeholder below rather than using it.
  }

  // Nothing usable cleared the bar - branded category poster instead.
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
