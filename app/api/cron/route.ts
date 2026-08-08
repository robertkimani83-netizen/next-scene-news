import { NextRequest, NextResponse } from "next/server";
import { fetchAllFeeds } from "@/lib/rss";
import { rewriteArticle } from "@/lib/ai";
import { findMatchingPhoto } from "@/lib/photos";
import { addArticle, loadArticles, type StoredArticle } from "@/lib/store";
import { postToFacebook } from "@/lib/social/facebook";
import { postToInstagram } from "@/lib/social/instagram";
import { postToTikTok } from "@/lib/social/tiktok";

// This route is the whole pipeline in one place: pull news -> rewrite ->
// find a photo -> post to all three platforms -> save it to the site.
// It's designed to be hit on a schedule (see vercel.json for the cron
// config) rather than by a person clicking a button.

// How many NEW stories to post per run. Keep this low (2-3) so you don't
// blow through free-tier posting limits or spam your followers.
const MAX_POSTS_PER_RUN = 3;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const providedSecret = auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await loadArticles();
  const existingLinks = new Set(existing.map((a) => a.link));

  const raw = await fetchAllFeeds();
  const freshRaw = raw.filter((a) => !existingLinks.has(a.link)).slice(0, MAX_POSTS_PER_RUN);

  const results = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    try {
      const rewritten = await rewriteArticle(rawArticle);

      // Use the publisher's own photo when the feed provided one;
      // only fall back to a matched stock photo when it didn't.
      const photo = rawArticle.realImageUrl
        ? {
            url: rawArticle.realImageUrl,
            photographer: rawArticle.sourceName,
            photographerUrl: rawArticle.link,
          }
        : await findMatchingPhoto(rewritten.photoSearchTerms);

      const stored: StoredArticle = {
        id: crypto.randomUUID(),
        link: rawArticle.link,
        sourceName: rawArticle.sourceName,
        publishedAt: rawArticle.publishedAt,
        photo,
        postedTo: { facebook: false, instagram: false, tiktok: false },
        ...rewritten,
      };

      // Only attempt social posts if we found a photo - all three
      // platforms need an image for this format.
      if (photo) {
        try {
          await postToFacebook(photo.url, rewritten.facebookCaption, rawArticle.link);
          stored.postedTo.facebook = true;
        } catch (e) {
          console.error("FB post failed:", e);
        }

        try {
          await postToInstagram(photo.url, rewritten.instagramCaption, rawArticle.link);
          stored.postedTo.instagram = true;
        } catch (e) {
          console.error("IG post failed:", e);
        }

        try {
          await postToTikTok(photo.url, rewritten.tiktokCaption, rawArticle.link);
          stored.postedTo.tiktok = true;
        } catch (e) {
          console.error("TikTok post failed:", e);
        }
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
