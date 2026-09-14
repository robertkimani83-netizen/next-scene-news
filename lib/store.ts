import type { RewrittenArticle } from "./ai";
import type { MatchedPhoto } from "./photos";

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

async function redisGet(): Promise<StoredArticle[]> {
  if (!REDIS_URL || !REDIS_TOKEN) return [];

  try {
    const res = await fetch(`${REDIS_URL}/get/${KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      cache: "no-store",
    });
    const data = await res.json();
    if (!data.result) return [];

    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? (parsed as StoredArticle[]) : [];
  } catch {
    return [];
  }
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

export async function addArticle(article: StoredArticle): Promise<void> {
  const articles = await redisGet();

  // Never store the same source URL twice.
  if (articles.some((a) => a.link === article.link)) return;

  // Also block the same news event from different RSS feeds when the
  // rewritten headlines are substantially the same. This is the important
  // cross-source duplicate protection that the old link-only check lacked.
  if (articles.some((a) => areLikelyDuplicateHeadlines(a.headline, article.headline))) {
    console.log(`Skipping duplicate story: ${article.headline}`);
    return;
  }

  articles.unshift(article);
  await redisSet(articles.slice(0, 200));
}

export async function getArticleById(id: string): Promise<StoredArticle | null> {
  const articles = await redisGet();
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
