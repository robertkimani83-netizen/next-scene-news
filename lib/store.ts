import fs from "fs";
import path from "path";
import type { RewrittenArticle } from "./ai";
import type { MatchedPhoto } from "./photos";

export interface StoredArticle extends RewrittenArticle {
  id: string;
  link: string;
  sourceName: string;
  publishedAt: string;
  photo: MatchedPhoto | null;
  postedTo: { facebook: boolean; instagram: boolean; tiktok: boolean };
}

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");

export function loadArticles(): StoredArticle[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

export function saveArticles(articles: StoredArticle[]) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(articles, null, 2));
}

export function addArticle(article: StoredArticle) {
  const articles = loadArticles();
  if (articles.some((a) => a.link === article.link)) return; // no duplicates
  articles.unshift(article);
  saveArticles(articles.slice(0, 200)); // keep the store bounded
}

// NOTE: a flat JSON file works for a personal project on Vercel's free tier,
// but Vercel's filesystem resets on every deploy and isn't shared across
// serverless function instances. For anything beyond testing, swap this
// file for a free-tier database (Vercel KV, Supabase, or Turso all have
// free tiers) - the rest of the code doesn't need to change, just these
// two functions.
