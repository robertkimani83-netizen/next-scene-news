import { NextRequest, NextResponse } from "next/server";
import { fetchAllFeeds, fetchArticlePage } from "@/lib/rss";
import { rewriteArticle } from "@/lib/ai";
import { findMatchingPhoto, scoreExternalCandidate, type MatchedPhoto } from "@/lib/photos";
import { addArticle, loadArticles, type StoredArticle } from "@/lib/store";
import { postToFacebook } from "@/lib/social/facebook";
import { postToInstagram } from "@/lib/social/instagram";
import { postToTikTok } from "@/lib/social/tiktok";

// This route is the whole pipeline in one place: pull news -> read the real
// article page -> rewrite as a full original article -> find a photo ->
// post to all three platforms (linking back to OUR OWN site, not the
// original source) -> save it to the site. Designed to run on a schedule
// (see vercel.json) rather than by a person clicking a button.

// How many NEW stories to process per run. Keep this low (2-3) so you don't
// blow through free-tier posting limits, spam your followers, or take too
// long fetching full article pages within one request.
const MAX_POSTS_PER_RUN = 3;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const providedSecret = auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  const existing = await loadArticles();
  const existingLinks = new Set(existing.map((a) => a.link));

  const raw = await fetchAllFeeds();
  const candidates = raw.filter((a) => !existingLinks.has(a.link));
  // Shuffle so we don't always favor whichever source happens to list
  // its articles first - gives every connected source a fair chance
  // each run instead of one feed dominating every batch.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const freshRaw = candidates.slice(0, MAX_POSTS_PER_RUN);
  const results = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    try {
      // One fetch of the article's own page gives us both real article
      // text (for a genuinely fuller AI rewrite) and a candidate photo.
      const pageData = await fetchArticlePage(rawArticle.link);

      const rewritten = await rewriteArticle(rawArticle, pageData.bodyText);

      // Search free sources using the article's extracted entities - always
      // runs, never skipped just because an og:image exists.
      const searchedPhoto = await findMatchingPhoto(
        rewritten.photoSearchTerms,
        rewritten.entities
      );

      // The article's own og:image (or feed-embedded image) is treated as
      // just another candidate now, scored the same way, instead of being
      // trusted automatically. This is what stops a wrong logo/crest image
      // from winning just because it happened to be the page's preview image.
      const realPhotoUrl = rawArticle.realImageUrl ?? pageData.imageUrl;
      let photo: MatchedPhoto = searchedPhoto;

      if (realPhotoUrl) {
        const externalPhoto = scoreExternalCandidate(
          realPhotoUrl,
          rawArticle.title,
          rawArticle.sourceName,
          rawArticle.link,
          rewritten.entities,
          rewritten.photoSearchTerms
        );
        if (externalPhoto.relevanceScore > searchedPhoto.relevanceScore) {
          photo = externalPhoto;
        }
      }

      const id = crypto.randomUUID();
      const ownArticleUrl = `${siteUrl}/article/${id}`;

      const stored: StoredArticle = {
        id,
        link: rawArticle.link,
        sourceName: rawArticle.sourceName,
        publishedAt: rawArticle.publishedAt,
        photo,
        postedTo: { facebook: false, instagram: false, tiktok: false },
        ...rewritten,
      };

      // Social posts link back to OUR OWN article page, not the original
      // source - this is what keeps readers on VOX254. Only attempt this
      // when we actually have a real, hosted image URL to hand to each
      // platform's API - the branded VOX254 placeholder (used when every
      // source came up empty) is a website-only visual, not a real file,
      // so there's nothing to post in that case.
      if (photo.url) {
        try {
          await postToFacebook(photo.url, rewritten.facebookCaption, ownArticleUrl);
          stored.postedTo.facebook = true;
        } catch (e) {
          console.error("FB post failed:", e);
        }

        try {
          await postToInstagram(photo.url, rewritten.instagramCaption, ownArticleUrl);
          stored.postedTo.instagram = true;
        } catch (e) {
          console.error("IG post failed:", e);
        }

        try {
          await postToTikTok(photo.url, rewritten.tiktokCaption, ownArticleUrl);
          stored.postedTo.tiktok = true;
        } catch (e) {
          console.error("TikTok post failed:", e);
        }
      } else {
        console.log(
          `No usable photo found for "${rawArticle.title}" - skipping social posts, article still saved to site.`
        );
      }

      await addArticle(stored);
      results.push({ headline: stored.headline, postedTo: stored.postedTo });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Failed to process article "${rawArticle.title}":`, e);
      errors.push(`"${rawArticle.title}": ${message}`);
    }
  }

  return NextResponse.json({
    rawFeedItemsFound: raw.length,
    newItemsAfterDedup: freshRaw.length,
    processed: results.length,
    results,
    errors,
  });
}
