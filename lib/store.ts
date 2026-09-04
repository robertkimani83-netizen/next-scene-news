import type { RewrittenArticle } from "./ai";
import type { MatchedPhoto } from "./photos";

// Uses Upstash Redis's free REST API instead of a local file. Vercel's
// servers reset their filesystem on every request, so a JSON file (the
// original approach) can never actually persist - this fixes that with
// a real (and still free, no-card) database.
// Get credentials at https://console.upstash.com (Create Database -> REST API section).

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

export async function getArticleById(id: string): Promise<StoredArticle | null> {
  const articles = await redisGet();
  return articles.find((a) => a.id === id) ?? null;
}

export async function addArticle(article: StoredArticle): Promise<void> {
  const articles = await redisGet();
  if (articles.some((a) => a.link === article.link)) return; // no duplicates
  articles.unshift(article);
  await redisSet(articles.slice(0, 200)); // keep the store bounded
}

// Daily post counters - split into two independent counts, both keyed by
// Kenyan local date (not UTC, since this is a Kenyan news site and the
// day should reset at Kenyan midnight):
//
// - "paced" count: NON-breaking articles, subject to the 15/day cap AND
//   spread evenly across the day (see the pacing calculation in the cron
//   route) rather than all firing in one burst of news.
// - "breaking" count: BREAKING articles, which bypass the cap and pacing
//   entirely and always post immediately - this counter exists purely
//   for visibility in the cron response, not to enforce any limit.
function nairobiDateKey(): string {
  // en-CA gives YYYY-MM-DD directly, which is exactly the key format we want.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
}

async function redisIncr(key: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/incr/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    // Let the counter key expire on its own after 2 days so old daily
    // counters don't pile up forever - harmless to re-set this every call.
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

// Maximum number of non-breaking (paced) articles posted per day. Shared by
// every route that publishes paced posts (the RSS/rewrite cron pipeline and
// the Facebook-webhook pipeline alike) so they draw from one combined daily
// budget rather than each having their own separate cap.
export const DAILY_PACED_LIMIT = 15;

// How many paced slots should have been used by this point in the Kenyan
// day, so paced posts trickle out over the whole day instead of firing in
// one burst as soon as the daily counter resets.
export function expectedPacedSlotsByNow(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutesSinceMidnight = hour * 60 + minute;

  return Math.ceil((minutesSinceMidnight / 1440) * DAILY_PACED_LIMIT);
}
