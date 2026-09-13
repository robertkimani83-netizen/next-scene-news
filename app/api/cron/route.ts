import { NextRequest, NextResponse } from "next/server";
import { fetchAllFeeds, fetchArticlePage } from "@/lib/rss";
import { rewriteArticle } from "@/lib/ai";
import {
  findMatchingPhoto,
  verifyExternalCandidate,
  type MatchedPhoto,
} from "@/lib/photos";
import {
  addArticle,
  loadArticles,
  getDailyPacedCount,
  incrementDailyPacedCount,
  getDailyBreakingCount,
  incrementDailyBreakingCount,
  DAILY_PACED_LIMIT,
  type StoredArticle,
} from "@/lib/store";
import { postToFacebook } from "@/lib/social/facebook";
import { postToInstagram } from "@/lib/social/instagram";
import { postToX } from "@/lib/social/x";

// This route is the whole pipeline in one place:
// pull news -> read the real article page -> rewrite as a full original
// article -> find and verify a photo -> post to all three platforms ->
// save it to the site.
//
// Designed to run on a schedule through vercel.json.

const MAX_POSTS_PER_RUN = 3;

// DAILY_PACED_LIMIT is a daily cap shared with the Facebook-webhook
// pipeline. Normal posts are no longer hourly-paced; they may use any
// remaining part of the 15-post daily budget. Breaking posts bypass the
// cap completely.

// Vision-verifying candidate photos takes time because each candidate may
// require an image download + Gemini verification call.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");

  const providedSecret =
    auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    new URL(req.url).origin;

  const pacedPostedToday = await getDailyPacedCount();
  const breakingPostedToday = await getDailyBreakingCount();

  // Hard daily cap only. There is intentionally no hourly pacing calculation.
  const pacedSlotsLeftThisRun = Math.max(
    0,
    Math.min(
      MAX_POSTS_PER_RUN,
      DAILY_PACED_LIMIT - pacedPostedToday
    )
  );

  let remainingPacedSlots = pacedSlotsLeftThisRun;

  const existing = await loadArticles();

  const existingLinks = new Set(
    existing.map((a) => a.link)
  );

  const raw = await fetchAllFeeds();

  const candidates = raw.filter(
    (a) => !existingLinks.has(a.link)
  );

  // Shuffle the RSS candidates so the same feed does not always dominate
  // the run.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [candidates[i], candidates[j]] = [
      candidates[j],
      candidates[i],
    ];
  }

  // Prefer stories that already have a real article image.
  const withPhoto = candidates.filter(
    (a) => a.realImageUrl
  );

  const withoutPhoto = candidates.filter(
    (a) => !a.realImageUrl
  );

  const freshRaw = [
    ...withPhoto,
    ...withoutPhoto,
  ].slice(0, MAX_POSTS_PER_RUN);

  const results: Array<{
    headline: string;
    importance: string;
    postedTo: {
      facebook: boolean;
      instagram: boolean;
      x: boolean;
    };
  }> = [];

  const skippedForPacing: string[] = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    try {
      const pageData = await fetchArticlePage(
        rawArticle.link
      );

      const rewritten = await rewriteArticle(
        rawArticle,
        pageData.bodyText
      );

      const isBreaking =
        rewritten.importance === "breaking";

      // Breaking news bypasses the daily normal-post cap.
      // Normal stories use only the remaining 15/day budget.
      if (
        !isBreaking &&
        remainingPacedSlots <= 0
      ) {
        skippedForPacing.push(
          rewritten.headline
        );

        continue;
      }

      const realPhotoUrl =
        rawArticle.realImageUrl ??
        pageData.imageUrl;

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
          rewritten.headline,
          rewritten.photoSearchQueries,
          rewritten.photoNeedsCurrentEvent
        );
      }

      const id = crypto.randomUUID();

      const ownArticleUrl =
        `${siteUrl}/article/${id}`;

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
        postedTo: {
          facebook: false,
          instagram: false,
          x: false,
        },
        ...rewritten,
      };

      const socialImageUrl =
        `${siteUrl}/api/og/${id}`;

      try {
        await postToFacebook(
          socialImageUrl,
          rewritten.facebookCaption,
          ownArticleUrl
        );

        stored.postedTo.facebook = true;
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          "FB post failed:",
          e
        );

        errors.push(
          `"${stored.headline}" - Facebook: ${message}`
        );
      }

      try {
        await postToInstagram(
          socialImageUrl,
          rewritten.instagramCaption,
          ownArticleUrl
        );

        stored.postedTo.instagram = true;
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          "IG post failed:",
          e
        );

        errors.push(
          `"${stored.headline}" - Instagram: ${message}`
        );
      }

      try {
        await postToX(
          socialImageUrl,
          rewritten.xCaption,
          ownArticleUrl
        );

        stored.postedTo.x = true;
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          "X post failed:",
          e
        );

        errors.push(
          `"${stored.headline}" - X: ${message}`
        );
      }

      await addArticle(stored);

      if (isBreaking) {
        await incrementDailyBreakingCount();
      } else {
        await incrementDailyPacedCount();
        remainingPacedSlots -= 1;
      }

      results.push({
        headline: stored.headline,
        importance: rewritten.importance,
        postedTo: stored.postedTo,
      });
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : String(e);

      console.error(
        `Failed to process article "${rawArticle.title}":`,
        e
      );

      errors.push(
        `"${rawArticle.title}": ${message}`
      );
    }
  }

  const newPacedCount =
    results.filter(
      (r) => r.importance !== "breaking"
    ).length;

  const newBreakingCount =
    results.filter(
      (r) => r.importance === "breaking"
    ).length;

  return NextResponse.json({
    rawFeedItemsFound: raw.length,
    newItemsAfterDedup: freshRaw.length,
    processed: results.length,
    skippedForPacing,
    pacedPostedToday:
      pacedPostedToday + newPacedCount,
    pacedDailyLimit:
      DAILY_PACED_LIMIT,
    breakingPostedToday:
      breakingPostedToday + newBreakingCount,
    results,
    errors,
  });
}
