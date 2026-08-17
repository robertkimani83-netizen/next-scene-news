import type { MetadataRoute } from "next";
import { loadArticles } from "@/lib/store";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://next-scene-news-897q.vercel.app";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "hourly",
      priority: 1,
    },
    {
      url: `${BASE_URL}/about`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/contact`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/jobs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.5,
    },
  ];

  const articles = await loadArticles();

  const articlePages: MetadataRoute.Sitemap = articles.map((article) => ({
    url: `${BASE_URL}/article/${article.id}`,
    lastModified: new Date(article.publishedAt),
    changeFrequency: "daily",
    priority: 0.8,
  }));

  return [...staticPages, ...articlePages];
}
