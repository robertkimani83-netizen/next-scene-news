import Parser from "rss-parser";

// Custom fields so we can pull an image out of whichever format each feed
// happens to use - WordPress feeds usually use <enclosure>, others use the
// Media RSS namespace (<media:content>, <media:thumbnail>).
const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
  timeout: 10000,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
    ],
  },
});

// Free, public RSS feeds from Kenyan outlets.
// Add or remove sources here any time - this list is the only thing
// you need to touch to change what the site pulls from.
export const KENYA_FEEDS = [
  { name: "Kenyans.co.ke", url: "https://www.kenyans.co.ke/feeds/news" },
  { name: "AllAfrica Kenya", url: "https://allafrica.com/tools/headlines/rdf/kenya/headlines.rdf" },
];

export interface RawArticle {
  title: string;
  link: string;
  sourceName: string;
  publishedAt: string;
  contentSnippet: string;
  // The publisher's own photo for this story, when the feed provides one.
  // Null means no real photo was found - the pipeline falls back to a
  // matched stock photo in that case.
  realImageUrl: string | null;
}

function extractImageUrl(item: any): string | null {
  // 1. Standard RSS <enclosure> (most common on WordPress-based sites)
  if (item.enclosure?.url && isImageUrl(item.enclosure.url)) {
    return item.enclosure.url;
  }

  // 2. Media RSS <media:content>
  if (Array.isArray(item.mediaContent)) {
    const withImage = item.mediaContent.find((m: any) => m?.$?.url);
    if (withImage) return withImage.$.url;
  }

  // 3. Media RSS <media:thumbnail>
  if (item.mediaThumbnail?.$?.url) {
    return item.mediaThumbnail.$.url;
  }

  // 4. First <img> tag inside the article's own HTML content, if included
  const html: string | undefined = item["content:encoded"] ?? item.content;
  if (html) {
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];
  }

  return null;
}

function isImageUrl(url: string): boolean {
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
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
          realImageUrl: extractImageUrl(item),
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
