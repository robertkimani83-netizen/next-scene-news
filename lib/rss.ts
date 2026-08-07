import Parser from "rss-parser";

const parser = new Parser();

// Free, public RSS feeds from Kenyan outlets.
// Add or remove sources here any time - this list is the only thing
// you need to touch to change what the site pulls from.
export const KENYA_FEEDS = [
  { name: "The Star", url: "https://www.the-star.co.ke/rss" },
  { name: "Citizen Digital", url: "https://www.citizen.digital/rss" },
  { name: "Capital FM", url: "https://www.capitalfm.co.ke/news/feed/" },
  { name: "Kenyans.co.ke", url: "https://www.kenyans.co.ke/feed" },
];

export interface RawArticle {
  title: string;
  link: string;
  sourceName: string;
  publishedAt: string;
  contentSnippet: string;
}

export async function fetchAllFeeds(): Promise<RawArticle[]> {
  const results: RawArticle[] = [];

  for (const feed of KENYA_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items.slice(0, 8)) {
        results.push({
          title: item.title ?? "",
          link: item.link ?? "",
          sourceName: feed.name,
          publishedAt: item.pubDate ?? new Date().toISOString(),
          contentSnippet: item.contentSnippet ?? item.content ?? "",
        });
      }
    } catch (err) {
      // One dead feed shouldn't take down the whole pipeline -
      // log it and keep going with the others.
      console.error(`Failed to fetch feed ${feed.name}:`, err);
    }
  }

  return results;
}
