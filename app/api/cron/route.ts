import { NextRequest, NextResponse } from "next/server";
import { fetchAllFeeds, fetchArticlePage } from "@/lib/rss";
import { rewriteArticle } from "@/lib/ai";
import { findMatchingPhoto, verifyExternalCandidate, type MatchedPhoto } from "@/lib/photos";
import { addArticle, loadArticles, type StoredArticle } from "@/lib/store";
import { postToFacebook } from "@/lib/social/facebook";
import { postToInstagram } from "@/lib/social/instagram";
import { postToTikTok } from "@/lib/social/tiktok";

// This route is the whole pipeline in one place: pull news -> read the real
// article page -> rewrite as a full original article -> find a photo ->
// post to all three platforms (linking back to OUR OWN site, not the
// original source) -> save it to the site. Designed to run on a schedule
// (see vercel.json) rather than by a person clicking a button.

const MAX_POSTS_PER_RUN = 3;

// Vision-verifying candidate photos (downloading each image + a Gemini
// call) takes real time across up to 3 articles per run - give this route
// more headroom than the default so it doesn't get cut off mid-run.
export const maxDuration = 60;

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
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const freshRaw = candidates.slice(0, MAX_POSTS_PER_RUN);
  const results = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    try {
      const pageData = await fetchArticlePage(rawArticle.link);
      const rewritten = await rewriteArticle(rawArticle, pageData.bodyText);

      // Fast path: check the source article's own photo (og:image) first,
      // through the SAME text + Gemini-vision verification as everything
      // else - a wrong/unrelated og:image (a logo, an ad banner, a
      // screenshot) no longer gets used just because it came from the
      // original article. Only search elsewhere if it doesn't pass.
      const realPhotoUrl = rawArticle.realImageUrl ?? pageData.imageUrl;
      let photo: MatchedPhoto | null = null;

      if (realPhotoUrl) {
        photo = await verifyExternalCandidate(
          realPhotoUrl,
          rawArticle.title,
          rawArticle.sourceName,
          rawArticle.link,
          rewritten.entities,
          rewritten.photoSearchTerms,
          rewritten.headline
        );
      }

      if (!photo) {
        photo = await findMatchingPhoto(
          rewritten.photoSearchTerms,
          rewritten.entities,
          rewritten.headline
        );
      }

      const id = crypto.randomUUID();
      const ownArticleUrl = `${siteUrl}/article/${id}`;

      // If no real photo was found, generate a branded poster image using
      // the article's own headline and category - this becomes the actual
      // photo (a real, postable file), not just an on-page CSS placeholder.
      // Still used for on-site display via ArticleImage.tsx.
      if (!photo.url) {
        photo = {
          ...photo,
          url: `${siteUrl}/api/og/${id}`,
          photographer: "VOX254",
          photographerUrl: siteUrl,
          credit: "VOX254",
        };
      }

      const stored: StoredArticle = {
        id,
        link: rawArticle.link,
        sourceName: rawArticle.sourceName,
        publishedAt: rawArticle.publishedAt,
        photo,
        postedTo: { facebook: false, instagram: false, tiktok: false },
        ...rewritten,
      };

      // Every post now goes through the branded card generator, whether
      // there's a real matched photo (K24-style overlay) or not (gradient
      // poster) - so posting no longer depends on whether photo.url exists.
      const socialImageUrl = `${siteUrl}/api/og/${id}`;

      try {
        await postToFacebook(socialImageUrl, rewritten.facebookCaption, ownArticleUrl);
        stored.postedTo.facebook = true;
      } catch (e) {
        console.error("FB post failed:", e);
      }

      try {
        await postToInstagram(socialImageUrl, rewritten.instagramCaption, ownArticleUrl);
        stored.postedTo.instagram = true;
      } catch (e) {
        console.error("IG post failed:", e);
      }

      try {
        await postToTikTok(socialImageUrl, rewritten.tiktokCaption, ownArticleUrl);
        stored.postedTo.tiktok = true;
      } catch (e) {
        console.error("TikTok post failed:", e);
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
