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
