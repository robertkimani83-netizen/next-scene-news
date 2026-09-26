import type { RewrittenArticle } from "./ai";
import type { MatchedPhoto } from "./photos";
import { StoryMatcher } from "./story-dedupe";

// Uses Upstash Redis's free REST API instead of a local file. Vercel's
// servers reset their filesystem on every request, so a JSON file (the
// original approach) can never actually persist - this fixes that with a
// real (and still free, no-card) database.

export interface StoredArticle extends RewrittenArticle {
  id: string;
  link: string;
  sourceName: string;
  publishedAt: string;
  photo: MatchedPhoto | null;
  postedTo: { facebook: boolean; instagram: boolean; x: boolean };
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "next-scene-news:articles";

const SEEN_LINKS_KEY = "next-scene-news:seen-links";

// Strict read: THROWS if Redis can't be read. Anything that writes the
// article list, or decides what is "new", must use this. The old lenient
// read returned [] on a hiccup, which made every RSS item look new (new
// random IDs -> reposted to Facebook) and let addArticle overwrite the
// whole store with a single article.
async function redisGetStrict(): Promise<StoredArticle[]> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set");
  }

  const res = await fetch(`${REDIS_URL}/get/${KEY}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Article store read failed: HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(`Article store read failed: ${data.error}`);
  if (!data.result) return [];

  const parsed = JSON.parse(data.result);
  if (!Array.isArray(parsed)) throw new Error("Article store is not an array");
  return parsed as StoredArticle[];
}

// Lenient read for public pages: a Redis blip shows an empty page rather
// than a crash. Never use this for pipeline decisions.
async function redisGet(): Promise<StoredArticle[]> {
  try {
    return await redisGetStrict();
  } catch {
    return [];
  }
}

/** Pipeline-safe load: throws instead of pretending the store is empty. */
export async function loadArticlesStrict(): Promise<StoredArticle[]> {
  return redisGetStrict();
}

async function redisCommand(command: (string | number)[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set");
  }
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis ${command[0]} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Redis ${command[0]} failed: ${data.error}`);
  return data.result;
}

/**
 * Permanent memory of every source link ever processed. The article list
 * only keeps the newest 200, so without this an older story still sitting
 * in an RSS feed would be re-ingested under a fresh ID and posted again.
 */
export async function filterUnseenLinks(links: string[]): Promise<Set<string>> {
  if (!links.length) return new Set();
  const flags: number[] = await redisCommand(["SMISMEMBER", SEEN_LINKS_KEY, ...links]);
  return new Set(links.filter((_, i) => !flags[i]));
}

export async function markLinksSeen(links: string[]): Promise<void> {
  if (!links.length) return;
  await redisCommand(["SADD", SEEN_LINKS_KEY, ...links]);
}

/** Batch GET of many keys in one request. Throws on failure (fail closed). */
export async function redisMget(keys: string[]): Promise<(string | null)[]> {
  if (!keys.length) return [];
  return redisCommand(["MGET", ...keys]);
}

