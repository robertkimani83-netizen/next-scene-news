import { NextRequest, NextResponse } from "next/server";
import { fetchAllFeeds, fetchArticlePage } from "@/lib/rss";
import { rewriteArticle } from "@/lib/ai";
import { findMatchingPhoto, verifyExternalCandidate, type MatchedPhoto } from "@/lib/photos";
import {
  addArticle,
  loadArticles,
  getDailyPacedCount,
  incrementDailyPacedCount,
  getDailyBreakingCount,
  incrementDailyBreakingCount,
  type StoredArticle,
} from "@/lib/store";
import { postToFacebook } from "@/lib/social/facebook";
import { postToInstagram } from "@/lib/social/instagram";
import { postToX } from "@/lib/social/x";

// This route is the whole pipeline in one place: pull news -> read the real
// article page -> rewrite as a full original article -> find a photo ->
// post to all three platforms (linking back to OUR OWN site, not the
// original source) -> save it to the site. Designed to run on a schedule
// (see vercel.json) rather than by a person clicking a button.

// How many fresh candidates this run looks at and rewrites. Note this is
// NOT the same as how many actually get posted - a candidate only posts if
// it's breaking news (always allowed) or if pacing has room for it (see
// below) - most runs will rewrite up to this many but post fewer.
const MAX_POSTS_PER_RUN = 3;

// Non-breaking articles are capped at 15/day AND spread evenly across the
// full 24 hours (Kenyan local time) rather than being allowed to burst
// through the cap in one busy morning and leave nothing for the rest of
// the day. Breaking news bypasses this entirely - always posts immediately,
// any time, uncounted against this limit.
const DAILY_PACED_LIMIT = 15;

// Vision-verifying candidate photos (downloading each image + a Gemini
// call) takes real time across up to 3 articles per run - give this route
// more headroom than the default so it doesn't get cut off mid-run.
export const maxDuration = 60;

// How many of the day's 15 paced slots SHOULD have been used by this point
// in the Kenyan day, if they're spread evenly - e.g. by 12:00 noon (half
// the day gone), roughly 7-8 of the 15 should have posted. Comparing this
// against how many have actually posted today is what prevents an early
// news burst from exhausting the whole day's quota by 9am.
function expectedPacedSlotsByNow(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutesSinceMidnight = hour * 60 + minute;
  return Math.ceil((minutesSinceMidnight / 1440) * DAILY_PACED_LIMIT);
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const providedSecret = auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  const pacedPostedToday = await getDailyPacedCount();
  const breakingPostedToday = await getDailyBreakingCount();

  // How many non-breaking slots this specific run is allowed to fill,
  // based on pacing - decremented locally as this run actually uses them.
  // NOT an early-return/skip-the-whole-run condition, because breaking
  // news must still be checked and processed even when this hits zero.
  let pacedSlotsLeftThisRun = Math.max(
    0,
    Math.min(MAX_POSTS_PER_RUN, expectedPacedSlotsByNow() - pacedPostedToday, DAILY_PACED_LIMIT - pacedPostedToday)
  );

  const existing = await loadArticles();
  const existingLinks = new Set(existing.map((a) => a.link));

  const raw = await fetchAllFeeds();
  const candidates = raw.filter((a) => !existingLinks.has(a.link));
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  // Prefer articles whose RSS entry already carries a real photo - these
  // are far more likely to end up with a genuine article image instead of
  // needing (and possibly not finding) a live photo search. Still random
  // within each group (the shuffle above already ran), just biased toward
  // stories that start off with a real photo in hand.
  const withPhoto = candidates.filter((a) => a.realImageUrl);
  const withoutPhoto = candidates.filter((a) => !a.realImageUrl);
  // We don't know which of these are breaking news until after rewriting
  // them, so this run always looks at up to MAX_POSTS_PER_RUN candidates
  // regardless of how many paced slots are left - a breaking story must
  // never go unnoticed just because the day's non-breaking quota is spent.
  const freshRaw = [...withPhoto, ...withoutPhoto].slice(0, MAX_POSTS_PER_RUN);
  const results = [];
  const skippedForPacing: string[] = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    try {
      const pageData = await fetchArticlePage(rawArticle.link);
      const rewritten = await rewriteArticle(rawArticle, pageData.bodyText);

      const isBreaking = rewritten.importance === "breaking";

      if (!isBreaking && pacedSlotsLeftThisRun <= 0) {
        // Not breaking, and today's pace doesn't allow another one yet -
        // skip WITHOUT storing it, so it's picked back up and reconsidered
        // on a later run once pacing (or a fresh day) allows it.
        skippedForPacing.push(rewritten.headline);
        continue;
      }

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
        postedTo: { facebook: false, instagram: false, x: false },
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
        const message = e instanceof Error ? e.message : String(e);
        console.error("FB post failed:", e);
        errors.push(`"${stored.headline}" - Facebook: ${message}`);
      }

      try {
        await postToInstagram(socialImageUrl, rewritten.instagramCaption, ownArticleUrl);
        stored.postedTo.instagram = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("IG post failed:", e);
        errors.push(`"${stored.headline}" - Instagram: ${message}`);
      }

      try {
        await postToX(socialImageUrl, rewritten.xCaption, ownArticleUrl);
        stored.postedTo.x = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("X post failed:", e);
        errors.push(`"${stored.headline}" - X: ${message}`);
      }

      await addArticle(stored);
      if (isBreaking) {
        await incrementDailyBreakingCount();
      } else {
        await incrementDailyPacedCount();
        pacedSlotsLeftThisRun -= 1;
      }
      results.push({
        headline: stored.headline,
        importance: rewritten.importance,
        postedTo: stored.postedTo,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Failed to process article "${rawArticle.title}":`, e);
      errors.push(`"${rawArticle.title}": ${message}`);
    }
  }

  const newPacedCount = results.filter((r) => r.importance !== "breaking").length;
  const newBreakingCount = results.filter((r) => r.importance === "breaking").length;

  return NextResponse.json({
    rawFeedItemsFound: raw.length,
    newItemsAfterDedup: freshRaw.length,
    processed: results.length,
    skippedForPacing,
    pacedPostedToday: pacedPostedToday + newPacedCount,
    pacedDailyLimit: DAILY_PACED_LIMIT,
    breakingPostedToday: breakingPostedToday + newBreakingCount,
    results,
    errors,
  });
}
