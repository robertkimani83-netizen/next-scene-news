// Finds a free-to-use, legally reusable photo that actually matches a story's
// content - not just the first result from one source.
//
// Flow: build several targeted search queries from the article's extracted
// entities (person / place / institution / event) -> search Wikimedia
// Commons, Openverse, Pexels and Unsplash in parallel -> score every
// candidate against the entities -> keep the best one only if it BOTH
// clears the minimum score AND matched a specific signal (a named person,
// institution, place, or event - not just the country name) -> otherwise
// fall through to a branded VOX254 poster showing the story's own headline.
// Never returns null - the caller always gets *something* to display, but
// low-quality/unrelated photos never win out over an honest branded
// fallback.
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