async function redisSet(articles: StoredArticle[]): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set");
  }

  await fetch(`${REDIS_URL}/set/${KEY}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(articles),
  });
}

export async function loadArticles(): Promise<StoredArticle[]> {
  return redisGet();
}

function normalizeHeadlineWords(value: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for",
    "with", "as", "at", "by", "from", "into", "over", "after", "before",
    "is", "are", "was", "were", "has", "have", "had", "will", "can",
    "new", "says", "say", "report", "reports", "latest", "update", "kenya",
  ]);

  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter((word) => word.length >= 3 && !stopWords.has(word))
    )
  );
}

export function areLikelyDuplicateHeadlines(a: string, b: string): boolean {
  const aWords = normalizeHeadlineWords(a);
  const bWords = normalizeHeadlineWords(b);

  if (!aWords.length || !bWords.length) return false;

  const aSet = new Set(aWords);
  const bSet = new Set(bWords);

  const intersection = aWords.filter((word) => bSet.has(word)).length;
  const smaller = Math.min(aSet.size, bSet.size);
  const larger = Math.max(aSet.size, bSet.size);

  if (intersection === smaller && smaller >= 3) return true;

  const containment = intersection / smaller;
  const jaccard = intersection / larger;

  // High overlap catches the same story rewritten by different RSS outlets
  // even when their URLs and exact headlines are different.
  return containment >= 0.85 || jaccard >= 0.72;
}

export function getUsedPhotoUrls(articles: StoredArticle[]): Set<string> {
  const urls = new Set<string>();

  for (const article of articles) {
    const url = article.photo?.url;
    const soft = article.photo?.softBackgroundUrl;

    if (url && !url.includes("/api/og/")) urls.add(url);
    if (soft && !soft.includes("/api/og/")) urls.add(soft);
  }

  return urls;
}

// Same-story window: a rewrite of an event already stored within this many
// hours is dropped. Follow-up stories days later are still allowed.
export const STORY_DEDUPE_WINDOW_HOURS = 72;

export function withinHours(a: string | undefined, b: string | undefined, hours: number): boolean {
  const ta = Date.parse(a || "");
  const tb = Date.parse(b || "");
  // Unknown dates: be conservative and treat as close together.
  if (Number.isNaN(ta) || Number.isNaN(tb)) return true;
  return Math.abs(ta - tb) <= hours * 3600 * 1000;
}

export async function addArticle(article: StoredArticle): Promise<boolean> {
  // Strict read - if Redis is unreachable we must NOT write, or we'd
  // overwrite the whole store with just this one article.
  const articles = await redisGetStrict();

  // Remember the link either way, so a skipped duplicate isn't re-fetched
  // and re-rewritten on every cron run.
  await markLinksSeen([article.link]).catch((err) =>
    console.error("Could not record seen link:", err),
  );

  // Never store the same source URL twice.
  if (articles.some((a) => a.link === article.link)) return false;

  // Block the same news event re-reported by another outlet (or re-worded
  // by the AI) within the dedupe window.
  const matcher = new StoryMatcher([...articles, article]);
  const twin = articles.find(
    (a) =>
      withinHours(a.publishedAt, article.publishedAt, STORY_DEDUPE_WINDOW_HOURS) &&
      matcher.isSameStory(a, article),
  );
  if (twin) {
    console.log(`Skipping duplicate story: "${article.headline}" ~ "${twin.headline}"`);
    return false;
  }

  articles.unshift(article);
  await redisSet(articles.slice(0, 200));
  return true;
}

export async function getArticleById(id: string): Promise<StoredArticle | null> {
  const articles = await redisGetStrict();
  return articles.find((a) => a.id === id) ?? null;
}

// Daily post counters - both keyed by Kenyan local date.
function nairobiDateKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
}

async function redisIncr(key: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/incr/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    await fetch(`${REDIS_URL}/expire/${key}/172800`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
  } catch (err) {
    console.error(`Failed to increment ${key}:`, err);
  }
}

async function redisGetCount(key: string): Promise<number> {
  if (!REDIS_URL || !REDIS_TOKEN) return 0;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      cache: "no-store",
    });
    const data = await res.json();
    return data.result ? parseInt(data.result, 10) : 0;
  } catch {
    return 0;
  }
}

export async function getDailyPacedCount(): Promise<number> {
  return redisGetCount(`next-scene-news:daily-count:${nairobiDateKey()}`);
}

export async function incrementDailyPacedCount(): Promise<void> {
  await redisIncr(`next-scene-news:daily-count:${nairobiDateKey()}`);
}

export async function getDailyBreakingCount(): Promise<number> {
  return redisGetCount(`next-scene-news:breaking-count:${nairobiDateKey()}`);
}

export async function incrementDailyBreakingCount(): Promise<void> {
  await redisIncr(`next-scene-news:breaking-count:${nairobiDateKey()}`);
}

// Maximum number of non-breaking Facebook posts per Kenyan day.
export const DAILY_PACED_LIMIT = 15;
