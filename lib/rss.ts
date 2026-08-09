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
  { name: "Nation Africa", url: "https://nation.africa/kenya/rss.xml" },
  { name: "Nairobi Wire", url: "https://nairobiwire.com/feed" },
  { name: "Kenya News Agency", url: "https://www.kenyanews.go.ke/feed" },
];
export const JOB_FEEDS = [
  { name: "ReliefWeb Kenya", url: "https://reliefweb.int/jobs/rss.xml?country=131" },
  { name: "MyJobMag Kenya", url: "https://www.myjobmag.co.ke/jobsxml_by_categories.xml" },
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

// Many RSS feeds (especially WordPress-based ones) strip out images and only
// give a one-sentence teaser, not real article text. But nearly every news
// site still has the full picture and article body sitting in its own page -
// this fetches that page once and pulls both out, giving the AI real facts
// to write from instead of a thin snippet, and a real photo instead of stock.
export interface ArticlePageData {
  imageUrl: string | null;
  bodyText: string;
}

export async function fetchArticlePage(articleUrl: string): Promise<ArticlePageData> {
  try {
    const res = await fetch(articleUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { imageUrl: null, bodyText: "" };

    const html = await res.text();

    const imageMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    // Try to isolate the real article body first, so we don't dilute
    // the extracted text with nav menus, cookie banners, and related-article
    // links. Falls back to the whole page if no known container is found.
    const containerPatterns = [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]+class=["'][^"']*(entry-content|article-body|article-content|post-content|story-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ];

    let contentHtml = html;
    for (const pattern of containerPatterns) {
      const match = html.match(pattern);
      if (match) {
        contentHtml = match[0];
        break;
      }
    }

    const bodyText = contentHtml
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);

    return { imageUrl: imageMatch ? imageMatch[1] : null, bodyText };
  } catch {
    return { imageUrl: null, bodyText: "" };
  }
}
