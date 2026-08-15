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
  if (item.mediaContent && Array.isArray(item.mediaContent)) {
    for (const media of item.mediaContent) {
      const url = media?.$?.url;
      if (url && isImageUrl(url)) return url;
    }
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

export interface RawJob {
  title: string;
  link: string;
  sourceName: string;
  publishedAt: string;
  description: string;
}

export async function fetchAllJobs(): Promise<RawJob[]> {
  const results: RawJob[] = [];

  // Local Kenyan jobs from MyJobMag
  try {
    const feed = JOB_FEEDS.find((f) => f.name === "MyJobMag Kenya")!;
    const parsed = await parser.parseURL(feed.url);
    for (const item of parsed.items.slice(0, 10)) {
      results.push({
        title: item.title ?? "",
        link: item.link ?? "",
        sourceName: feed.name,
        publishedAt: item.pubDate ?? new Date().toISOString(),
        description: item.contentSnippet ?? item.content ?? "",
      });
    }
  } catch (err) {
    console.error("Failed to fetch MyJobMag:", err);
  }

  // International remote jobs from Remotive (worldwide, no visa needed)
  try {
    const res = await fetch("https://remotive.com/api/remote-jobs", {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    for (const job of (data.jobs ?? []).slice(0, 10)) {
      results.push({
        title: `${job.title} at ${job.company_name}`,
        link: job.url,
        sourceName: "Remotive (Remote/Worldwide)",
        publishedAt: job.publication_date ?? new Date().toISOString(),
        description: (job.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      });
    }
  } catch (err) {
    console.error("Failed to fetch Remotive:", err);
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

// AllAfrica (and similar aggregators) syndicate other outlets' reporting and
// link back to the real publisher with "Read the original article on X" -
// but their own og:image is always just their own logo, never a real photo.
// Verified directly against a live AllAfrica page: every article's og:image
// is https://cdn.allafrica.com/static/images/structure/aa-logo-*.png,
// regardless of story. So a real photo, when one exists, is one hop away on
// the original publisher's own page - not on AllAfrica's wrapper page.
const ALLAFRICA_LOGO_PATTERN = /cdn\.allafrica\.com\/static\/images\/structure\/aa-logo/i;

function extractOriginalSourceUrl(html: string): string | null {
  const match = html.match(
    /<a[^>]+href=["']([^"']+)["'][^>]*>(?:(?!<\/a>)[\s\S])*?original article(?:(?!<\/a>)[\s\S])*?<\/a>/i
  );
  return match ? match[1] : null;
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

    let imageUrl = imageMatch ? imageMatch[1] : null;

    // If there's no image, or it's just AllAfrica's own logo, follow the
    // "read original article on X" link to the real publisher's page and
    // use its photo instead. Only fires when actually needed, so feeds
    // that already provide a real image are unaffected.
    if (!imageUrl || ALLAFRICA_LOGO_PATTERN.test(imageUrl)) {
      const originalUrl = extractOriginalSourceUrl(html);
      if (originalUrl) {
        try {
          const originalRes = await fetch(originalUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml",
              "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(8000),
          });
          if (originalRes.ok) {
            const originalHtml = await originalRes.text();
            const originalImageMatch =
              originalHtml.match(
                /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
              ) ??
              originalHtml.match(
                /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
              );
            if (originalImageMatch) {
              imageUrl = originalImageMatch[1];
            }
          }
        } catch (err) {
          // Original publisher's page unreachable - not fatal, we just
          // fall through to the normal live photo search like before.
          console.error("Original-source image fetch failed:", err);
        }
      }
    }

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

    return { imageUrl, bodyText };
  } catch {
    return { imageUrl: null, bodyText: "" };
  }
}
